import fs from 'node:fs';
import type {
  BeyondFreeWindowDTO,
  ConversationDTO,
  ConversationType,
  MessageRevisionDTO,
  MessagesPage,
  StatsDTO,
  ThreadDTO,
  UserDTO,
} from '../../shared/types';
import { desegmentCjk } from './cjk';
import { hydrateMessages } from './dto';
import { nonEmpty, userLabelOf, type UserNameColumns } from './labels';
import { parseStringArray } from './merge';
import { getMeta } from './meta';
import { inList, stmt } from './stmt';
import type { DB } from './types';

// =============================================================================================
// Users
// =============================================================================================

interface UserRow extends UserNameColumns {
  avatar_url: string | null;
  is_bot: number;
  deleted: number;
}

export function listUsers(db: DB): UserDTO[] {
  return stmt<UserRow>(db, 'SELECT id, name, real_name, display_name, avatar_url, is_bot, deleted FROM users')
    .all()
    .map(userToDTO)
    .sort((a, b) => compareLabels(a.label, b.label));
}

function userToDTO(u: UserRow): UserDTO {
  return {
    id: u.id,
    name: nonEmpty(u.name) ?? u.id,
    realName: nonEmpty(u.real_name),
    displayName: nonEmpty(u.display_name),
    label: userLabelOf(u),
    avatarUrl: u.avatar_url,
    isBot: u.is_bot === 1,
    deleted: u.deleted === 1,
  };
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const compareLabels = (a: string, b: string) => collator.compare(a, b);

// =============================================================================================
// Conversations
// =============================================================================================

interface ConversationRow {
  id: string;
  type: ConversationType;
  name: string | null;
  dm_user_id: string | null;
  is_archived: number;
  topic: string | null;
  purpose: string | null;
  member_ids: string;
  message_count: number;
  oldest_ts: string | null;
  latest_ts: string | null;
  sync_error: string | null;
}

const SELECT_CONVERSATIONS = `
SELECT c.id, c.type, c.name, c.dm_user_id, c.is_archived, c.topic, c.purpose, c.member_ids,
  COALESCE(s.message_count, 0) AS message_count, s.oldest_ts, s.latest_ts, ss.last_error AS sync_error
FROM conversations c
LEFT JOIN conversation_stats s ON s.conversation_id = c.id
LEFT JOIN sync_state ss ON ss.conversation_id = c.id`;

interface LabelContext {
  userLabel(id: string): string;
  selfUserId: string | null;
  selfHandle: string | null;
}

function labelContext(db: DB): LabelContext {
  const labels = new Map<string, string>();
  const handles = new Map<string, string>();
  for (const u of stmt<UserNameColumns>(db, 'SELECT id, name, real_name, display_name FROM users').all()) {
    labels.set(u.id, userLabelOf(u));
    if (u.name) handles.set(u.id, u.name);
  }
  const selfUserId = getMeta(db, 'self_user_id');
  return {
    userLabel: (id) => labels.get(id) ?? id,
    selfUserId,
    selfHandle: selfUserId ? (handles.get(selfUserId) ?? null) : null,
  };
}

/** Channels by name, then DMs and group DMs by most recent activity. */
export function listConversations(db: DB): ConversationDTO[] {
  const ctx = labelContext(db);
  const dtos = stmt<ConversationRow>(db, SELECT_CONVERSATIONS)
    .all()
    .map((row) => conversationToDTO(row, ctx));
  return dtos.sort(compareConversations);
}

export function getConversation(db: DB, id: string): ConversationDTO | null {
  const row = stmt<ConversationRow>(db, `${SELECT_CONVERSATIONS} WHERE c.id = ?`).get(id);
  return row ? conversationToDTO(row, labelContext(db)) : null;
}

const isChannel = (t: ConversationType) => t === 'channel' || t === 'private_channel';

function compareConversations(a: ConversationDTO, b: ConversationDTO): number {
  const ac = isChannel(a.type);
  const bc = isChannel(b.type);
  if (ac !== bc) return ac ? -1 : 1;
  if (!ac) {
    const byRecency = Number(b.latestTs ?? 0) - Number(a.latestTs ?? 0);
    if (byRecency !== 0) return byRecency;
  }
  return compareLabels(a.label, b.label) || a.id.localeCompare(b.id);
}

function conversationToDTO(row: ConversationRow, ctx: LabelContext): ConversationDTO {
  const memberIds = parseStringArray(row.member_ids);
  return {
    id: row.id,
    type: row.type,
    label: conversationLabel(row, memberIds, ctx),
    rawName: row.type === 'im' ? null : row.name,
    dmUserId: row.dm_user_id,
    memberIds,
    isArchived: row.is_archived === 1,
    topic: row.topic,
    purpose: row.purpose,
    messageCount: row.message_count,
    latestTs: row.latest_ts,
    oldestTs: row.oldest_ts,
    syncError: row.sync_error,
  };
}

export function conversationLabel(
  row: Pick<ConversationRow, 'id' | 'type' | 'name' | 'dm_user_id'>,
  memberIds: string[],
  ctx: LabelContext,
): string {
  if (row.type === 'im') {
    if (row.dm_user_id) return row.dm_user_id === ctx.selfUserId ? 'You' : ctx.userLabel(row.dm_user_id);
    return othersLabel(memberIds, ctx) ?? row.id;
  }
  if (row.type === 'mpim') return othersLabel(memberIds, ctx) ?? mpimNameLabel(row.name, ctx.selfHandle) ?? row.id;
  return nonEmpty(row.name) ?? row.id;
}

function othersLabel(memberIds: string[], ctx: LabelContext): string | null {
  const others = memberIds.filter((m) => m !== ctx.selfUserId);
  return others.length ? others.map((m) => ctx.userLabel(m)).join(', ') : null;
}

/** Slack names group DMs `mpdm-alice--bob--carol-1`; used when member ids are unknown. */
function mpimNameLabel(name: string | null, selfHandle: string | null): string | null {
  if (!name?.startsWith('mpdm-')) return nonEmpty(name);
  const handles = name
    .slice('mpdm-'.length)
    .replace(/-\d+$/, '')
    .split('--')
    .filter((h) => h && h !== selfHandle);
  return handles.length ? handles.join(', ') : null;
}

// =============================================================================================
// Messages
// =============================================================================================

// Must match the partial index messages_conv_top_ts's WHERE clause verbatim so SQLite uses it.
const TOP_LEVEL = "(is_reply = 0 OR subtype = 'thread_broadcast')";

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export interface GetMessagesQuery {
  conversationId: string;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
}

export function getMessages(db: DB, q: GetMessagesQuery): MessagesPage {
  const limit = clampLimit(q.limit);
  const conv = q.conversationId;
  if (q.around) return aroundPage(db, conv, normalizeTs(q.around), limit);
  if (q.before) return beforePage(db, conv, normalizeTs(q.before), limit);
  if (q.after) return afterPage(db, conv, normalizeTs(q.after), limit);
  return latestPage(db, conv, limit);
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_PAGE;
  return Math.max(1, Math.min(MAX_PAGE, Math.floor(limit)));
}

/**
 * Stored ts always has 6 fractional digits; padding query values the same way keeps text
 * comparison (which the indexes use) equivalent to numeric comparison.
 */
export function normalizeTs(ts: string): string {
  const m = /^(\d+)(?:\.(\d{0,6})\d*)?$/.exec(ts.trim());
  if (!m) return ts;
  return `${m[1]}.${(m[2] ?? '').padEnd(6, '0')}`;
}

type Cmp = '<' | '<=' | '>' | '>=';

/** Top-level message ids on one side of `ts`, nearest first. */
function side(db: DB, conv: string, cmp: Cmp, ts: string, n: number): number[] {
  const order = cmp.startsWith('<') ? 'DESC' : 'ASC';
  return stmt<{ id: number }>(
    db,
    `SELECT id FROM messages WHERE conversation_id = ? AND ${TOP_LEVEL} AND ts ${cmp} ? ORDER BY ts ${order} LIMIT ?`,
  )
    .all(conv, ts, n)
    .map((r) => r.id);
}

function exists(db: DB, conv: string, cmp: Cmp, ts: string): boolean {
  return (
    stmt(db, `SELECT 1 FROM messages WHERE conversation_id = ? AND ${TOP_LEVEL} AND ts ${cmp} ? LIMIT 1`).get(
      conv,
      ts,
    ) !== undefined
  );
}

function page(db: DB, idsAscending: number[], hasMoreBefore: boolean, hasMoreAfter: boolean): MessagesPage {
  return { messages: hydrateMessages(db, idsAscending), hasMoreBefore, hasMoreAfter };
}

function latestPage(db: DB, conv: string, limit: number): MessagesPage {
  const ids = stmt<{ id: number }>(
    db,
    `SELECT id FROM messages WHERE conversation_id = ? AND ${TOP_LEVEL} ORDER BY ts DESC LIMIT ?`,
  )
    .all(conv, limit + 1)
    .map((r) => r.id);
  return page(db, ids.slice(0, limit).reverse(), ids.length > limit, false);
}

function beforePage(db: DB, conv: string, ts: string, limit: number): MessagesPage {
  const older = side(db, conv, '<', ts, limit + 1);
  return page(db, older.slice(0, limit).reverse(), older.length > limit, exists(db, conv, '>=', ts));
}

function afterPage(db: DB, conv: string, ts: string, limit: number): MessagesPage {
  const newer = side(db, conv, '>', ts, limit + 1);
  return page(db, newer.slice(0, limit), exists(db, conv, '<=', ts), newer.length > limit);
}

/**
 * About half the page on each side of the anchor, anchor included. When one side runs short the
 * other side fills the page so a jump near either end still shows a full screen.
 */
function aroundPage(db: DB, conv: string, ts: string, limit: number): MessagesPage {
  const anchor = anchorTs(db, conv, ts);
  const older = side(db, conv, '<', anchor, limit + 1);
  const newer = side(db, conv, '>=', anchor, limit + 1);
  const takeOlder = Math.min(older.length, Math.max(Math.floor(limit / 2), limit - newer.length));
  const takeNewer = Math.min(newer.length, limit - takeOlder);
  const ids = [...older.slice(0, takeOlder).reverse(), ...newer.slice(0, takeNewer)];
  return page(db, ids, older.length > takeOlder, newer.length > takeNewer);
}

/** A plain thread reply isn't in the channel view, so jumping to it centers on its parent. */
function anchorTs(db: DB, conv: string, ts: string): string {
  const row = stmt<{ thread_ts: string | null; is_reply: number; subtype: string | null }>(
    db,
    'SELECT thread_ts, is_reply, subtype FROM messages WHERE conversation_id = ? AND ts = ?',
  ).get(conv, ts);
  if (row && row.is_reply === 1 && row.subtype !== 'thread_broadcast' && row.thread_ts) return row.thread_ts;
  return ts;
}

export function getThread(db: DB, conversationId: string, threadTs: string): ThreadDTO {
  const root = threadRootTs(db, conversationId, normalizeTs(threadTs));
  const parent = stmt<{ id: number }>(db, 'SELECT id FROM messages WHERE conversation_id = ? AND ts = ?').get(
    conversationId,
    root,
  );
  const replyIds = stmt<{ id: number }>(
    db,
    'SELECT id FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts <> ? ORDER BY ts',
  )
    .all(conversationId, root, root)
    .map((r) => r.id);
  return {
    parent: parent ? (hydrateMessages(db, [parent.id])[0] ?? null) : null,
    replies: hydrateMessages(db, replyIds),
  };
}

/** Accepts a reply's ts too (deep links carry either), resolving it to the thread root. */
function threadRootTs(db: DB, conv: string, ts: string): string {
  const row = stmt<{ thread_ts: string | null }>(
    db,
    'SELECT thread_ts FROM messages WHERE conversation_id = ? AND ts = ?',
  ).get(conv, ts);
  return row?.thread_ts ?? ts;
}

export function getMessageRevisions(db: DB, conversationId: string, ts: string): MessageRevisionDTO[] {
  return stmt<{ text: string; edited_ts: string | null; seen_at: number }>(
    db,
    'SELECT text, edited_ts, seen_at FROM message_revisions WHERE conversation_id = ? AND ts = ? ORDER BY id',
  )
    .all(conversationId, normalizeTs(ts))
    .map((r) => ({ text: r.text, editedTs: r.edited_ts, seenAt: r.seen_at }));
}

// =============================================================================================
// Stats, emoji
// =============================================================================================

/** Slack Free hides messages older than this. */
export const FREE_WINDOW_DAYS = 90;

/** Unix seconds before which a message is older than Slack Free's window. */
function freeWindowCutoff(now: number): number {
  return Math.floor(now / 1000) - FREE_WINDOW_DAYS * 86400;
}

/** One conversation's messages Slack Free no longer shows (the conversation header's count). */
export function conversationBeyondFreeWindow(db: DB, conversationId: string, now = Date.now()): BeyondFreeWindowDTO {
  // min/max of `time` come straight from the (conversation_id, time) index.
  const row = stmt<{ n: number; oldest: number | null; newest: number | null }>(
    db,
    'SELECT count(*) AS n, min(time) AS oldest, max(time) AS newest FROM messages WHERE conversation_id = ? AND time < ?',
  ).get(conversationId, freeWindowCutoff(now))!;
  return { count: row.n, oldest: row.oldest, newest: row.newest };
}

export function getStats(db: DB, opts: { filesDir?: string; dbPath?: string; now?: number } = {}): StatsDTO {
  const agg = stmt<{ messages: number; oldest: string | null; newest: string | null }>(
    db,
    'SELECT COALESCE(SUM(message_count), 0) AS messages, MIN(oldest_ts) AS oldest, MAX(latest_ts) AS newest FROM conversation_stats',
  ).get()!;
  const oldestConversation = stmt<{ id: string }>(
    db,
    'SELECT conversation_id AS id FROM conversation_stats WHERE oldest_ts IS NOT NULL ORDER BY oldest_ts LIMIT 1',
  ).get();
  const files = stmt<{ total: number; done: number; bytes: number }>(
    db,
    `SELECT count(*) AS total, COALESCE(SUM(download_status = 'done'), 0) AS done,
       COALESCE(SUM(CASE WHEN download_status = 'done' THEN size END), 0) AS bytes FROM files`,
  ).get()!;
  return {
    messageCount: agg.messages,
    conversationCount: count(db, 'SELECT count(*) AS n FROM conversations'),
    userCount: count(db, 'SELECT count(*) AS n FROM users'),
    fileCount: files.total,
    filesDownloaded: files.done,
    filesBytes: files.bytes,
    dbBytes: databaseBytes(db, opts.dbPath),
    oldestTs: agg.oldest,
    newestTs: agg.newest,
    oldestConversationId: oldestConversation?.id ?? null,
    mainStart: mainStart(db, agg.messages, agg.oldest, agg.newest),
    beyondFreeWindowCount: beyondFreeWindow(db, agg.messages, opts.now ?? Date.now()),
  };
}

function count(db: DB, sql: string, ...params: unknown[]): number {
  return stmt<{ n: number }>(db, sql).get(...params)?.n ?? 0;
}

/** Counted as total minus the (small) recent window, so the time index scans only 90 days. */
function beyondFreeWindow(db: DB, total: number, now: number): number {
  return total - count(db, 'SELECT count(*) AS n FROM messages WHERE time >= ?', freeWindowCutoff(now));
}

/** Too few messages for "most of the archive" to mean anything. */
const MAIN_START_MIN_MESSAGES = 200;
/** "Most of the archive": everything but its oldest 1%. */
const MAIN_START_TAIL = 0.01;
/** Walking back from there, a quiet spell this long (longer than a weekend) ends the steady history. */
const MAIN_START_GAP_SECONDS = 4 * 86400;

/**
 * Slack still shows a few messages past its 90 days (notes to yourself, thread starters with
 * recent replies), so a first sync can reach months further back for a handful of messages. Then
 * "Mar 18 – Sep 22" would describe the archive badly. This finds where the steady history starts:
 * from the point all but the oldest 1% of messages follow, back through messages that follow each
 * other closely, to the local day of the first of them. It says so only when the few older ones
 * stretch the range by over a month and over a quarter.
 */
function mainStart(db: DB, total: number, oldestTs: string | null, newestTs: string | null): StatsDTO['mainStart'] {
  if (total < MAIN_START_MIN_MESSAGES || !oldestTs || !newestTs) return null;
  const oldest = Math.floor(Number(oldestTs));
  const newest = Math.floor(Number(newestTs));
  if (!Number.isFinite(oldest) || !Number.isFinite(newest)) return null;
  const tail = Math.floor(total * MAIN_START_TAIL);
  const row = stmt<{ time: number }>(db, 'SELECT time FROM messages ORDER BY time LIMIT 1 OFFSET ?').get(tail);
  if (!row) return null;
  let first = row.time;
  // At most the oldest 1%: few rows, read newest first until the first long silence.
  for (const { time } of stmt<{ time: number }>(
    db,
    'SELECT time FROM messages WHERE time < ? ORDER BY time DESC LIMIT ?',
  ).all(first, tail)) {
    if (first - time >= MAIN_START_GAP_SECONDS) break;
    first = time;
  }
  const day = new Date(first * 1000);
  day.setHours(0, 0, 0, 0);
  const start = Math.floor(day.getTime() / 1000);
  const stretch = start - oldest;
  if (stretch < 30 * 86400 || stretch < (newest - oldest) / 4) return null;
  const olderCount = count(db, 'SELECT count(*) AS n FROM messages WHERE time < ?', start);
  return olderCount > 0 ? { ts: `${start}.000000`, olderCount } : null;
}

function databaseBytes(db: DB, dbPath?: string): number {
  const file = dbPath ?? (db.memory ? null : db.name);
  if (file) {
    const size = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const onDisk = size(file) + size(`${file}-wal`);
    if (onDisk > 0) return onDisk;
  }
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return pageCount * pageSize;
}

/**
 * Custom emoji name → image URL, with `alias:` chains resolved. An alias that ends at a name with
 * no image (a standard emoji, e.g. `yay → alias:tada`) is returned as `alias:<name>` so the
 * renderer shows the standard emoji instead of the literal `:yay:` (pitfall 17).
 */
export function listCustomEmoji(db: DB): Record<string, string> {
  const rows = stmt<{ name: string; url: string | null; alias_for: string | null }>(
    db,
    'SELECT name, url, alias_for FROM custom_emoji',
  ).all();
  const byName = new Map(rows.map((r) => [r.name, r]));
  const out: Record<string, string> = {};
  for (const row of rows) {
    const target = resolveEmoji(row.name, byName);
    if (target) out[row.name] = target;
  }
  return out;
}

function resolveEmoji(
  name: string,
  byName: Map<string, { url: string | null; alias_for: string | null }>,
): string | null {
  let current = byName.get(name);
  let last = name;
  // Bounded walk: alias cycles in bad data must not hang the request.
  for (let hops = 0; current && hops < 10; hops++) {
    if (current.url) return current.url;
    if (!current.alias_for) return null;
    last = current.alias_for;
    current = byName.get(current.alias_for);
  }
  return current ? null : `alias:${last}`;
}

// =============================================================================================
// Reading for Ask AI: whole stretches of a conversation, and where the activity was
// =============================================================================================

/** A stored ts for the start of a second, comparable with stored ts as text (they share a width). */
export function tsAtSecond(epochSeconds: number): string {
  return `${Math.floor(epochSeconds)}.000000`;
}

export interface TopLevelRow {
  id: number;
  ts: string;
  replyCount: number;
}

/**
 * A conversation's top-level messages with `after <= ts < before` (either bound optional): the
 * oldest `limit` of them, or with `latest` the newest `limit`. Either way in ascending order.
 */
export function topLevelInRange(
  db: DB,
  conversationId: string,
  opts: { after?: string | null; before?: string | null; limit: number; latest?: boolean },
): { rows: TopLevelRow[]; more: boolean } {
  const conditions = ['conversation_id = ?', TOP_LEVEL];
  const params: unknown[] = [conversationId];
  if (opts.after) {
    conditions.push('ts >= ?');
    params.push(normalizeTs(opts.after));
  }
  if (opts.before) {
    conditions.push('ts < ?');
    params.push(normalizeTs(opts.before));
  }
  const rows = stmt<{ id: number; ts: string; reply_count: number }>(
    db,
    `SELECT id, ts, reply_count FROM messages WHERE ${conditions.join(' AND ')}
     ORDER BY ts ${opts.latest ? 'DESC' : 'ASC'} LIMIT ?`,
  )
    .all(...params, opts.limit + 1)
    .map((r) => ({ id: r.id, ts: r.ts, replyCount: r.reply_count }));
  const more = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit);
  return { rows: opts.latest ? page.reverse() : page, more };
}

