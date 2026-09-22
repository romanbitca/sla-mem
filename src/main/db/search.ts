import type {
  ConversationType,
  SearchHas,
  SearchHit,
  SearchParams,
  SearchResponse,
  SearchSort,
} from '../../shared/types';
import { desegmentCjk, segmentCjk } from './cjk';
import { hydrateMessages } from './dto';
import { getMeta } from './meta';
import { inList, stmt } from './stmt';
import type { DB } from './types';

// =============================================================================================
// Resolvers
// =============================================================================================

export interface SearchUser {
  id: string;
  name: string | null;
  realName: string | null;
  displayName: string | null;
  /** For app/bot users: the bot id their messages may carry instead of a user id. */
  botId?: string | null;
}

/** An integration that posts with a bot_id (and maybe no user id). */
export interface SearchBot {
  id: string;
  name: string | null;
  /** The app's bot user, when messages carried both. */
  userId: string | null;
}

export interface SearchConversation {
  id: string;
  type: ConversationType;
  name: string | null;
  dmUserId: string | null;
}

/** How modifiers find ids. Pure data-backed implementation: `createSearchResolvers`. */
export interface SearchResolvers {
  /**
   * User ids for `from:x` / `in:@x`: id, handle, display name or real name. `me` is always the
   * archive's own user, never someone whose name starts with "me" (pitfall 10).
   */
  resolveUsers(token: string): string[];
  /** Bot ids for `from:x`: bots named x, plus the bot ids of the matched users (pitfall 11). */
  resolveBots(token: string, userIds: string[]): string[];
  /** Bot ids that belong to these users (so an explicit author filter also finds their app posts). */
  botsOfUsers(userIds: string[]): string[];
  /** Conversation ids for `in:#x` / `in:x`: conversation name or id. */
  resolveConversations(token: string): string[];
  /** IM conversation ids with any of these users. */
  dmConversations(userIds: string[]): string[];
  /** Clock for `today`/`yesterday` date keywords. */
  now?: () => Date;
}

/**
 * Case-insensitive; exact matches (on id or any name key) win over prefix matches, so `from:ann`
 * finds "Ann" even when "Anna" exists, but still finds "Annabel" when no "Ann" does.
 */
function matchIds<T extends { id: string }>(items: T[], keys: (t: T) => (string | null)[], token: string): string[] {
  const q = token.trim().toLowerCase();
  if (!q) return [];
  const exact = items.filter((t) => t.id.toLowerCase() === q || keys(t).some((k) => k?.toLowerCase() === q));
  if (exact.length) return exact.map((t) => t.id);
  return items.filter((t) => keys(t).some((k) => k != null && k.toLowerCase().startsWith(q))).map((t) => t.id);
}

export function createSearchResolvers(data: {
  users: SearchUser[];
  conversations: SearchConversation[];
  bots?: SearchBot[];
  selfUserId: string | null;
  now?: () => Date;
}): SearchResolvers {
  const { users, conversations, selfUserId } = data;
  const bots = data.bots ?? [];
  const named = conversations.filter((c) => c.type !== 'im');
  const botsOfUsers = (userIds: string[]): string[] => {
    const wanted = new Set(userIds);
    const fromUsers = users.filter((u) => wanted.has(u.id) && u.botId).map((u) => u.botId as string);
    const fromBots = bots.filter((b) => b.userId && wanted.has(b.userId)).map((b) => b.id);
    return unique([...fromUsers, ...fromBots]);
  };
  return {
    resolveUsers(token) {
      if (token.trim().toLowerCase() === 'me') return selfUserId ? [selfUserId] : [];
      return matchIds(users, (u) => [u.name, u.displayName, u.realName], token);
    },
    resolveBots(token, userIds) {
      if (token.trim().toLowerCase() === 'me') return [];
      return unique([...matchIds(bots, (b) => [b.name], token), ...botsOfUsers(userIds)]);
    },
    botsOfUsers,
    resolveConversations(token) {
      const q = token.toLowerCase();
      const byId = conversations.filter((c) => c.id.toLowerCase() === q).map((c) => c.id);
      return byId.length ? byId : matchIds(named, (c) => [c.name], token);
    },
    dmConversations(userIds) {
      const wanted = new Set(userIds);
      return conversations.filter((c) => c.type === 'im' && c.dmUserId && wanted.has(c.dmUserId)).map((c) => c.id);
    },
    now: data.now,
  };
}

