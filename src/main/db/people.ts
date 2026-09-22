/**
 * People: everyone the reader talks with, and what is between them. Read from the archive only.
 *
 * "Between you" is the DM with someone, the group DMs you share, and messages where one of you
 * mentions the other. Channels count only for "where they write". Everything here leans on the
 * author indexes (`messages_user_time`, and `messages_conv_user_time` for one author in one
 * conversation), so a person with 50k messages in a 500k-message archive opens in milliseconds.
 */
import type {
  MessageDTO,
  PersonConversationDTO,
  PersonDTO,
  PersonLinkDTO,
  PersonSummaryDTO,
  PersonWeekDTO,
} from '../../shared/types';
import { hydrateMessages } from './dto';
import { nonEmpty } from './labels';
import { parseStringArray } from './merge';
import { getMeta } from './meta';
import { unescapeEntities } from './normalize';
import { tsAtSecond } from './read';
import { stmt } from './stmt';
import type { DB } from './types';

/** Open questions look this far back: older ones were settled some other way, or forgotten. */
export const OPEN_QUESTION_DAYS = 30;
/** Top-level channel messages this soon after a question count as the answer. */
const CHANNEL_ANSWER_SECONDS = 24 * 3600;
/** Mentions are looked for among each author's latest messages only (bounded, like a scan window). */
const MENTION_SCAN_ROWS = 3000;
const RECENT_LIMIT = 8;
const OPEN_LIMIT = 10;
const FILE_MESSAGES_LIMIT = 12;
const LINK_LIMIT = 10;
/** Messages with links read to find LINK_LIMIT different addresses. */
const LINK_SCAN_ROWS = 200;
const CHANNEL_LIMIT = 50;
const WEEKS = 26;

// =============================================================================================
// The list
// =============================================================================================

/**
 * Everyone who wrote in the archive or shares a DM or group DM with the reader: people only (no
 * apps, not Slackbot), without the reader. Most recently in touch first: the DM or a group DM,
 * else their latest message anywhere.
 */
export function listPeople(db: DB): PersonSummaryDTO[] {
  const self = getMeta(db, 'self_user_id');
  const written = new Map<string, { count: number; last: number }>();
  for (const r of stmt<{ user_id: string; n: number; last: number }>(
    db,
    'SELECT user_id, count(*) AS n, max(time) AS last FROM messages WHERE user_id IS NOT NULL GROUP BY user_id',
  ).all()) {
    written.set(r.user_id, { count: r.n, last: r.last });
  }

  const dms = new Map<string, { id: string; count: number }>();
  const talked = new Map<string, string>();
  for (const c of privateConversations(db)) {
    if (c.message_count === 0) continue;
    const members = c.type === 'im' ? (c.dm_user_id ? [c.dm_user_id] : []) : parseStringArray(c.member_ids);
    if (c.type === 'im' && c.dm_user_id) dms.set(c.dm_user_id, { id: c.id, count: c.message_count });
    for (const m of members) if (c.latest_ts && (talked.get(m) ?? '') < c.latest_ts) talked.set(m, c.latest_ts);
  }

  const out: PersonSummaryDTO[] = [];
  for (const u of stmt<{ id: string; raw: string }>(
    db,
    "SELECT id, raw FROM users WHERE is_bot = 0 AND id <> 'USLACKBOT'",
  ).all()) {
    if (u.id === self) continue;
    const mine = written.get(u.id);
    const lastTalkedTs = talked.get(u.id) ?? null;
    if (!mine && !lastTalkedTs) continue;
    const profile = readProfile(u.raw);
    const dm = dms.get(u.id);
    out.push({
      userId: u.id,
      title: profile.title,
      tz: profile.tz,
      messageCount: mine?.count ?? 0,
      lastMessageTs: mine ? tsAtSecond(mine.last) : null,
      dmConversationId: dm?.id ?? null,
      dmMessageCount: dm?.count ?? 0,
      lastTalkedTs,
    });
  }
  const recency = (p: PersonSummaryDTO) => Number(p.lastTalkedTs ?? p.lastMessageTs ?? 0);
  return out.sort((a, b) => recency(b) - recency(a) || a.userId.localeCompare(b.userId));
}

interface PrivateConversationRow {
  id: string;
  type: 'im' | 'mpim';
  dm_user_id: string | null;
  member_ids: string;
  message_count: number;
  latest_ts: string | null;
}

