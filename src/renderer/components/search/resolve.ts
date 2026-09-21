/**
 * Client-side mirror of main's modifier resolution (src/main/db/search.ts).
 *
 * Main stays the authority for results and for `parsed.unresolved`; this copy exists so
 * the filter chips can show what `from:`/`in:`/`has:`/date modifiers typed in the query mean
 * instantly, and so a chip edit can move a modifier out of the text into a URL param.
 */
import type { ConversationDTO, SearchHas, UserDTO } from '../../../shared/types';
import { removeTokens, tokenizeQuery, type ModifierKey, type QueryToken } from './queryText';

export interface ResolverData {
  users: readonly UserDTO[];
  conversations: readonly ConversationDTO[];
  selfUserId: string | null;
  /** Clock for `today` / `yesterday`. */
  now?: Date;
}

export const HAS_VALUES: readonly SearchHas[] = ['file', 'link', 'image', 'reaction', 'thread'];

// ---------------------------------------------------------------------------------------------
// People and conversations

/** Case-insensitive; exact matches (id or any name key) beat prefix matches, as in main. */
function matchIds<T extends { id: string }>(
  items: readonly T[],
  keys: (item: T) => (string | null | undefined)[],
  token: string,
): string[] {
  const q = token.trim().toLowerCase();
  if (!q) return [];
  const exact = items.filter((t) => t.id.toLowerCase() === q || keys(t).some((k) => k?.toLowerCase() === q));
  if (exact.length) return exact.map((t) => t.id);
  return items.filter((t) => keys(t).some((k) => !!k && k.toLowerCase().startsWith(q))).map((t) => t.id);
}

const userKeys = (u: UserDTO) => [u.name, u.displayName, u.realName];

export function resolveUsers(token: string, data: ResolverData): string[] {
  const ids = matchIds(data.users, userKeys, token);
  if (!ids.length && token.trim().toLowerCase() === 'me' && data.selfUserId) return [data.selfUserId];
  return ids;
}

export function resolveConversations(token: string, data: ResolverData): string[] {
  const q = token.trim().toLowerCase();
  const byId = data.conversations.filter((c) => c.id.toLowerCase() === q).map((c) => c.id);
  if (byId.length) return byId;
  const named = data.conversations.filter((c) => c.type !== 'im');
  return matchIds(named, (c) => [c.rawName], token);
}

function dmConversations(userIds: readonly string[], data: ResolverData): string[] {
  const wanted = new Set(userIds);
  return data.conversations.filter((c) => c.type === 'im' && c.dmUserId && wanted.has(c.dmUserId)).map((c) => c.id);
}

/** `in:#x` → channel, `in:@x` → DM with x, bare `in:x` → channel first, then DM. */
export function resolveIn(value: string, data: ResolverData): string[] {
  if (value.startsWith('@')) return dmConversations(resolveUsers(value.slice(1), data), data);
  if (value.startsWith('#')) return resolveConversations(value.slice(1), data);
  const conversations = resolveConversations(value, data);
  return conversations.length ? conversations : dmConversations(resolveUsers(value, data), data);
}

export function normalizeHas(value: string): SearchHas | null {
  const v = value.toLowerCase().replace(/s$/, '');
  return (HAS_VALUES as readonly string[]).includes(v) ? (v as SearchHas) : null;
}

// ---------------------------------------------------------------------------------------------
// Calendar days (YYYY-MM-DD, local time)

const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatDay(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function localDay(date: Date): string {
  return formatDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** Calendar arithmetic on the day string (UTC math sidesteps DST-length days). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return formatDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** A real calendar day as YYYY-MM-DD (single-digit month/day tolerated), `today`, `yesterday`. */
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

/** `during:YYYY-MM`, `during:YYYY` or a single day → [after, before). */
export function parseDuring(value: string, now: Date = new Date()): DateRange | null {
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

/** `after` inclusive, `before` exclusive; null means unbounded. */
export interface DateRange {
  after: string | null;
  before: string | null;
}

/** Intersects two ranges, like main's `narrowDates`. */
export function narrowRange(a: DateRange, b: DateRange): DateRange {
  const after = a.after && b.after ? (a.after > b.after ? a.after : b.after) : (a.after ?? b.after);
  const before = a.before && b.before ? (a.before < b.before ? a.before : b.before) : (a.before ?? b.before);
  return { after, before };
}

// ---------------------------------------------------------------------------------------------
// Query analysis

export type FilterDimension = 'conversation' | 'user' | 'date' | 'has';

export const DIMENSION_KEYS: Record<FilterDimension, readonly ModifierKey[]> = {
  conversation: ['in'],
  user: ['from'],
  date: ['before', 'after', 'on', 'during'],
  has: ['has'],
};

export interface QueryFilters extends DateRange {
  conversation: string[];
  user: string[];
  has: SearchHas[];
}

export const NO_FILTERS: QueryFilters = { conversation: [], user: [], has: [], after: null, before: null };

/** What one modifier token contributes, or null when it can't be resolved. */
export function resolveToken(token: QueryToken, data: ResolverData): Partial<QueryFilters> | null {
  if (!token.key || token.negated) return null;
  const value = token.value.trim();
  if (!value) return null;
  const now = data.now ?? new Date();
  const nonEmpty = (ids: string[]) => (ids.length ? ids : null);
  switch (token.key) {
    case 'from': {
      const ids = nonEmpty(resolveUsers(value.replace(/^@/, ''), data));
      return ids && { user: ids };
    }
    case 'in': {
      const ids = nonEmpty(resolveIn(value, data));
      return ids && { conversation: ids };
    }
    case 'has': {
      const has = normalizeHas(value);
      return has && { has: [has] };
    }
    case 'is':
      return null; // `is:thread` has no chip; it stays in the text.
    case 'during':
      return parseDuring(value, now);
    default: {
      const day = parseDay(value, now);
      if (!day) return null;
      if (token.key === 'after') return { after: day };
      if (token.key === 'before') return { before: day };
      return { after: day, before: addDays(day, 1) }; // on:
    }
  }
}

const union = <T>(a: readonly T[], b: readonly T[] = []): T[] => [...new Set([...a, ...b])];

export function mergeFilters(a: QueryFilters, b: Partial<QueryFilters>): QueryFilters {
  return {
    conversation: union(a.conversation, b.conversation),
    user: union(a.user, b.user),
    has: union(a.has, b.has),
    ...narrowRange(a, { after: b.after ?? null, before: b.before ?? null }),
  };
}

/** Filters expressed by the modifiers in `q` (resolvable ones only). */
export function filtersFromQuery(q: string, data: ResolverData): QueryFilters {
  let filters = NO_FILTERS;
  for (const token of tokenizeQuery(q)) {
    const contribution = resolveToken(token, data);
    if (contribution) filters = mergeFilters(filters, contribution);
  }
  return filters;
}

/** Removes the resolvable modifiers of one dimension from `q`; unresolvable ones stay visible. */
export function stripDimension(q: string, dimension: FilterDimension, data: ResolverData): string {
  const keys = DIMENSION_KEYS[dimension];
  return removeTokens(q, (t) => t.key !== null && keys.includes(t.key) && resolveToken(t, data) !== null);
}