/** Row ids of a thread's replies (parent excluded), oldest first, and how many there are. */
export function threadReplies(
  db: DB,
  conversationId: string,
  threadTs: string,
  limit: number,
): { ids: number[]; total: number } {
  const root = normalizeTs(threadTs);
  const ids = stmt<{ id: number }>(
    db,
    'SELECT id FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts <> ? ORDER BY ts LIMIT ?',
  )
    .all(conversationId, root, root, limit)
    .map((r) => r.id);
  const total =
    ids.length < limit
      ? ids.length
      : count(
          db,
          'SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts <> ?',
          conversationId,
          root,
          root,
        );
  return { ids, total };
}

/** Row ids of messages by conversation and ts (unknown ones are left out), in the given order. */
export function messageRowIds(db: DB, messages: readonly { conversationId: string; ts: string }[]): number[] {
  const byKey = stmt<{ id: number }>(db, 'SELECT id FROM messages WHERE conversation_id = ? AND ts = ?');
  return messages.flatMap((m) => {
    const row = byKey.get(m.conversationId, normalizeTs(m.ts));
    return row ? [row.id] : [];
  });
}

/**
 * The search text of messages by row id: mentions resolved to names, markup gone, attachment and
 * file names included, Chinese and Japanese without their search spacing.
 */