function privateConversations(db: DB): PrivateConversationRow[] {
  return stmt<PrivateConversationRow>(
    db,
    `SELECT c.id, c.type, c.dm_user_id, c.member_ids, COALESCE(s.message_count, 0) AS message_count, s.latest_ts
     FROM conversations c LEFT JOIN conversation_stats s ON s.conversation_id = c.id
     WHERE c.type IN ('im', 'mpim')`,
  ).all();
}

// =============================================================================================
// One person
// =============================================================================================

interface PersonUserRow {
  id: string;
  avatar_url: string | null;
  raw: string;
}

/** Everything the person's page shows; null when the archive doesn't know them. */
export function getPerson(db: DB, userId: string, opts: { now?: number } = {}): PersonDTO | null {
  const user = stmt<PersonUserRow>(db, 'SELECT id, avatar_url, raw FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  const self = getMeta(db, 'self_user_id');
  const isSelf = self === userId;
  const profile = readProfile(user.raw);

  const totals = stmt<{ n: number; first: number | null; last: number | null }>(
    db,
    'SELECT count(*) AS n, min(time) AS first, max(time) AS last FROM messages WHERE user_id = ?',
  ).get(userId)!;

  const privates = privateConversations(db);
  // A DM with nothing archived (never used, or its archive deleted) is no place to open.
  const dmRow = isSelf
    ? undefined
    : privates.find((c) => c.type === 'im' && c.dm_user_id === userId && c.message_count > 0);
  const groupRows = isSelf
    ? []
    : privates.filter((c) => c.type === 'mpim' && parseStringArray(c.member_ids).includes(userId));
  const between: Between = {
    person: userId,
    self: isSelf ? null : self,
    dmId: dmRow?.id ?? null,
    groupIds: groupRows.map((c) => c.id),
  };

  const recent = between.self ? recentBetween(db, between) : [];
  return {
    userId,
    isSelf,
    title: profile.title,
    tz: profile.tz,
    tzLabel: profile.tzLabel,
    email: profile.email,
    isGuest: profile.isGuest,
    avatarUrl: profile.largeAvatar ?? user.avatar_url,
    messageCount: totals.n,
    firstMessageTs: totals.first != null ? tsAtSecond(totals.first) : null,
    lastMessageTs: totals.last != null ? tsAtSecond(totals.last) : null,
    dm: dmRow ? privateToDTO(dmRow) : null,
    groupDms: groupRows
      .filter((c) => c.message_count > 0)
      .map(privateToDTO)
      .sort(byLatest),
    channels: channelsTheyWriteIn(db, userId),
    lastTalkedTs: recent[0]?.ts ?? null,
    weeks: between.self ? weeksBetween(db, between, nowSeconds) : [],
    openQuestionDays: OPEN_QUESTION_DAYS,
    waitingOnYou: between.self ? openQuestions(db, userId, between.self, between, nowSeconds) : [],
    waitingOnThem: between.self ? openQuestions(db, between.self, userId, between, nowSeconds) : [],
    recent,
    fileMessages: messagesWithFiles(db, userId),
    links: linksShared(db, userId),
  };
}

interface Between {
  person: string;
  /** The reader; null on the reader's own page. */
  self: string | null;
  dmId: string | null;
  groupIds: string[];
}

function privateToDTO(row: PrivateConversationRow): PersonConversationDTO {
  return { conversationId: row.id, messageCount: row.message_count, latestTs: row.latest_ts };
}

const byLatest = (a: PersonConversationDTO, b: PersonConversationDTO) =>
  Number(b.latestTs ?? 0) - Number(a.latestTs ?? 0);

/** Channels (not DMs) with how many of their messages each holds, busiest first. */
function channelsTheyWriteIn(db: DB, userId: string): PersonConversationDTO[] {
  // One probe of the (conversation_id, user_id, time) index per channel: no message row is read.
  const probe = stmt<{ n: number; last: number | null }>(
    db,
    'SELECT count(*) AS n, max(time) AS last FROM messages WHERE conversation_id = ? AND user_id = ?',
  );
  const out: { id: string; n: number; last: number }[] = [];
  for (const { id } of stmt<{ id: string }>(
    db,
    "SELECT id FROM conversations WHERE type IN ('channel', 'private_channel')",
  ).all()) {
    const r = probe.get(id, userId);
    if (r && r.n > 0 && r.last != null) out.push({ id, n: r.n, last: r.last });
  }
  return out
    .sort((a, b) => b.n - a.n || b.last - a.last)
    .slice(0, CHANNEL_LIMIT)
    .map((r) => ({ conversationId: r.id, messageCount: r.n, latestTs: tsAtSecond(r.last) }));
}

// ─── between you ─────────────────────────────────────────────────────────────────────────────

interface IdTime {
  id: number;
  time: number;
}

/**
 * The latest messages between you, newest first: the DM, what either of you wrote in the group
 * DMs you share, and mentions of each other anywhere.
 */
function recentBetween(db: DB, b: Between): MessageDTO[] {
  const self = b.self!;
  const rows: IdTime[] = [];
  if (b.dmId) {
    rows.push(
      ...stmt<IdTime>(db, 'SELECT id, time FROM messages WHERE conversation_id = ? ORDER BY time DESC LIMIT ?').all(
        b.dmId,
        RECENT_LIMIT,
      ),
    );
  }
  for (const groupId of b.groupIds) {
    for (const author of [b.person, self]) rows.push(...latestBy(db, author, groupId, RECENT_LIMIT));
  }
  rows.push(...mentions(db, b.person, self, RECENT_LIMIT), ...mentions(db, self, b.person, RECENT_LIMIT));
  const seen = new Set<number>();
  const newest = rows
    .sort((x, y) => y.time - x.time || y.id - x.id)
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .slice(0, RECENT_LIMIT);
  return hydrateMessages(
    db,
    newest.map((r) => r.id),
  );
}

function latestBy(db: DB, author: string, conversationId: string, limit: number): IdTime[] {
  return stmt<IdTime>(
    db,
    'SELECT id, time FROM messages WHERE user_id = ? AND conversation_id = ? ORDER BY time DESC LIMIT ?',
  ).all(author, conversationId, limit);
}

/**
 * `author`'s latest messages that mention `mentioned` (`<@U1>`, or Slack's older `<@U1|ana>`),
 * among their latest MENTION_SCAN_ROWS.
 */
function mentions(db: DB, author: string, mentioned: string, limit: number): IdTime[] {
  return stmt<IdTime>(
    db,
    `SELECT id, time FROM (
       SELECT id, time, text FROM messages WHERE user_id = ? ORDER BY time DESC LIMIT ?
     ) WHERE instr(text, ?) > 0 OR instr(text, ?) > 0 ORDER BY time DESC LIMIT ?`,
  ).all(author, MENTION_SCAN_ROWS, `<@${mentioned}>`, `<@${mentioned}|`, limit);
}

/**
 * Messages between you per local week (Monday to Sunday), from the first week with any, at most
 * WEEKS back, to this week: the DM, and what either of you wrote in shared group DMs.
 */
function weeksBetween(db: DB, b: Between, nowSeconds: number): PersonWeekDTO[] {
  const thisWeek = weekStart(nowSeconds);
  const from = shiftWeeks(thisWeek, -(WEEKS - 1));
  const times: number[] = [];
  if (b.dmId) {
    times.push(
      ...stmt<{ time: number }>(db, 'SELECT time FROM messages WHERE conversation_id = ? AND time >= ?')
        .all(b.dmId, from)
        .map((r) => r.time),
    );
  }
  for (const groupId of b.groupIds) {
    for (const author of [b.person, b.self!]) {
      times.push(
        ...stmt<{ time: number }>(
          db,
          'SELECT time FROM messages WHERE user_id = ? AND conversation_id = ? AND time >= ?',
        )
          .all(author, groupId, from)
          .map((r) => r.time),
      );
    }
  }
  if (!times.length) return [];
  const counts = new Map<number, number>();
  for (const t of times) {
    const week = weekStart(t);
    counts.set(week, (counts.get(week) ?? 0) + 1);
  }
  const weeks: PersonWeekDTO[] = [];
  for (let week = Math.min(...counts.keys()); week <= thisWeek; week = shiftWeeks(week, 1)) {
    weeks.push({ start: week, count: counts.get(week) ?? 0 });
  }
  return weeks;
}

/** Unix seconds of local Monday 00:00 of the week holding `seconds`. */
export function weekStart(seconds: number): number {
  const d = new Date(seconds * 1000);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return Math.floor(d.getTime() / 1000);
}

/** Calendar arithmetic, so a week across a daylight-saving change still starts at midnight. */
function shiftWeeks(start: number, weeks: number): number {
  const d = new Date(start * 1000);
  d.setDate(d.getDate() + weeks * 7);
  return Math.floor(d.getTime() / 1000);
}

// ─── open questions ─────────────────────────────────────────────────────────────────────────

interface AskRow {
  id: number;
  conversation_id: string;
  ts: string;
  time: number;
  thread_ts: string | null;
  text: string;
  reactions: string;
}

/**
 * Questions and requests `asker` addressed to `answerer` in the last OPEN_QUESTION_DAYS that got
 * no answer in Slack, newest first. Addressed means written in your DM, or in lines that mention
 * them (a line mentioning only other people is for those people; @channel and @here are for
 * everyone). Answered means a reaction, a later reply in the thread, a later message in the DM or
 * group DM, or in a channel a top-level message within a day, from anyone it was addressed to.
 */
function openQuestions(db: DB, asker: string, answerer: string, b: Between, nowSeconds: number): MessageDTO[] {
  const since = nowSeconds - OPEN_QUESTION_DAYS * 86400;
  const privateIds = new Set([b.dmId, ...b.groupIds].filter((id): id is string => id != null));
  const open: number[] = [];
  for (const m of stmt<AskRow>(
    db,
    `SELECT id, conversation_id, ts, time, thread_ts, text, reactions FROM messages
     WHERE user_id = ? AND time >= ? AND (subtype IS NULL OR subtype = 'thread_broadcast') AND is_deleted = 0
     ORDER BY time DESC`,
  ).all(asker, since)) {
    const ask = addressedPart(m.text, answerer, m.conversation_id === b.dmId);
    if (!ask || !looksLikeAsk(ask.text)) continue;
    const answerers = [answerer, ...ask.alsoTo.filter((id) => id !== asker)];
    if (answerers.some((id) => answered(db, m, id, privateIds.has(m.conversation_id)))) continue;
    open.push(m.id);
    if (open.length >= OPEN_LIMIT) break;
  }
  return hydrateMessages(db, open);
}

const MENTION = /<@([A-Za-z0-9_-]+)(?:\|[^>]*)?>/g;
/** Between two mentions of one run: "@Ana, @Bo and @Cy". */
const BETWEEN_MENTIONS = /^(?:[\s,&]|and\b)*$/i;
/** Before a run that opens the line: "Hey …", "Thanks …", "1. …", a quote or a bullet. */
const OPENING =
  /^[\s>*•-]*(?:\w[.)]\s*)?(?:(?:hey|hi|hello|dear|yo|thanks|thank you|thx|cc|fyi|ping|good (?:morning|afternoon|evening)|morning)\b[\s,!:]*)?$/i;
