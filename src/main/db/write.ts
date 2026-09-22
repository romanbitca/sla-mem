import fs from 'node:fs';
import path from 'node:path';
import type { SlackConversation, SlackFile, SlackMessage, SlackUser } from '../slack/types';
import type { ConversationType } from '../../shared/types';
import { dbResolvers, nonEmpty, preloadedResolvers } from './labels';
import type { NormalizeResolvers } from './normalize';
import {
  compareTs,
  isTombstone,
  isValidTs,
  mergeMessageRow,
  newMessageRow,
  plainTextFor,
  tsToMicros,
  type MessageColumns,
  type RevisionToStore,
} from './merge';
import { getMeta, setMeta } from './meta';
import { stmt } from './stmt';
import type { DB, FileRow, FileSkipReason, MessageRow, MessageSource, SyncStatePatch, SyncStateRow } from './types';

// =============================================================================================
// Users
// =============================================================================================

const UPSERT_USER = `
INSERT INTO users (id, team_id, name, real_name, display_name, avatar_url, is_bot, deleted, raw, updated_at)
VALUES (@id, @team_id, @name, @real_name, @display_name, @avatar_url, @is_bot, @deleted, @raw, @updated_at)
ON CONFLICT (id) DO UPDATE SET
  team_id = COALESCE(excluded.team_id, users.team_id),
  name = COALESCE(excluded.name, users.name),
  real_name = COALESCE(excluded.real_name, users.real_name),
  display_name = COALESCE(excluded.display_name, users.display_name),
  avatar_url = COALESCE(excluded.avatar_url, users.avatar_url),
  is_bot = excluded.is_bot,
  deleted = excluded.deleted,
  raw = excluded.raw,
  updated_at = excluded.updated_at
WHERE users.raw IS NOT excluded.raw`;

/** Inserts or refreshes users. Name fields are never blanked by a sparser source. */
export function upsertUsers(db: DB, users: SlackUser[]): number {
  const now = Date.now();
  let count = 0;
  db.transaction(() => {
    for (const u of users) {
      if (!u || typeof u.id !== 'string' || !u.id) continue;
      stmt(db, UPSERT_USER).run(userParams(u, now));
      count++;
    }
  })();
  return count;
}

function userParams(u: SlackUser, now: number): Record<string, unknown> {
  const profile = u.profile ?? {};
  return {
    id: u.id,
    team_id: u.team_id ?? null,
    name: nonEmpty(u.name),
    real_name: nonEmpty(u.real_name) ?? nonEmpty(profile.real_name),
    display_name: nonEmpty(profile.display_name),
    avatar_url: nonEmpty(profile.image_72) ?? nonEmpty(profile.image_48) ?? nonEmpty(profile.image_192),
    is_bot: u.is_bot || u.id === 'USLACKBOT' ? 1 : 0,
    deleted: u.deleted ? 1 : 0,
    raw: JSON.stringify(u),
    updated_at: now,
  };
}

// =============================================================================================
// Conversations
// =============================================================================================

// Only fields the incoming object actually carries are applied, so an export listing (no flags,
// no is_member) can't downgrade what the API told us, and vice versa.
const UPSERT_CONVERSATION = `
INSERT INTO conversations (id, type, name, dm_user_id, is_archived, is_member, topic, purpose, created, member_ids, raw, updated_at)
VALUES (@id, @type, @name, @dm_user_id, COALESCE(@is_archived, 0), COALESCE(@is_member, 1), @topic, @purpose,
        @created, COALESCE(@member_ids, '[]'), @raw, @updated_at)
ON CONFLICT (id) DO UPDATE SET
  type = CASE WHEN @type_explicit THEN excluded.type ELSE conversations.type END,
  name = COALESCE(excluded.name, conversations.name),
  dm_user_id = COALESCE(excluded.dm_user_id, conversations.dm_user_id),
  is_archived = COALESCE(@is_archived, conversations.is_archived),
  is_member = COALESCE(@is_member, conversations.is_member),
  topic = CASE WHEN @has_topic THEN excluded.topic ELSE conversations.topic END,
  purpose = CASE WHEN @has_purpose THEN excluded.purpose ELSE conversations.purpose END,
  created = COALESCE(excluded.created, conversations.created),
  member_ids = COALESCE(@member_ids, conversations.member_ids),
  raw = json_patch(conversations.raw, excluded.raw),
  updated_at = excluded.updated_at`;