export function plainTexts(db: DB, ids: readonly number[]): Map<number, string> {
  if (!ids.length) return new Map();
  const rows = stmt<{ id: number; plain_text: string }>(
    db,
    'SELECT id, plain_text FROM messages WHERE id IN (SELECT value FROM json_each(?))',
  ).all(JSON.stringify(ids));
  return new Map(rows.map((r) => [r.id, desegmentCjk(r.plain_text)]));
}

export interface ConversationActivity {
  conversationId: string;
  messages: number;
  latestTs: string | null;
}

/**
 * How many messages each conversation has with `after <= time < before` (epoch seconds, either
 * optional), by `userIds` when given, busiest first. With neither this is the kept totals, not a
 * scan.
 */
export function conversationActivity(
  db: DB,
  opts: { after?: number | null; before?: number | null; userIds?: readonly string[]; limit: number },
): ConversationActivity[] {
  const users = opts.userIds ?? [];
  if (opts.after == null && opts.before == null && !users.length) {
    return stmt<ConversationActivity>(
      db,
      `SELECT conversation_id AS conversationId, message_count AS messages, latest_ts AS latestTs
       FROM conversation_stats WHERE message_count > 0 ORDER BY message_count DESC LIMIT ?`,
    ).all(opts.limit);
  }
  const by = users.length ? inList('user_id', users) : null;
  return stmt<ConversationActivity>(
    db,
    `SELECT conversation_id AS conversationId, count(*) AS messages, max(ts) AS latestTs
     FROM messages WHERE time >= ? AND time < ?${by ? ` AND ${by.sql}` : ''}
     GROUP BY conversation_id ORDER BY messages DESC, latestTs DESC LIMIT ?`,
  ).all(opts.after ?? 0, opts.before ?? Number.MAX_SAFE_INTEGER, ...(by?.params ?? []), opts.limit);
}