export function loadSearchResolvers(db: DB, now?: () => Date): SearchResolvers {
  const users = stmt<SearchUser>(
    db,
    `SELECT id, name, real_name AS realName, display_name AS displayName,
       CASE WHEN is_bot = 1 THEN json_extract(raw, '$.profile.bot_id') END AS botId
     FROM users`,
  ).all();
  const bots = stmt<SearchBot>(db, 'SELECT id, name, user_id AS userId FROM bots').all();
  const conversations = stmt<SearchConversation>(
    db,
    'SELECT id, type, name, dm_user_id AS dmUserId FROM conversations',
  ).all();
  return createSearchResolvers({ users, conversations, bots, selfUserId: getMeta(db, 'self_user_id'), now });
}

// =============================================================================================
// Parser
// =============================================================================================

export interface ParsedSearchQuery {
  /** Free-text part, normalized for display/highlighting (modifiers removed). */
  text: string;
  /** Bare words (prefix-matched). */
  terms: string[];
  /** Quoted phrases (exact). */
  phrases: string[];
  /** `-word` exclusions (prefix-matched, like terms: pitfall 13). */
  excluded: string[];
  /** `-"phrase"` exclusions (exact, like phrases). */
  excludedPhrases: string[];
  userIds: string[];
  /** Bot ids matched by `from:` (bot messages may carry no user id). */
  botIds: string[];
  conversationIds: string[];
  /** Inclusive, YYYY-MM-DD local time. */
  after: string | null;
  /** Exclusive, YYYY-MM-DD local time. */
  before: string | null;
  has: SearchHas[];
  /** `is:thread`: thread parents with replies, and replies. */
  isThread: boolean;
  unresolved: string[];
}

interface Token {
  negated: boolean;
  key: string | null;
  value: string;
  quoted: boolean;
  raw: string;
}

const MODIFIER_KEYS = new Set(['from', 'in', 'before', 'after', 'on', 'during', 'has', 'is']);
const HAS_VALUES: readonly SearchHas[] = ['file', 'link', 'reaction', 'thread', 'image'];
const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/**
 * Splits a query into words, `"phrases"` (an unbalanced quote runs to the end), `-exclusions` and
 * `key:value` / `key:"quoted value"` modifiers. Unknown `x:y` words stay plain words.
 */
export function tokenizeSearchQuery(q: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < q.length) {
    while (isSpace(q[i])) i++;
    if (i >= q.length) break;
    const start = i;
    const negated = q[i] === '-' && i + 1 < q.length && !isSpace(q[i + 1]);
    if (negated) i++;
    if (q[i] === '"') {
      const { value, end } = readQuoted(q, i);
      i = end;
      tokens.push({ negated, key: null, value, quoted: true, raw: q.slice(start, i) });
      continue;
    }
    let j = i;
    let quotedKey: string | null = null;
    while (j < q.length && !isSpace(q[j])) {
      if (q[j] === ':' && q[j + 1] === '"' && MODIFIER_KEYS.has(q.slice(i, j).toLowerCase())) {
        quotedKey = q.slice(i, j).toLowerCase();
        break;
      }
      j++;
    }
    if (quotedKey) {
      const { value, end } = readQuoted(q, j + 1);
      i = end;
      tokens.push({ negated, key: quotedKey, value, quoted: true, raw: q.slice(start, i) });
      continue;
    }
    const word = q.slice(i, j);
    i = j;
    const colon = word.indexOf(':');
    const key = colon > 0 ? word.slice(0, colon).toLowerCase() : null;
    tokens.push(
      key && MODIFIER_KEYS.has(key)
        ? { negated, key, value: word.slice(colon + 1), quoted: false, raw: q.slice(start, i) }
        : { negated, key: null, value: word, quoted: false, raw: q.slice(start, i) },
    );
  }
  return tokens;
}