export function upsertConversations(db: DB, convs: SlackConversation[], opts: { selfUserId?: string } = {}): number {
  const selfUserId = opts.selfUserId ?? getMeta(db, 'self_user_id');
  const now = Date.now();
  let count = 0;
  db.transaction(() => {
    for (const c of convs) {
      if (!c || typeof c.id !== 'string' || !c.id) continue;
      stmt(db, UPSERT_CONVERSATION).run(conversationParams(c, selfUserId, now));
      count++;
    }
  })();
  return count;
}

export function conversationTypeOf(c: SlackConversation): { type: ConversationType; explicit: boolean } {
  if (c.is_im) return { type: 'im', explicit: true };
  if (c.is_mpim) return { type: 'mpim', explicit: true };
  if (c.is_private || c.is_group) return { type: 'private_channel', explicit: true };
  if (c.is_channel) return { type: 'channel', explicit: true };
  // No flags (e.g. an unlisted export folder): guess from the id prefix, but don't let the guess
  // overwrite a type we already know.
  if (c.id.startsWith('D')) return { type: 'im', explicit: false };
  if (c.id.startsWith('G')) return { type: 'private_channel', explicit: false };
  return { type: 'channel', explicit: false };
}

function conversationParams(c: SlackConversation, selfUserId: string | null, now: number): Record<string, unknown> {
  const { type, explicit } = conversationTypeOf(c);
  const members = Array.isArray(c.members) ? c.members.filter((m) => typeof m === 'string') : null;
  return {
    id: c.id,
    type,
    type_explicit: explicit ? 1 : 0,
    name: type === 'im' ? null : nonEmpty(c.name),
    dm_user_id: type === 'im' ? dmUserOf(c, members, selfUserId) : null,
    is_archived: typeof c.is_archived === 'boolean' ? Number(c.is_archived) : null,
    is_member: typeof c.is_member === 'boolean' ? Number(c.is_member) : null,
    has_topic: c.topic ? 1 : 0,
    topic: nonEmpty(c.topic?.value),
    has_purpose: c.purpose ? 1 : 0,
    purpose: nonEmpty(c.purpose?.value),
    created: typeof c.created === 'number' ? c.created : null,
    member_ids: members ? JSON.stringify(members) : null,
    raw: JSON.stringify(c),
    updated_at: now,
  };
}

/** The other participant of an IM; the self user when it's a self-DM. */
function dmUserOf(c: SlackConversation, members: string[] | null, selfUserId: string | null): string | null {
  if (typeof c.user === 'string' && c.user) return c.user;
  if (!members?.length) return null;
  if (selfUserId) return members.find((m) => m !== selfUserId) ?? selfUserId;
  return members.length === 1 ? members[0] : null;
}

// =============================================================================================
// Messages
// =============================================================================================

const MESSAGE_COLUMNS: readonly (keyof MessageColumns)[] = [
  'conversation_id',
  'ts',
  'time',
  'thread_ts',
  'is_reply',
  'user_id',
  'bot_id',
  'username',
  'subtype',
  'text',
  'plain_text',
  'reply_count',
  'latest_reply',
  'reply_users',
  'edited_ts',
  'has_files',
  'has_links',
  'has_images',
  'reactions',
  'is_deleted',
  'raw',
  'source',
  'first_seen_at',
  'updated_at',
];

const INSERT_MESSAGE = `INSERT INTO messages (id, ${MESSAGE_COLUMNS.join(', ')})
VALUES (@id, ${MESSAGE_COLUMNS.map((c) => '@' + c).join(', ')})`;

const UPDATE_MESSAGE = `UPDATE messages SET ${MESSAGE_COLUMNS.filter((c) => c !== 'conversation_id' && c !== 'ts')
  .map((c) => `${c} = @${c}`)
  .join(', ')} WHERE id = @id`;

const SELECT_MESSAGE = 'SELECT * FROM messages WHERE conversation_id = ? AND ts = ?';

const INSERT_REVISION =
  'INSERT INTO message_revisions (conversation_id, ts, text, edited_ts, seen_at) VALUES (?, ?, ?, ?, ?)';