/** After a run that closes a sentence: "… can you check, @Ana?", "… with the client @Ana. I …". */
const CLOSING = /^(?:[\s,&]|and\b)*(?:[.!?؟？]|$)/i;
/** Before a run that is who a sentence is about: "3 tasks for @Ana.", "a message to @Ana". */
const ABOUT = /\b(?:to|for|with|from|by|about|of|at|on|in|and|or)\s+$/i;
const CC = /\bcc:?\s*$/i;
/** Only the end of the text before a run matters to ABOUT and CC. */
const BEFORE_TAIL = 40;

/**
 * Who a line speaks to: a run of mentions opening it, closing a sentence, or after "cc"; not
 * "I told @Ana". Runs are found first and judged by the text around them, so no pattern can
 * backtrack over a line with many mentions (one did: 30 mentions in a row took seconds).
 */
function addressees(line: string): string[] {
  const runs: { start: number; end: number; ids: string[] }[] = [];
  for (const m of line.matchAll(MENTION)) {
    const start = m.index;
    const end = start + m[0].length;
    const last = runs[runs.length - 1];
    if (last && BETWEEN_MENTIONS.test(line.slice(last.end, start))) {
      last.end = end;
      last.ids.push(m[1]);
    } else {
      runs.push({ start, end, ids: [m[1]] });
    }
  }
  const to = new Set<string>();
  for (const run of runs) {
    const before = line.slice(0, run.start);
    const tail = before.slice(-BEFORE_TAIL);
    const speaks = OPENING.test(before) || CC.test(tail) || (CLOSING.test(line.slice(run.end)) && !ABOUT.test(tail));
    if (speaks) for (const id of run.ids) to.add(id);
  }
  return [...to];
}