/** Reads `"…"` starting at the opening quote; returns its content and the index after it. */
function readQuoted(q: string, openIndex: number): { value: string; end: number } {
  const close = q.indexOf('"', openIndex + 1);
  if (close === -1) return { value: q.slice(openIndex + 1), end: q.length };
  return { value: q.slice(openIndex + 1, close), end: close + 1 };
}

/** Whether the FTS tokenizer would produce any token from `s` (letters, numbers, private use). */
export function isSearchable(s: string): boolean {
  return /[\p{L}\p{N}\p{Co}]/u.test(s);
}

export function parseSearchQuery(q: string, resolvers: SearchResolvers): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = {
    text: '',
    terms: [],
    phrases: [],
    excluded: [],
    excludedPhrases: [],
    userIds: [],
    botIds: [],
    conversationIds: [],
    after: null,
    before: null,
    has: [],
    isThread: false,
    unresolved: [],
  };
  const textParts: string[] = [];
  // Control characters can't be typed meaningfully and once crashed FTS5 (pitfall 12).
  for (const token of tokenizeSearchQuery(stripControlChars(q))) {
    if (token.key) {
      // Negated modifiers (-in:#x) aren't supported; surfacing them beats silently ignoring them.
      if (token.negated || !applyModifier(parsed, token, resolvers)) parsed.unresolved.push(token.raw);
      continue;
    }
    if (!isSearchable(token.value)) continue;
    const display = token.quoted ? `"${token.value}"` : token.value;
    if (token.negated) (token.quoted ? parsed.excludedPhrases : parsed.excluded).push(token.value);
    else if (token.quoted) parsed.phrases.push(token.value);
    else parsed.terms.push(token.value);
    textParts.push(token.negated ? `-${display}` : display);
  }
  parsed.text = textParts.join(' ');
  parsed.userIds = unique(parsed.userIds);
  parsed.botIds = unique(parsed.botIds);
  parsed.conversationIds = unique(parsed.conversationIds);
  parsed.has = unique(parsed.has);
  return parsed;
}

/** Returns false when the modifier can't be resolved. */
function applyModifier(parsed: ParsedSearchQuery, token: Token, r: SearchResolvers): boolean {
  const value = token.value.trim();
  if (!value) return false;
  switch (token.key) {
    case 'from': {
      const name = stripPrefix(value, '@');
      const users = r.resolveUsers(name);
      const bots = r.resolveBots(name, users);
      parsed.userIds.push(...users);
      parsed.botIds.push(...bots);
      return users.length + bots.length > 0;
    }
    case 'in':
      return pushAll(parsed.conversationIds, resolveIn(value, r));
    case 'has': {
      const has = normalizeHas(value);
      return has ? pushAll(parsed.has, [has]) : false;
    }
    case 'is':
      if (value.toLowerCase() !== 'thread') return false;
      parsed.isThread = true;
      return true;
    default:
      return applyDateModifier(parsed, token.key ?? '', value, r.now?.() ?? new Date());
  }
}

function resolveIn(value: string, r: SearchResolvers): string[] {
  if (value.startsWith('@')) return r.dmConversations(r.resolveUsers(value.slice(1)));
  if (value.startsWith('#')) return r.resolveConversations(value.slice(1));
  const conversations = r.resolveConversations(value);
  return conversations.length ? conversations : r.dmConversations(r.resolveUsers(value));
}

function normalizeHas(value: string): SearchHas | null {
  const v = value.toLowerCase().replace(/s$/, '');
  return (HAS_VALUES as readonly string[]).includes(v) ? (v as SearchHas) : null;
}