export interface UpsertMessagesResult {
  inserted: number;
  updated: number;
  revisions: number;
  /** Messages dropped for a missing or malformed ts (pitfall 4: skipped, never fatal). */
  skipped: number;
}

/**
 * Inserts/merges a batch of messages of one conversation in a single transaction, following the
 * archive merge policy (never delete, keep content on tombstones, record revisions, reply
 * metadata only grows). `updated` counts rows whose stored content actually changed.
 *
 * `opts.filesDir` is where downloaded files live; it's used to decide whether a `done` file whose
 * local copy vanished may be re-queued. Without it, stored downloads are assumed intact.
 */
export function upsertMessages(
  db: DB,
  conversationId: string,
  msgs: SlackMessage[],
  source: MessageSource,
  opts: { filesDir?: string } = {},
): UpsertMessagesResult {
  const resolvers = dbResolvers(db);
  const filesDir = opts.filesDir ?? null;
  // Ascending ts keeps FTS5 appending: it flushes its pending buffer whenever a rowid goes
  // backwards, and API history pages arrive newest-first. Stable sort keeps same-ts order.
  const ordered = msgs
    .filter((m): m is SlackMessage => Boolean(m) && typeof m === 'object' && isValidTs(m.ts))
    .sort((a, b) => compareTs(a.ts, b.ts));
  const result: UpsertMessagesResult = { inserted: 0, updated: 0, revisions: 0, skipped: msgs.length - ordered.length };
  db.transaction(() => {
    for (const msg of ordered) {
      const now = Date.now();
      const stored = stmt<MessageRow>(db, SELECT_MESSAGE).get(conversationId, msg.ts);
      if (!stored) {
        const row = newMessageRow(conversationId, msg, source, now, resolvers);
        stmt(db, INSERT_MESSAGE).run({ ...row, id: allocateMessageId(db, msg.ts) });
        result.inserted++;
      } else {
        const merged = mergeMessageRow(stored, msg, source, now, resolvers);
        if (merged.revision) {
          insertRevision(db, stored, merged.revision);
          result.revisions++;
        }
        if (merged.changed) {
          stmt(db, UPDATE_MESSAGE).run({ ...merged.row, id: stored.id });
          result.updated++;
        }
      }
      // Tombstones carry only file placeholders; whatever files we archived stay linked.
      if (!isTombstone(msg)) upsertMessageFiles(db, conversationId, msg, now, filesDir);
      if (typeof msg.bot_id === 'string' && msg.bot_id) upsertBot(db, msg, now);
    }
  })();
  return result;
}

const UPSERT_BOT = `
INSERT INTO bots (id, name, icon_url, app_id, user_id, updated_at) VALUES (@id, @name, @icon_url, @app_id, @user_id, @now)
ON CONFLICT (id) DO UPDATE SET
  name = COALESCE(excluded.name, bots.name), icon_url = COALESCE(excluded.icon_url, bots.icon_url),
  app_id = COALESCE(excluded.app_id, bots.app_id), user_id = COALESCE(excluded.user_id, bots.user_id),
  updated_at = excluded.updated_at
WHERE bots.name IS NOT COALESCE(excluded.name, bots.name) OR bots.icon_url IS NOT COALESCE(excluded.icon_url, bots.icon_url)
  OR bots.app_id IS NOT COALESCE(excluded.app_id, bots.app_id) OR bots.user_id IS NOT COALESCE(excluded.user_id, bots.user_id)`;

/** Remembers integrations by bot_id so `from:github` finds messages that carry no user id. */
function upsertBot(db: DB, msg: SlackMessage, now: number): void {
  const profile = msg.bot_profile ?? {};
  const icons = (profile.icons ?? msg.icons ?? {}) as Record<string, unknown>;
  const icon = [icons.image_48, icons.image_72, icons.image_36].find(
    (v): v is string => typeof v === 'string' && v !== '',
  );
  stmt(db, UPSERT_BOT).run({
    id: msg.bot_id,
    name: nonEmpty(profile.name) ?? nonEmpty(msg.username),
    icon_url: icon ?? null,
    app_id: nonEmpty(profile.app_id as string | undefined),
    user_id: nonEmpty(msg.user),
    now,
  });
}

/**
 * Message ids are the ts in microseconds, so FTS5 rowid order is chronological: search can sort
 * newest/oldest and apply its recency tie-break without joining every match to `messages`.
 * Two conversations can share a ts; the later one takes the next free microsecond (ordering is
 * then off by at most a few µs between those messages, which is harmless).
 */