/** Everyone a message speaks to (see addressees), each once; nobody for @channel or @here. */
export function speaksTo(text: string): string[] {
  if (BROADCAST.test(text)) return [];
  const out = new Set<string>();
  for (const line of text.split('\n')) for (const id of addressees(line)) out.add(id);
  return [...out];
}

/**
 * The part of a message meant for `target`, and who else it was meant for. A DM is meant for the
 * other person whole. Elsewhere a line must speak to them: lines speaking to them, and lines
 * speaking to nobody in particular, are theirs; a line speaking only to other people is not, nor
 * is a message for @channel or @here.
 */
export function addressedPart(text: string, target: string, inDm: boolean): { text: string; alsoTo: string[] } | null {
  if (inDm) return { text, alsoTo: [] };
  if (BROADCAST.test(text)) return null;
  let spoken = false;
  const alsoTo = new Set<string>();
  const kept = text.split('\n').filter((line) => {
    const to = addressees(line);
    if (to.length === 0) return true;
    if (!to.includes(target)) return false;
    spoken = true;
    for (const id of to) if (id !== target) alsoTo.add(id);
    return true;
  });
  return spoken ? { text: kept.join('\n'), alsoTo: [...alsoTo] } : null;
}

function answered(db: DB, m: AskRow, answerer: string, isPrivate: boolean): boolean {
  if (reactedBy(m.reactions, answerer)) return true;
  // The unary + keeps SQLite on the thread's index: through the author's, it would walk everything
  // they ever wrote in that channel.
  if (
    m.thread_ts &&
    stmt(
      db,
      'SELECT 1 FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts > ? AND +user_id = ? LIMIT 1',
    ).get(m.conversation_id, m.thread_ts, m.ts, answerer) !== undefined
  ) {
    return true;
  }
  if (isPrivate) {
    // A DM or a small group: whatever they wrote next is taken as the answer.
    return (
      stmt(db, 'SELECT 1 FROM messages WHERE user_id = ? AND conversation_id = ? AND time >= ? AND ts > ? LIMIT 1').get(
        answerer,
        m.conversation_id,
        m.time,
        m.ts,
      ) !== undefined
    );
  }
  // In a channel, a question in a thread waits for its thread; a top-level one can also be
  // answered in the channel, if soon.
  if (m.thread_ts && m.thread_ts !== m.ts) return false;
  return (
    stmt(
      db,
      `SELECT 1 FROM messages WHERE user_id = ? AND conversation_id = ? AND time >= ? AND time <= ? AND ts > ?
       AND (is_reply = 0 OR subtype = 'thread_broadcast') LIMIT 1`,
    ).get(answerer, m.conversation_id, m.time, m.time + CHANNEL_ANSWER_SECONDS, m.ts) !== undefined
  );
}

