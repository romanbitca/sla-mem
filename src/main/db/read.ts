import fs from 'node:fs';
import type {
  ConversationDTO,
  ConversationType,
  MessageRevisionDTO,
  MessagesPage,
  StatsDTO,
  ThreadDTO,
  UserDTO,
} from '../../shared/types';
import { hydrateMessages } from './dto';
import { nonEmpty, userLabelOf, type UserNameColumns } from './labels';
import { parseStringArray } from './merge';
import { getMeta } from './meta';
import { stmt } from './stmt';
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

export function getStats(db: DB, opts: { filesDir?: string; dbPath?: string; now?: number } = {}): StatsDTO {
  const agg = stmt<{ messages: number; oldest: string | null; newest: string | null }>(
    db,
    'SELECT COALESCE(SUM(message_count), 0) AS messages, MIN(oldest_ts) AS oldest, MAX(latest_ts) AS newest FROM conversation_stats',
  ).get()!;
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
    beyondFreeWindowCount: beyondFreeWindow(db, agg.messages, opts.now ?? Date.now()),
  };
}

function count(db: DB, sql: string, ...params: unknown[]): number {
  return stmt<{ n: number }>(db, sql).get(...params)?.n ?? 0;
}

/** Counted as total minus the (small) recent window, so the time index scans only 90 days. */
function beyondFreeWindow(db: DB, total: number, now: number): number {
  const cutoff = Math.floor(now / 1000) - FREE_WINDOW_DAYS * 86400;
  return total - count(db, 'SELECT count(*) AS n FROM messages WHERE time >= ?', cutoff);
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

/** Custom emoji name → image URL, with `alias:` chains resolved. Aliases of standard emoji are omitted. */
export function listCustomEmoji(db: DB): Record<string, string> {
  const rows = stmt<{ name: string; url: string | null; alias_for: string | null }>(
    db,
    'SELECT name, url, alias_for FROM custom_emoji',
  ).all();
  const byName = new Map(rows.map((r) => [r.name, r]));
  const out: Record<string, string> = {};
  for (const row of rows) {
    const url = resolveEmojiUrl(row.name, byName);
    if (url) out[row.name] = url;
  }
  return out;
}

function resolveEmojiUrl(
  name: string,
  byName: Map<string, { url: string | null; alias_for: string | null }>,
): string | null {
  let current = byName.get(name);
  // Bounded walk: alias cycles in bad data must not hang the request.
  for (let hops = 0; current && hops < 10; hops++) {
    if (current.url) return current.url;
    if (!current.alias_for) return null;
    current = byName.get(current.alias_for);
  }
  return null;
}