export function allocateMessageId(db: DB, ts: string): number {
  let id = tsToMicros(ts);
  while (stmt(db, 'SELECT 1 FROM messages WHERE id = ?').get(id) !== undefined) id++;
  return id;
}

function insertRevision(db: DB, stored: MessageRow, rev: RevisionToStore): void {
  stmt(db, INSERT_REVISION).run(stored.conversation_id, stored.ts, rev.text, rev.edited_ts, rev.seen_at);
}

// =============================================================================================
// Files
// =============================================================================================

const INSERT_FILE = `
INSERT INTO files (id, name, title, mimetype, filetype, size, url_private, url_private_download, permalink,
  thumb_url, width, height, download_status, created, user_id, raw, updated_at)
VALUES (@id, @name, @title, @mimetype, @filetype, @size, @url_private, @url_private_download, @permalink,
  @thumb_url, @width, @height, @download_status, @created, @user_id, @raw, @updated_at)`;

// Metadata missing from the incoming copy keeps the stored value; download bookkeeping
// (local paths, attempts, errors) is owned by the downloader and never touched here.
const UPDATE_FILE = `
UPDATE files SET
  name = COALESCE(@name, name), title = COALESCE(@title, title), mimetype = COALESCE(@mimetype, mimetype),
  filetype = COALESCE(@filetype, filetype), size = COALESCE(@size, size),
  url_private = COALESCE(@url_private, url_private),
  url_private_download = COALESCE(@url_private_download, url_private_download),
  permalink = COALESCE(@permalink, permalink), thumb_url = COALESCE(@thumb_url, thumb_url),
  width = COALESCE(@width, width), height = COALESCE(@height, height),
  created = COALESCE(@created, created), user_id = COALESCE(@user_id, user_id),
  download_status = @download_status, raw = @raw, updated_at = @updated_at
WHERE id = @id`;

const LINK_FILE = `
INSERT INTO message_files (conversation_id, ts, file_id, position) VALUES (?, ?, ?, ?)
ON CONFLICT (conversation_id, ts, file_id) DO UPDATE SET position = excluded.position
WHERE message_files.position IS NOT excluded.position`;

const UNUSABLE_MODES = new Set(['hidden_by_limit', 'tombstone']);

/** Free-plan stubs and deleted-file placeholders carry no content worth storing over a real row. */
export function isUsableFile(f: SlackFile): boolean {
  if (typeof f.mode === 'string' && UNUSABLE_MODES.has(f.mode)) return false;
  return Boolean(f.url_private || f.name);
}

function isExternalFile(f: SlackFile): boolean {
  return f.mode === 'external' || f.is_external === true;
}

function upsertMessageFiles(
  db: DB,
  conversationId: string,
  msg: SlackMessage,
  now: number,
  filesDir: string | null,
): void {
  const files = Array.isArray(msg.files) ? msg.files : [];
  files.forEach((f, position) => {
    if (!f || typeof f.id !== 'string' || !f.id) return;
    upsertFile(db, f, now, filesDir);
    stmt(db, LINK_FILE).run(conversationId, msg.ts, f.id, position);
  });
}

function upsertFile(db: DB, f: SlackFile, now: number, filesDir: string | null): void {
  const stored = getFileRow(db, f.id);
  if (!isUsableFile(f)) {
    // Stub protection (PLAN §5.6): never overwrite a good record; insert only if absent.
    if (!stored) stmt(db, INSERT_FILE).run(fileParams(f, 'unavailable', now));
    return;
  }
  if (!stored) {
    stmt(db, INSERT_FILE).run(fileParams(f, isExternalFile(f) ? 'unavailable' : 'pending', now));
    return;
  }
  const status = nextFileStatus(stored, f, filesDir);
  const raw = JSON.stringify(f);
  if (stored.raw === raw && stored.download_status === status) return;
  stmt(db, UPDATE_FILE).run(fileParams(f, status, now));
}

/** A finished download stays `done` unless its local copy is gone. */
function nextFileStatus(stored: FileRow, f: SlackFile, filesDir: string | null): FileRow['download_status'] {
  const fetchable = isExternalFile(f) ? 'unavailable' : 'pending';
  switch (stored.download_status) {
    case 'done':
      return localCopyExists(stored.local_path, filesDir) ? 'done' : fetchable;
    case 'unavailable':
      return fetchable;
    default:
      return stored.download_status;
  }
}