function reactedBy(reactionsJson: string, userId: string): boolean {
  try {
    const reactions: unknown = JSON.parse(reactionsJson);
    return (
      Array.isArray(reactions) &&
      reactions.some(
        (r) => Array.isArray((r as { users?: unknown }).users) && (r as { users: unknown[] }).users.includes(userId),
      )
    );
  } catch {
    return false;
  }
}

const BROADCAST = /<!(?:channel|here|everyone)\b/;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const QUOTE_LINE = /^(?:>|&gt;).*$/gm;
/** Links, mentions, channels and dates: a "?" inside a link's address is not a question. */
const MARKUP = /<[^>\n]*>/g;
/** Greetings that end in a question mark but ask nothing to act on. */
const SMALL_TALK =
  /\b(?:how are (?:you|u|things)|how r u|how(?:'|’)?s it going|how was (?:your |the )?(?:weekend|day|trip)|hbu|wbu|what(?:'|’)?s up)\b[\s?!.]*/gi;
/** Question marks in Latin, Arabic and full-width (CJK) scripts. */
const QUESTION_MARK = /[?؟？]/;
const REQUEST =
  /\b(?:can|could|would|will) (?:you|u)\b|\bplease\b|\bpls\b|\bplz\b|\blet me know\b|\bany (?:update|news)\b|\bdo you (?:have|know)\b|\bare you (?:able|free|around|available)\b/i;