function applyDateModifier(parsed: ParsedSearchQuery, key: string, value: string, now: Date): boolean {
  if (key === 'during') {
    const range = parseDuring(value, now);
    if (!range) return false;
    narrowDates(parsed, range.after, range.before);
    return true;
  }
  const day = parseDay(value, now);
  if (!day) return false;
  if (key === 'after') narrowDates(parsed, day, null);
  else if (key === 'before') narrowDates(parsed, null, day);
  else narrowDates(parsed, day, addDays(day, 1)); // on:
  return true;
}

function narrowDates(
  target: { after: string | null; before: string | null },
  after: string | null,
  before: string | null,
) {
  if (after && (!target.after || after > target.after)) target.after = after;
  if (before && (!target.before || before < target.before)) target.before = before;
}

export function stripControlChars(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function stripPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function pushAll<T>(target: T[], values: T[]): boolean {
  target.push(...values);
  return values.length > 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// =============================================================================================
// Dates (calendar days, interpreted in the server's local timezone only when querying)
// =============================================================================================

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatDay(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function localDay(date: Date): string {
  return formatDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** Validates YYYY-MM-DD (single-digit month/day tolerated) or today/yesterday. */
export function parseDay(value: string, now: Date = new Date()): string | null {
  const v = value.toLowerCase();
  if (v === 'today') return localDay(now);
  if (v === 'yesterday') return addDays(localDay(now), -1);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return formatDay(y, mo, d);
}

function parseDuring(value: string, now: Date): { after: string; before: string } | null {
  const month = /^(\d{4})-(\d{1,2})$/.exec(value);
  if (month) {
    const [y, m] = [Number(month[1]), Number(month[2])];
    if (m < 1 || m > 12) return null;
    return { after: formatDay(y, m, 1), before: m === 12 ? formatDay(y + 1, 1, 1) : formatDay(y, m + 1, 1) };
  }
  if (/^\d{4}$/.test(value)) {
    const y = Number(value);
    return { after: formatDay(y, 1, 1), before: formatDay(y + 1, 1, 1) };
  }
  const day = parseDay(value, now);
  return day ? { after: day, before: addDays(day, 1) } : null;
}

/** Calendar arithmetic on the date string itself (UTC math avoids DST-length days). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return formatDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Unix seconds of local midnight starting `day`. */
export function localDayStartSeconds(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

// =============================================================================================
// FTS expression
// =============================================================================================

/**
 * An FTS5 string literal: the only special character inside one is `"`, escaped by doubling.
 * Control characters become spaces: FTS5 reads the expression as a C string, so an embedded NUL
 * would end it mid-literal ("unterminated string"), and the tokenizer treats them as separators
 * anyway.
 */
export function ftsLiteral(s: string): string {
  return `"${s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/"/g, '""')}"`;
}

/**
 * Builds the FTS5 MATCH expression from parsed parts. User text only ever appears inside string
 * literals, so operators (OR, NEAR, *, ^, column filters) typed by the user are inert.
 * Returns `positive: null` when there is nothing to match (filter-only / exclusion-only query).
 */
export function buildMatchExpression(
  p: Pick<ParsedSearchQuery, 'terms' | 'phrases' | 'excluded'> & { excludedPhrases?: string[] },
): {
  positive: string | null;
  negative: string | null;
} {
  const positives = [
    ...p.terms.filter(isSearchable).map((t) => `${ftsLiteral(segmentCjk(t))}*`),
    ...p.phrases.filter(isSearchable).map((t) => ftsLiteral(segmentCjk(t))),
  ];
  // Same semantics as inclusions: `-stag` excludes "staging" the way `stag` would find it.
  const negatives = [
    ...p.excluded.filter(isSearchable).map((t) => `${ftsLiteral(segmentCjk(t))}*`),
    ...(p.excludedPhrases ?? []).filter(isSearchable).map((t) => ftsLiteral(segmentCjk(t))),
  ];
  const negative = negatives.length ? negatives.join(' OR ') : null;
  if (!positives.length) return { positive: null, negative };
  const all = positives.join(' AND ');
  return { positive: negative ? `(${all}) NOT (${negative})` : all, negative };
}

// =============================================================================================
// Executor
// =============================================================================================

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const LEAD_SNIPPET_CHARS = 200;

interface Filters {
  conversationIds: string[];
  userIds: string[];
  botIds: string[];
  after: string | null;
  before: string | null;
  has: SearchHas[];
  isThread: boolean;
}

// Each condition matches a partial index's WHERE clause in schema.ts (messages_has_*).
const HAS_SQL: Record<SearchHas, string> = {
  file: 'm.has_files = 1',
  link: 'm.has_links = 1',
  reaction: "m.reactions <> '[]'",
  thread: 'm.reply_count > 0',
  image: 'm.has_images = 1',
};

/**
 * Limits a search can't widen (Ask AI's "In", "From" and "Date" choices): unlike the explicit
 * filters, which add to what `q` names, these narrow it. Asking for a conversation or person
 * outside them finds nothing.
 */
export interface SearchWithin {
  conversationIds?: readonly string[];
  userIds?: readonly string[];
  /** Inclusive, YYYY-MM-DD local time. */
  after?: string | null;
  /** Exclusive, YYYY-MM-DD local time. */
  before?: string | null;
}

export function search(db: DB, params: SearchParams, opts: { now?: Date; within?: SearchWithin } = {}): SearchResponse {
  const started = performance.now();
  const now = opts.now ?? new Date();
  const resolvers = loadSearchResolvers(db, () => now);
  const parsed = parseSearchQuery(params.q ?? '', resolvers);
  const filters = mergeFilters(parsed, params, resolvers);
  const outside = opts.within ? !narrowWithin(filters, opts.within, resolvers) : false;
  const response = (total: number, hits: SearchHit[]): SearchResponse => ({
    total,
    hits,
    parsed: {
      text: parsed.text,
      conversationIds: filters.conversationIds,
      userIds: filters.userIds,
      after: filters.after,
      before: filters.before,
      has: filters.has,
      unresolved: parsed.unresolved,
    },
    tookMs: Math.round((performance.now() - started) * 10) / 10,
  });

  if (parsed.unresolved.length || outside) return response(0, []);
  const match = buildMatchExpression(parsed);
  const where = filterClauses(filters, match);
  if (!match.positive && !where.sql.length) return response(0, []); // nothing asked for

  const limit = clamp(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clamp(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const sort: SearchSort = params.sort && params.sort in FTS_ORDER ? params.sort : 'relevance';
  const result = match.positive
    ? ftsSearch(db, { expr: match.positive, where, range: rowidRange(filters), sort, limit, offset, now })
    : listingSearch(db, where, sort, limit, offset);
  const messages = hydrateMessages(db, result.ids);
  const hits = messages.map((message, i) => ({ message, snippet: result.snippets[i] ?? '' }));
  return response(result.total, hits);
}

function mergeFilters(parsed: ParsedSearchQuery, params: SearchParams, r: SearchResolvers): Filters {
  const explicitUsers = strings(params.user);
  const filters: Filters = {
    conversationIds: unique([...parsed.conversationIds, ...strings(params.conversation)]),
    userIds: unique([...parsed.userIds, ...explicitUsers]),
    botIds: unique([...parsed.botIds, ...r.botsOfUsers(explicitUsers)]),
    after: parsed.after,
    before: parsed.before,
    has: unique([
      ...parsed.has,
      ...strings(params.has).filter((h): h is SearchHas => HAS_VALUES.includes(h as SearchHas)),
    ]),
    isThread: parsed.isThread,
  };
  for (const key of ['after', 'before'] as const) {
    const raw = params[key];
    if (!raw) continue;
    const day = parseDay(raw);
    if (!day) parsed.unresolved.push(`${key}:${raw}`);
    else narrowDates(filters, key === 'after' ? day : null, key === 'before' ? day : null);
  }
  return filters;
}

/** Narrows the filters to `within`; false when nothing can match any more. */
function narrowWithin(filters: Filters, within: SearchWithin, r: SearchResolvers): boolean {
  const conversations = within.conversationIds ?? [];
  if (conversations.length) {
    filters.conversationIds = filters.conversationIds.length
      ? filters.conversationIds.filter((id) => conversations.includes(id))
      : [...conversations];
    if (!filters.conversationIds.length) return false;
  }
  const users = within.userIds ?? [];
  if (users.length) {
    const bots = r.botsOfUsers([...users]);
    if (filters.userIds.length || filters.botIds.length) {
      filters.userIds = filters.userIds.filter((id) => users.includes(id));
      filters.botIds = filters.botIds.filter((id) => bots.includes(id));
    } else {
      filters.userIds = [...users];
      filters.botIds = bots;
    }
    if (!filters.userIds.length && !filters.botIds.length) return false;
  }
  narrowDates(filters, within.after ?? null, within.before ?? null);
  return !(filters.after && filters.before && filters.after >= filters.before);
}

function strings(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string' && v !== '') : [];
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

interface Where {
  sql: string[];
  params: unknown[];
}

function filterClauses(f: Filters, match: { positive: string | null; negative: string | null }): Where {
  const where: Where = { sql: [], params: [] };
  const add = (sql: string, ...params: unknown[]) => {
    where.sql.push(sql);
    where.params.push(...params);
  };
  if (f.conversationIds.length) {
    const c = inList('m.conversation_id', f.conversationIds);
    add(c.sql, ...c.params);
  }
  if (f.userIds.length && f.botIds.length) {
    const u = inList('m.user_id', f.userIds);
    const b = inList('m.bot_id', f.botIds);
    add(`(${u.sql} OR ${b.sql})`, ...u.params, ...b.params);
  } else if (f.userIds.length) {
    const u = inList('m.user_id', f.userIds);
    add(u.sql, ...u.params);
  } else if (f.botIds.length) {
    const b = inList('m.bot_id', f.botIds);
    add(b.sql, ...b.params);
  }
  if (f.after) add('m.time >= ?', localDayStartSeconds(f.after));
  if (f.before) add('m.time < ?', localDayStartSeconds(f.before));
  for (const h of [...f.has].sort()) add(HAS_SQL[h]);
  if (f.isThread) add('m.thread_ts IS NOT NULL');
  // FTS5 has no unary NOT, so an exclusion-only query filters rows out with a subquery instead.
  if (!match.positive && match.negative) {
    add('m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)', match.negative);
  }
  return where;
}

interface PageResult {
  total: number;
  ids: number[];
  snippets: string[];
}

// Message ids are ts-derived microseconds (write.ts allocateMessageId), so the FTS rowid is the
// chronological order: sorting and the recency tie-break never need the messages table.
// bm25 is negative (lower = better); one point per ~1000 days of age is a gentle recency nudge.
const RELEVANCE = 'bm25(messages_fts) + (? - messages_fts.rowid) / 86400000000000.0';

const FTS_ORDER: Record<SearchSort, string> = {
  relevance: `${RELEVANCE}, messages_fts.rowid DESC`,
  newest: 'messages_fts.rowid DESC',
  oldest: 'messages_fts.rowid ASC',
};

/** The same orders over the `id`/`score` columns of a materialized match list. */
const PAGE_ORDER: Record<SearchSort, string> = {
  relevance: 'score, id DESC',
  newest: 'id DESC',
  oldest: 'id ASC',
};

/**
 * Planner knob (mutable so tests can force either strategy). Above `joinMaxMatches` text matches,
 * filters are applied as a precomputed id set rather than by joining every match to `messages`
 * (a join costs ~1µs per match; the id set ~0.1µs per filtered message, via the filter's index).
 */
export const searchTuning = { joinMaxMatches: 5000 };

interface FtsQuery {
  expr: string;
  where: Where;
  /** Loose FTS rowid bounds derived from date filters (exact date checks stay in `where`). */
  range: Where;
  sort: SearchSort;
  limit: number;
  offset: number;
  now: Date;
}

/** FROM/WHERE for one way of evaluating "text matches AND filters". */
interface FtsSource {
  from: string;
  conditions: string;
  params: unknown[];
}

function ftsSearch(db: DB, q: FtsQuery): PageResult {
  const matchOnly: FtsSource = {
    from: 'FROM messages_fts',
    conditions: ['messages_fts MATCH ?', ...q.range.sql].join(' AND '),
    params: [q.expr, ...q.range.params],
  };
  const matches = countOf(db, matchOnly);
  if (matches === 0) return { total: 0, ids: [], snippets: [] };
  const orderParams = q.sort === 'relevance' ? [q.now.getTime() * 1000] : [];
  if (!q.where.sql.length) {
    if (q.offset >= matches) return { total: matches, ids: [], snippets: [] };
    const ids = stmt<{ id: number }>(
      db,
      `SELECT messages_fts.rowid AS id ${matchOnly.from} WHERE ${matchOnly.conditions}
       ORDER BY ${FTS_ORDER[q.sort]} LIMIT ? OFFSET ?`,
    )
      .all(...matchOnly.params, ...orderParams, q.limit, q.offset)
      .map((r) => r.id);
    return { total: matches, ids, snippets: snippetsFor(db, q.expr, ids) };
  }
  // Filters cost as much as the rest of the query together, so they are evaluated once: the
  // filtered matches are materialized with their total, then sorted for the page.
  const source = filteredSource(q, matches);
  const score = q.sort === 'relevance' ? RELEVANCE : 'NULL';
  const rows = stmt<{ id: number; total: number }>(
    db,
    `WITH hits AS MATERIALIZED (
       SELECT messages_fts.rowid AS id, ${score} AS score ${source.from} WHERE ${source.conditions}
     )
     SELECT id, (SELECT count(*) FROM hits) AS total FROM hits ORDER BY ${PAGE_ORDER[q.sort]} LIMIT ? OFFSET ?`,
  ).all(...orderParams, ...source.params, q.limit, q.offset);
  // A page past the end has no rows to carry the total.
  const total = rows[0]?.total ?? (q.offset > 0 ? countOf(db, source) : 0);
  const ids = rows.map((r) => r.id);
  return { total, ids, snippets: snippetsFor(db, q.expr, ids) };
}

/**
 * Few text matches: join each to messages and test the filters. Many matches: one FTS scan that
 * keeps rows whose id is in the filter's id set. The unary `+` keeps SQLite from turning that IN
 * into per-row FTS lookups, which rebuild prefix doclists every time.
 */
function filteredSource(q: FtsQuery, matches: number): FtsSource {
  const match = ['messages_fts MATCH ?', ...q.range.sql];
  const params = [q.expr, ...q.range.params];
  if (matches <= searchTuning.joinMaxMatches) {
    return {
      from: 'FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid',
      conditions: [...match, ...q.where.sql].join(' AND '),
      params: [...params, ...q.where.params],
    };
  }
  return {
    from: 'FROM messages_fts',
    conditions: [
      ...match,
      `+messages_fts.rowid IN (SELECT m.id FROM messages m WHERE ${q.where.sql.join(' AND ')})`,
    ].join(' AND '),
    params: [...params, ...q.where.params],
  };
}

function countOf(db: DB, source: FtsSource): number {
  return (
    stmt<{ n: number }>(db, `SELECT count(*) AS n ${source.from} WHERE ${source.conditions}`).get(...source.params)
      ?.n ?? 0
  );
}

/**
 * Date filters as FTS rowid bounds (ids are ts in µs), letting FTS5 skip out-of-range doclist
 * entries. One second of slack on the upper bound covers ids bumped past a colliding ts; the
 * exact `m.time` conditions in the filters still decide.
 */
function rowidRange(f: Filters): Where {
  const range: Where = { sql: [], params: [] };
  if (f.after) {
    range.sql.push('messages_fts.rowid >= ?');
    range.params.push(localDayStartSeconds(f.after) * 1_000_000);
  }
  if (f.before) {
    range.sql.push('messages_fts.rowid < ?');
    range.params.push((localDayStartSeconds(f.before) + 1) * 1_000_000);
  }
  return range;
}

/**
 * Snippets for one page in a single FTS pass. Computing them in the ranked query would do it for
 * every match, and a per-row `rowid = ?` lookup rebuilds the merged doclist of a prefix term for
 * each row (~30x slower for common prefixes). The unary `+` stops SQLite from turning the IN list
 * into such per-row lookups, so it becomes a filter on one scan bounded by the rowid range.
 */
function snippetsFor(db: DB, expr: string, ids: number[]): string[] {
  if (!ids.length) return [];
  const rows = stmt<{ id: number; s: string | null }>(
    db,
    `SELECT rowid AS id, snippet(messages_fts, 0, char(2), char(3), '…', 24) AS s FROM messages_fts
     WHERE messages_fts MATCH ? AND rowid >= ? AND rowid <= ? AND +rowid IN (SELECT value FROM json_each(?))`,
  ).all(expr, Math.min(...ids), Math.max(...ids), JSON.stringify(ids));
  const byId = new Map(rows.map((r) => [r.id, clampSnippet(desegmentCjk(flatten(r.s ?? '')))]));
  return ids.map((id) => byId.get(id) ?? '');
}

function listingSearch(db: DB, where: Where, sort: SearchSort, limit: number, offset: number): PageResult {
  const conditions = where.sql.join(' AND ');
  const total =
    stmt<{ n: number }>(db, `SELECT count(*) AS n FROM messages m WHERE ${conditions}`).get(...where.params)?.n ?? 0;
  if (total === 0 || offset >= total) return { total, ids: [], snippets: [] };
  // id breaks ties within a second (it is chronological) and is the implicit tail of every
  // index, so the time-ordered indexes satisfy the whole ORDER BY.
  const order = sort === 'oldest' ? 'm.time ASC, m.id ASC' : 'm.time DESC, m.id DESC';
  const rows = stmt<{ id: number; plain_text: string }>(
    db,
    `SELECT m.id AS id, substr(m.plain_text, 1, ${LEAD_SNIPPET_CHARS * 2}) AS plain_text FROM messages m
     WHERE ${conditions} ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).all(...where.params, limit, offset);
  return { total, ids: rows.map((r) => r.id), snippets: rows.map((r) => leadSnippet(desegmentCjk(r.plain_text))) };
}

function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** First ~200 chars of plain text, cut at a word boundary when one is reasonably close. */
function leadSnippet(text: string): string {
  const flat = flatten(text);
  const chars = Array.from(flat); // code points: never split a surrogate pair (pitfall 14)
  if (chars.length <= LEAD_SNIPPET_CHARS) return flat;
  const cut = chars.slice(0, LEAD_SNIPPET_CHARS).join('');
  const space = cut.lastIndexOf(' ');
  return (space > cut.length * 0.6 ? cut.slice(0, space) : cut) + '…';
}

const HL_START = '\u0002';
const HL_END = '\u0003';
/** Upper bound on snippet text: FTS5 counts tokens, and one token can be a 5,000-char hash. */
export const MAX_SNIPPET_CHARS = 320;

/**
 * Caps a highlighted snippet at `max` visible code points, never splitting a surrogate pair and
 * always closing an open highlight, so the renderer gets balanced markers.
 */
export function clampSnippet(snippet: string, max: number = MAX_SNIPPET_CHARS): string {
  const chars = Array.from(snippet);
  let visible = 0;
  let open = false;
  let out = '';
  for (const ch of chars) {
    if (ch === HL_START || ch === HL_END) {
      open = ch === HL_START;
      out += ch;
      continue;
    }
    if (visible >= max) {
      if (open) out += HL_END;
      return out.replace(/\s+$/, '') + '…';
    }
    out += ch;
    visible++;
  }
  return out;
}