function localCopyExists(localPath: string | null, filesDir: string | null): boolean {
  if (localPath == null) return false;
  if (filesDir == null) return true;
  return fs.existsSync(path.resolve(filesDir, localPath));
}

function bestThumb(f: SlackFile): string | null {
  return (
    nonEmpty(f.thumb_720) ??
    nonEmpty(f.thumb_480) ??
    nonEmpty(f.thumb_360) ??
    nonEmpty(f.thumb_pdf) ??
    nonEmpty(f.thumb_video)
  );
}

function fileParams(f: SlackFile, status: FileRow['download_status'], now: number): Record<string, unknown> {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: f.id,
    name: nonEmpty(f.name),
    title: nonEmpty(f.title),
    mimetype: nonEmpty(f.mimetype),
    filetype: nonEmpty(f.filetype),
    size: num(f.size),
    url_private: nonEmpty(f.url_private),
    url_private_download: nonEmpty(f.url_private_download),
    permalink: nonEmpty(f.permalink),
    thumb_url: bestThumb(f),
    width: num(f.original_w),
    height: num(f.original_h),
    download_status: status,
    created: num(f.created) ?? num(f.timestamp),
    user_id: nonEmpty(f.user),
    raw: JSON.stringify(f),
    updated_at: now,
  };
}

export function getFileRow(db: DB, id: string): FileRow | null {
  return stmt<FileRow>(db, 'SELECT * FROM files WHERE id = ?').get(id) ?? null;
}

/**
 * Files the downloader should look at, oldest first (on the Free plan the oldest are the next to
 * disappear from Slack): pending ones, failed ones whose backoff has passed, and ones skipped by
 * the attachment policy or size limit, which the downloader re-checks against the current policy
 * so raising the limit brings them back (PLAN §5.6; pitfall 7). Files the user removed to free
 * space, and rows without any URL, are left alone.
 */
export function listDownloadCandidates(
  db: DB,
  opts: { now?: number; limit?: number; excludedConversationIds?: readonly string[] } = {},
): FileRow[] {
  const now = opts.now ?? Date.now();
  const limit = opts.limit != null && opts.limit > 0 ? Math.floor(opts.limit) : -1;
  // A file shared only in conversations the user chose not to archive isn't downloaded; one also
  // shared somewhere archived (or linked to no message at all) still is.
  return stmt<FileRow>(
    db,
    `SELECT * FROM files f
     WHERE (download_status = 'pending'
         OR (download_status = 'failed' AND COALESCE(next_attempt_at, 0) <= ?)
         OR (download_status = 'skipped' AND COALESCE(skip_reason, 'policy') <> 'removed'))
       AND (url_private_download IS NOT NULL OR url_private IS NOT NULL)
       AND (NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id)
         OR EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id
                      AND mf.conversation_id NOT IN (SELECT value FROM json_each(?))))
     ORDER BY created IS NULL, created, id LIMIT ?`,
  ).all(now, JSON.stringify(opts.excludedConversationIds ?? []), limit);
}

/** `thumbLocalPath`: undefined keeps the stored thumb, null clears it. Paths are relative to filesDir. */
export function markFileDownloaded(db: DB, id: string, localPath: string, thumbLocalPath?: string | null): void {
  stmt(
    db,
    `UPDATE files SET download_status = 'done', local_path = ?,
       thumb_local_path = CASE WHEN ? THEN ? ELSE thumb_local_path END,
       download_error = NULL, skip_reason = NULL, next_attempt_at = NULL,
       download_attempts = download_attempts + 1, updated_at = ?
     WHERE id = ?`,
  ).run(localPath, thumbLocalPath === undefined ? 0 : 1, thumbLocalPath ?? null, Date.now(), id);
}

/** Records only a thumbnail (e.g. for a video skipped by the policy, so it still has a preview). */
export function setFileThumb(db: DB, id: string, thumbLocalPath: string): void {
  stmt(db, 'UPDATE files SET thumb_local_path = ?, updated_at = ? WHERE id = ?').run(thumbLocalPath, Date.now(), id);
}