/** "2 min pls" asks for patience, not for anything to be done: a request needs a few more words. */
const REQUEST_MIN_WORDS = 4;

/**
 * Whether a message asks something: a question mark, or a request ("can you", "please", "let me
 * know") in a sentence of a few words, outside code, quotes, link addresses and greetings
 * ("how are you?").
 */
export function looksLikeAsk(text: string): boolean {
  const plain = unescapeEntities(text.replace(CODE, ' ').replace(QUOTE_LINE, ' ').replace(MARKUP, ' ')).replace(
    SMALL_TALK,
    ' ',
  );
  if (QUESTION_MARK.test(plain)) return true;
  return REQUEST.test(plain) && plain.split(/\s+/).filter(Boolean).length >= REQUEST_MIN_WORDS;
}

// ─── what they shared ───────────────────────────────────────────────────────────────────────

function messagesWithFiles(db: DB, userId: string): MessageDTO[] {
  const ids = stmt<{ id: number }>(
    db,
    'SELECT id FROM messages WHERE user_id = ? AND has_files = 1 ORDER BY time DESC LIMIT ?',
  )
    .all(userId, FILE_MESSAGES_LIMIT)
    .map((r) => r.id);
  return hydrateMessages(db, ids);
}

interface LinkRow {
  conversation_id: string;
  ts: string;
  thread_ts: string | null;
  is_reply: number;
  text: string;
}

/** Addresses they posted, newest first, each once. Slack's own links (messages, files) are left out. */
function linksShared(db: DB, userId: string): PersonLinkDTO[] {
  const out: PersonLinkDTO[] = [];
  const seen = new Set<string>();
  for (const row of stmt<LinkRow>(
    db,
    'SELECT conversation_id, ts, thread_ts, is_reply, text FROM messages WHERE user_id = ? AND has_links = 1 ORDER BY time DESC LIMIT ?',
  ).all(userId, LINK_SCAN_ROWS)) {
    for (const link of extractLinks(row.text)) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      out.push({
        ...link,
        conversationId: row.conversation_id,
        ts: row.ts,
        threadTs: row.thread_ts,
        isReply: row.is_reply === 1,
      });
      if (out.length >= LINK_LIMIT) return out;
    }
  }
  return out;
}

const LINK = /<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>/g;
const MAX_URL_LENGTH = 2000;

/** http(s) links in Slack mrkdwn, in order, with their label when it isn't just the address. */
export function extractLinks(text: string): { url: string; label: string | null }[] {
  const out: { url: string; label: string | null }[] = [];
  for (const match of text.matchAll(LINK)) {
    const url = unescapeEntities(match[1]);
    if (url.length > MAX_URL_LENGTH || isSlackUrl(url)) continue;
    const label = nonEmpty(unescapeEntities(match[2] ?? '').trim());
    out.push({ url, label: label && !sameAddress(label, url) ? label : null });
  }
  return out;
}

function isSlackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'slack.com' || host.endsWith('.slack.com');
  } catch {
    return true;
  }
}

/** Slack labels a pasted link with its own address, often without the scheme. */
function sameAddress(label: string, url: string): boolean {
  const bare = (s: string) => s.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return bare(label) === bare(url);
}

// ─── profile ────────────────────────────────────────────────────────────────────────────────

interface Profile {
  title: string | null;
  tz: string | null;
  tzLabel: string | null;
  email: string | null;
  isGuest: boolean;
  largeAvatar: string | null;
}

const TZ_RE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/;

/** What Slack's profile says, each field checked: it comes from Slack, not from us. */
function readProfile(raw: string): Profile {
  let u: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') u = parsed as Record<string, unknown>;
  } catch {
    // An unreadable raw copy leaves every field empty.
  }
  const p = (u.profile && typeof u.profile === 'object' ? u.profile : {}) as Record<string, unknown>;
  const text = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? nonEmpty(v.trim()) : null);
  const tz = text(u.tz, 64);
  const email = text(p.email, 254);
  return {
    title: text(p.title),
    tz: tz && TZ_RE.test(tz) ? tz : null,
    tzLabel: text(u.tz_label, 100),
    email: email && EMAIL_RE.test(email) ? email : null,
    isGuest: u.is_restricted === true || u.is_ultra_restricted === true,
    largeAvatar: text(p.image_192, 2000) ?? text(p.image_512, 2000),
  };
}