/** Retry delay after the nth consecutive failure: 1 h, 2 h, 4 h … capped at 7 days. Never "never". */
export function failureBackoffMs(attempts: number): number {
  const hours = 2 ** Math.max(0, Math.min(attempts - 1, 20));
  return Math.min(hours * 3_600_000, 7 * 86_400_000);
}

export function markFileFailed(db: DB, id: string, error: string, now: number = Date.now()): void {
  const row = stmt<{ download_attempts: number }>(db, 'SELECT download_attempts FROM files WHERE id = ?').get(id);
  const attempts = (row?.download_attempts ?? 0) + 1;
  stmt(
    db,
    `UPDATE files SET download_status = 'failed', download_error = ?, download_attempts = ?,
       next_attempt_at = ?, skip_reason = NULL, updated_at = ? WHERE id = ?`,
  ).run(error, attempts, now + failureBackoffMs(attempts), now, id);
}

export function markFileSkipped(db: DB, id: string, reason: FileSkipReason, detail: string): void {
  stmt(
    db,
    `UPDATE files SET download_status = 'skipped', skip_reason = ?, download_error = ?, updated_at = ?
     WHERE id = ? AND (download_status IS NOT 'skipped' OR skip_reason IS NOT ? OR download_error IS NOT ?)`,
  ).run(reason, detail, Date.now(), id, reason, detail);
}

export function markFileUnavailable(db: DB, id: string, detail: string): void {
  stmt(
    db,
    `UPDATE files SET download_status = 'unavailable', download_error = ?, skip_reason = NULL,
       next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(detail, Date.now(), id);
}

/** "Retry" from the UI: the file becomes pending right away, whatever its backoff or skip reason. */
export function requeueFile(db: DB, id: string): boolean {
  const info = stmt(
    db,
    `UPDATE files SET download_status = 'pending', skip_reason = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE id = ? AND download_status IN ('failed', 'skipped', 'unavailable')`,
  ).run(Date.now(), id);
  return info.changes > 0;
}

/**
 * Downloaded files created before `beforeSeconds` (unix seconds), for "Delete downloaded
 * attachments older than…". Thumbnails are kept: they're small and keep the message readable.
 */
export function listDownloadedFilesBefore(db: DB, beforeSeconds: number): FileRow[] {
  return stmt<FileRow>(
    db,
    `SELECT * FROM files WHERE download_status = 'done' AND local_path IS NOT NULL AND created IS NOT NULL AND created < ?`,
  ).all(beforeSeconds);
}

export function markFileRemoved(db: DB, id: string): void {
  stmt(
    db,
    `UPDATE files SET download_status = 'skipped', skip_reason = 'removed', local_path = NULL,
       download_error = 'Removed to save space', updated_at = ? WHERE id = ?`,
  ).run(Date.now(), id);
}

// =============================================================================================
// Custom emoji
// =============================================================================================

/** `emoji.list` shape: name → image URL or `alias:<other>`. Removed emoji are kept (archive). */
export function upsertCustomEmoji(db: DB, emoji: Record<string, string>): number {
  const now = Date.now();
  let count = 0;
  db.transaction(() => {
    for (const [name, value] of Object.entries(emoji ?? {})) {
      if (!name || typeof value !== 'string') continue;
      const alias = value.startsWith('alias:') ? value.slice('alias:'.length) : null;
      stmt(
        db,
        `INSERT INTO custom_emoji (name, url, alias_for, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET url = excluded.url, alias_for = excluded.alias_for, updated_at = excluded.updated_at
         WHERE custom_emoji.url IS NOT excluded.url OR custom_emoji.alias_for IS NOT excluded.alias_for`,
      ).run(name, alias ? null : value, alias, now);
      count++;
    }
  })();
  return count;
}

// =============================================================================================
// Sync state and thread bookkeeping
// =============================================================================================

interface RawSyncStateRow extends Omit<SyncStateRow, 'backfill_complete'> {
  backfill_complete: number;
}

export function getSyncState(db: DB, conversationId: string): SyncStateRow | null {
  const row = stmt<RawSyncStateRow>(db, 'SELECT * FROM sync_state WHERE conversation_id = ?').get(conversationId);
  return row ? { ...row, backfill_complete: row.backfill_complete === 1 } : null;
}

const SYNC_STATE_COLUMNS = ['latest_ts', 'oldest_ts', 'backfill_complete', 'last_synced_at', 'last_error'] as const;

export function setSyncState(db: DB, conversationId: string, patch: SyncStatePatch): void {
  // Column names come from the whitelist, never from the caller's keys.
  const columns = SYNC_STATE_COLUMNS.filter((c) => patch[c] !== undefined);
  const values = columns.map((c) => (c === 'backfill_complete' ? (patch[c] ? 1 : 0) : patch[c]));
  db.transaction(() => {
    stmt(db, 'INSERT INTO sync_state (conversation_id) VALUES (?) ON CONFLICT DO NOTHING').run(conversationId);
    if (!columns.length) return;
    const sets = columns.map((c) => `${c} = ?`).join(', ');
    stmt(db, `UPDATE sync_state SET ${sets} WHERE conversation_id = ?`).run(...values, conversationId);
  })();
}

/**
 * Thread parents whose latest reply is at or after `sinceTs` (Slack ts or unix seconds): threads
 * that may still be receiving replies and should be re-polled.
 */
export function listActiveThreads(
  db: DB,
  conversationId: string,
  sinceTs: string,
): { thread_ts: string; latest_reply: string | null; reply_count: number }[] {
  return stmt<{ thread_ts: string; latest_reply: string | null; reply_count: number }>(
    db,
    `SELECT thread_ts, latest_reply, reply_count FROM messages
     WHERE conversation_id = ? AND thread_ts IS NOT NULL AND thread_ts = ts AND reply_count > 0
       AND CAST(COALESCE(latest_reply, ts) AS REAL) >= CAST(? AS REAL)
     ORDER BY CAST(COALESCE(latest_reply, ts) AS REAL) DESC`,
  ).all(conversationId, sinceTs);
}

export function getStoredThreadInfo(
  db: DB,
  conversationId: string,
  threadTs: string,
): { reply_count: number; latest_reply: string | null; stored_replies: number } | null {
  return (
    stmt<{ reply_count: number; latest_reply: string | null; stored_replies: number }>(
      db,
      `SELECT p.reply_count, p.latest_reply,
         (SELECT count(*) FROM messages r
           WHERE r.conversation_id = p.conversation_id AND r.thread_ts = p.ts AND r.ts <> p.ts) AS stored_replies
       FROM messages p WHERE p.conversation_id = ? AND p.ts = ?`,
    ).get(conversationId, threadTs) ?? null
  );
}

/**
 * Newest archived message or thread reply per conversation (Slack ts): how recently a
 * conversation was active decides how often a sync re-reads it.
 */
export function listLastActivity(db: DB): Map<string, string> {
  const rows = stmt<{ conversation_id: string; latest_ts: string }>(
    db,
    'SELECT conversation_id, latest_ts FROM conversation_stats WHERE latest_ts IS NOT NULL',
  ).all();
  return new Map(rows.map((r) => [r.conversation_id, r.latest_ts]));
}

/**
 * Archived messages that `conversations.history` returns (top-level messages and thread
 * broadcasts) from `sinceTs` on: an estimate of how many history pages reading from there costs.
 * Slack ts have a fixed-width whole part, so the text comparison can use the (conversation, ts)
 * index.
 */
export function countHistoryMessagesSince(db: DB, conversationId: string, sinceTs: string): number {
  return stmt<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM messages
     WHERE conversation_id = ? AND ts >= ? AND (is_reply = 0 OR subtype = 'thread_broadcast')`,
  ).get(conversationId, sinceTs)!.n;
}

// =============================================================================================
// Reindex
// =============================================================================================

const REINDEX_BATCH = 2000;

/**
 * Recomputes `plain_text` for every message (e.g. after users were renamed or first imported),
 * in id-ordered batches so memory stays flat and readers aren't blocked for long. Returns the
 * number of rows whose search text changed; triggers keep FTS in sync.
 */
export function reindexAll(db: DB): number {
  const resolvers = preloadedResolvers(db);
  let lastId = -1;
  let changed = 0;
  for (;;) {
    const step = reindexBatch(db, lastId, REINDEX_BATCH, resolvers);
    changed += step.changed;
    if (step.done) break;
    lastId = step.lastId;
  }
  return changed;
}

/** One batch of reindexAll, for callers that yield to the event loop between batches. */
export function reindexBatch(
  db: DB,
  afterId: number,
  limit: number = REINDEX_BATCH,
  resolvers: NormalizeResolvers = preloadedResolvers(db),
): { lastId: number; changed: number; done: boolean } {
  const batch = stmt<{ id: number; raw: string; plain_text: string }>(
    db,
    'SELECT id, raw, plain_text FROM messages WHERE id > ? ORDER BY id LIMIT ?',
  ).all(afterId, limit);
  if (!batch.length) return { lastId: afterId, changed: 0, done: true };
  let changed = 0;
  db.transaction(() => {
    for (const row of batch) {
      const msg = parseMessage(row.raw);
      if (!msg) continue;
      const next = plainTextFor(msg, resolvers);
      if (next === row.plain_text) continue;
      stmt(db, 'UPDATE messages SET plain_text = ? WHERE id = ?').run(next, row.id);
      changed++;
    }
  })();
  return { lastId: batch[batch.length - 1].id, changed, done: batch.length < limit };
}

/**
 * Bump when the way search text is built changes (normalize.ts, cjk.ts): archives written by an
 * older version are then reindexed once, in the background, at the next start.
 */
export const SEARCH_TEXT_VERSION = 2;
export const SEARCH_TEXT_VERSION_KEY = 'search_text_version';

/** Reindexes in small batches, yielding between them so the app stays responsive. */
export async function refreshSearchTextIfOutdated(
  db: DB,
  opts: { yieldEvery?: () => Promise<void>; log?: (line: string) => void } = {},
): Promise<number> {
  const current = Number(getMeta(db, SEARCH_TEXT_VERSION_KEY) ?? 0);
  const hasMessages = stmt(db, 'SELECT 1 FROM messages LIMIT 1').get() !== undefined;
  if (current === SEARCH_TEXT_VERSION || !hasMessages) {
    if (current !== SEARCH_TEXT_VERSION) setMeta(db, SEARCH_TEXT_VERSION_KEY, String(SEARCH_TEXT_VERSION));
    return 0;
  }
  opts.log?.(`Updating search for this version (search text v${current} → v${SEARCH_TEXT_VERSION})`);
  const pause = opts.yieldEvery ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const resolvers = preloadedResolvers(db);
  let lastId = -1;
  let changed = 0;
  for (;;) {
    const step = reindexBatch(db, lastId, 500, resolvers);
    changed += step.changed;
    if (step.done) break;
    lastId = step.lastId;
    await pause();
    if (!db.open) return changed; // the app quit: finish on the next launch
  }
  setMeta(db, SEARCH_TEXT_VERSION_KEY, String(SEARCH_TEXT_VERSION));
  opts.log?.(`Search updated (${changed} messages)`);
  return changed;
}

/** Unparseable raw JSON is left alone rather than reindexed to an empty string. */
function parseMessage(raw: string): SlackMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as SlackMessage) : null;
  } catch {
    return null;
  }
}

/**
 * Removes what the archive holds for a conversation the user chose not to archive: its messages
 * (with their search entries and edit history), its sync position, and the attachments no other
 * conversation shares. The conversation itself stays listed, by name, so Settings can show it.
 * Returns the removed file ids; the caller deletes their local copies.
 */
export function deleteConversationData(db: DB, conversationId: string): { messages: number; fileIds: string[] } {
  return db.transaction(() => {
    const linked = stmt<{ file_id: string }>(db, 'SELECT DISTINCT file_id FROM message_files WHERE conversation_id = ?')
      .all(conversationId)
      .map((r) => r.file_id);
    stmt(db, 'DELETE FROM message_files WHERE conversation_id = ?').run(conversationId);
    const messages = stmt(db, 'DELETE FROM messages WHERE conversation_id = ?').run(conversationId).changes;
    stmt(db, 'DELETE FROM message_revisions WHERE conversation_id = ?').run(conversationId);
    stmt(db, 'DELETE FROM sync_state WHERE conversation_id = ?').run(conversationId);
    const stillShared = stmt(db, 'SELECT 1 FROM message_files WHERE file_id = ? LIMIT 1');
    const fileIds = linked.filter((id) => stillShared.get(id) === undefined);
    for (const id of fileIds) stmt(db, 'DELETE FROM files WHERE id = ?').run(id);
    return { messages, fileIds };
  })();
}
