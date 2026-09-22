/**
 * "Import a backup" — moving to another computer. Merges a Slamem backup (the zip that
 * "Back up now" writes, or the folder it was unzipped into) into this computer's archive:
 *
 *  - nothing already here is lost or duplicated: messages merge row by row, keeping the
 *    "deleted in Slack" flag, the highest reply count and the earliest first-seen time; when
 *    both copies were edited the newer edit wins and the other text becomes a revision;
 *  - edit history, people, conversations, custom emoji and attachments come along (an
 *    attachment is copied only when this computer doesn't have it);
 *  - each conversation's sync position comes along too, so after connecting Slack the next sync
 *    fetches only what is new;
 *  - a backup of a different Slack account is refused (one archive = one person, PLAN §5.7).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SyncProgress } from '../shared/types';
import {
  allocateMessageId,
  getMeta,
  openDb,
  refreshSearchTextIfOutdated,
  setMeta,
  SEARCH_TEXT_VERSION_KEY,
  type DB,
  type FileRow,
  type MessageRow,
} from './db';
import { compareTs, laterTs } from './db/merge';
import { renameReplacing } from './fsx';
import { openExportSource, safeEntryPath, type ExportSource } from './import/source';
import { isInside } from './paths';
import { WrongAccountError } from './slack/errors';

export interface RestoreBackupOptions {
  db: DB;
  /** The backup .zip, or the folder it was unzipped into. */
  path: string;
  filesDir: string;
  /** Scratch space for the backup's database while it is merged. */
  tmpDir: string;
  signal?: AbortSignal;
  onProgress?: (p: SyncProgress) => void;
  log?: (line: string) => void;
  /** Conversations the backup's owner chose not to archive, to add to this computer's list. */
  onExcludedConversations?: (ids: string[]) => void;
}

export type RestoreStats = Record<string, number>;

const BATCH = 1_000;

/** Whether `p` (a zip or a folder) is a Slamem backup rather than a Slack export. */
export async function isArchiveBackup(p: string): Promise<boolean> {
  let source: ExportSource;
  try {
    source = await openExportSource(p);
  } catch {
    return false;
  }
  try {
    return source.entries.has('archive.db');
  } finally {
    await source.close();
  }
}

export async function restoreBackup(opts: RestoreBackupOptions): Promise<RestoreStats> {
  const { db } = opts;
  const log = opts.log ?? (() => undefined);
  const progress = (message: string, current: number | null = null, total: number | null = null) =>
    opts.onProgress?.({ phase: 'import', message, current, total });
  const stats: RestoreStats = {
    conversations: 0,
    messagesInserted: 0,
    messagesUpdated: 0,
    revisions: 0,
    filesDownloaded: 0,
  };

  const source = await openExportSource(opts.path);
  const work = path.join(opts.tmpDir, `restore-${process.pid}-${Date.now()}`);
  try {
    if (!source.entries.has('archive.db')) throw new Error('This isn’t a Slamem backup (it has no archive.db).');
    await fs.promises.mkdir(work, { recursive: true });
    progress('Opening the backup…');
    const backupDb = path.join(work, 'archive.db');
    await source.copyTo('archive.db', backupDb);
    upgradeBackup(backupDb);
    const excluded = await backupExclusions(source);

    db.prepare('ATTACH DATABASE ? AS bk').run(backupDb);
    let blobs: Blob[];
    try {
      checkOwner(db);
      stats.conversations = count(db, 'SELECT count(*) AS n FROM bk.conversations');
      for (const table of ['users', 'bots', 'conversations', 'custom_emoji', 'message_files']) copyMissing(db, table);
      await mergeMessages(db, stats, opts.signal, progress);
      stats.revisions += mergeRevisions(db);
      mergeSyncState(db);
      keepOlderSearchText(db);
      blobs = planFiles(db, source);
    } finally {
      db.exec('DETACH DATABASE bk');
    }

    await restoreFiles(db, source, opts.filesDir, blobs, stats, opts.signal, progress);
    if (excluded.length) opts.onExcludedConversations?.(excluded);
    // A backup from an older version has older search text: rebuild it now.
    await refreshSearchTextIfOutdated(db, { log });
    log(
      `Backup imported: ${stats.messagesInserted} new messages, ${stats.messagesUpdated} merged, ` +
        `${stats.filesDownloaded} attachments`,
    );
    return stats;
  } finally {
    await source.close();
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

// ─── the backup's database ───────────────────────────────────────────────────────────────────

/** Brings a backup from an older version up to this schema; one from a newer version is refused. */
function upgradeBackup(file: string): void {
  try {
    openDb(file).close();
  } catch (err) {
    if (/newer/i.test(err instanceof Error ? err.message : '')) {
      throw new Error('This backup was made by a newer version of Slamem. Update Slamem on this computer first.', {
        cause: err,
      });
    }
    throw new Error('This backup can’t be read: its database is damaged.', { cause: err });
  }
}

async function backupExclusions(source: ExportSource): Promise<string[]> {
  if (!source.entries.has('config.json')) return [];
  try {
    const config = JSON.parse(await source.readText('config.json')) as {
      preferences?: { excludedConversationIds?: unknown };
    };
    const ids = config.preferences?.excludedConversationIds;
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string' && /^[CDG][A-Z0-9]+$/.test(id))
      : [];
  } catch {
    return [];
  }
}

function count(db: DB, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function bkMeta(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM bk.meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

// ─── one person per archive ──────────────────────────────────────────────────────────────────

function checkOwner(db: DB): void {
  const theirs = { team: bkMeta(db, 'team_id'), user: bkMeta(db, 'self_user_id') };
  if (!theirs.team && !theirs.user) return; // an empty backup
  const ours = { team: getMeta(db, 'team_id'), user: getMeta(db, 'self_user_id') };
  if (ours.team && ours.user) {
    if (ours.team === theirs.team && ours.user === theirs.user) return;
    throw new WrongAccountError(
      `This backup is ${ownerOf(db, 'bk')}’s archive of ${bkMeta(db, 'team_name') ?? 'another workspace'}, and this ` +
        `archive belongs to ${ownerOf(db, 'main')} at ${getMeta(db, 'team_name') ?? 'another workspace'}. ` +
        'Import it into an archive of the same Slack account.',
    );
  }
  // A fresh archive becomes the backup owner's.
  for (const key of ['team_id', 'team_name', 'team_domain', 'team_icon', 'self_user_id']) {
    const value = bkMeta(db, key);
    if (value != null) setMeta(db, key, value);
  }
}

function ownerOf(db: DB, schema: 'main' | 'bk'): string {
  const self = schema === 'main' ? getMeta(db, 'self_user_id') : bkMeta(db, 'self_user_id');
  const row = db.prepare(`SELECT display_name, real_name, name FROM ${schema}.users WHERE id = ?`).get(self ?? '') as
    { display_name: string | null; real_name: string | null; name: string | null } | undefined;
  return row?.display_name || row?.real_name || row?.name || 'someone else';
}

// ─── rows ────────────────────────────────────────────────────────────────────────────────────

function columnsOf(db: DB, schema: 'main' | 'bk', table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** Rows this archive doesn't have yet; what it has stays as it is (it is the fresher copy). */
function copyMissing(db: DB, table: string): number {
  const theirs = new Set(columnsOf(db, 'bk', table));
  const list = columnsOf(db, 'main', table)
    .filter((c) => theirs.has(c))
    .map((c) => `"${c}"`)
    .join(', ');
  return db.prepare(`INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM bk.${table}`).run().changes;
}

const MESSAGE_COLUMNS = [
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
] as const satisfies readonly (keyof MessageRow)[];

async function mergeMessages(
  db: DB,
  stats: RestoreStats,
  signal: AbortSignal | undefined,
  progress: (message: string, current: number, total: number) => void,
): Promise<void> {
  const total = count(db, 'SELECT count(*) AS n FROM bk.messages');
  const page = db.prepare('SELECT * FROM bk.messages WHERE id > ? ORDER BY id LIMIT ?');
  const local = db.prepare('SELECT * FROM main.messages WHERE conversation_id = ? AND ts = ?');
  const insert = db.prepare(
    `INSERT INTO main.messages (id, ${MESSAGE_COLUMNS.join(', ')}) VALUES (@id, ${MESSAGE_COLUMNS.map((c) => `@${c}`).join(', ')})`,
  );
  const update = db.prepare(
    `UPDATE main.messages SET ${MESSAGE_COLUMNS.filter((c) => c !== 'conversation_id' && c !== 'ts')
      .map((c) => `${c} = @${c}`)
      .join(', ')} WHERE id = @id`,
  );
  const addRevision = db.prepare(
    'INSERT INTO main.message_revisions (conversation_id, ts, text, edited_ts, seen_at) VALUES (?, ?, ?, ?, ?)',
  );
  let last = -1;
  let done = 0;
  for (;;) {
    signal?.throwIfAborted();
    const rows = page.all(last, BATCH) as MessageRow[];
    if (!rows.length) break;
    db.transaction(() => {
      for (const theirs of rows) {
        const ours = local.get(theirs.conversation_id, theirs.ts) as MessageRow | undefined;
        if (!ours) {
          insert.run({ ...theirs, id: allocateMessageId(db, theirs.ts) });
          stats.messagesInserted++;
          continue;
        }
        const merged = mergeRows(ours, theirs);
        if (merged.revision) {
          addRevision.run(
            ours.conversation_id,
            ours.ts,
            merged.revision.text,
            merged.revision.editedTs,
            merged.revision.seenAt,
          );
          stats.revisions++;
        }
        if (merged.changed) {
          update.run(merged.row);
          stats.messagesUpdated++;
        }
      }
    })();
    last = rows[rows.length - 1].id;
    done += rows.length;
    progress(`Importing messages — ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`, done, total);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Two archived copies of one message → one, losing nothing either knew: the newer edit's content
 * (the other text becomes a revision), sticky flags, the highest reply count and latest reply,
 * every replier, and the earliest time either copy first saw it.
 */
export function mergeRows(
  ours: MessageRow,
  theirs: MessageRow,
): { row: MessageRow; changed: boolean; revision: { text: string; editedTs: string | null; seenAt: number } | null } {
  const theirsEditedLater =
    theirs.edited_ts != null && (ours.edited_ts == null || compareTs(theirs.edited_ts, ours.edited_ts) > 0);
  const newer = theirsEditedLater ? theirs : ours;
  const older = theirsEditedLater ? ours : theirs;
  const reactionsFrom = theirs.updated_at > ours.updated_at ? theirs : ours;
  const threadTs = ours.thread_ts ?? theirs.thread_ts;
  const row: MessageRow = {
    ...ours,
    subtype: newer.subtype,
    user_id: newer.user_id ?? older.user_id,
    bot_id: newer.bot_id ?? older.bot_id,
    username: newer.username ?? older.username,
    text: newer.text,
    plain_text: newer.plain_text,
    edited_ts: newer.edited_ts,
    raw: newer.raw,
    has_files: Math.max(ours.has_files, theirs.has_files),
    has_links: Math.max(ours.has_links, theirs.has_links),
    has_images: Math.max(ours.has_images, theirs.has_images),
    reactions: reactionsFrom.reactions,
    is_deleted: Math.max(ours.is_deleted, theirs.is_deleted),
    thread_ts: threadTs,
    is_reply: threadTs != null && threadTs !== ours.ts ? 1 : 0,
    reply_count: Math.max(ours.reply_count, theirs.reply_count),
    latest_reply: laterTs(ours.latest_reply, theirs.latest_reply),
    reply_users: JSON.stringify([...new Set([...parseList(ours.reply_users), ...parseList(theirs.reply_users)])]),
    first_seen_at: Math.min(ours.first_seen_at, theirs.first_seen_at),
    updated_at: Math.max(ours.updated_at, theirs.updated_at),
  };
  const changed = MESSAGE_COLUMNS.some((c) => row[c] !== ours[c]);
  const revision =
    theirsEditedLater && ours.text.trim() !== '' && ours.text !== theirs.text
      ? { text: ours.text, editedTs: ours.edited_ts, seenAt: ours.updated_at }
      : null;
  return { row, changed, revision };
}

function parseList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Earlier versions of messages that this archive doesn't have yet. */
function mergeRevisions(db: DB): number {
  return db
    .prepare(
      `INSERT INTO main.message_revisions (conversation_id, ts, text, edited_ts, seen_at)
       SELECT b.conversation_id, b.ts, b.text, b.edited_ts, b.seen_at FROM bk.message_revisions b
       WHERE NOT EXISTS (SELECT 1 FROM main.message_revisions m
                         WHERE m.conversation_id = b.conversation_id AND m.ts = b.ts
                           AND m.text = b.text AND m.edited_ts IS b.edited_ts)`,
    )
    .run().changes;
}

/**
 * Where each conversation's sync got to: the newest message either archive has, and the oldest.
 * The next sync then only asks Slack for what came after.
 */
function mergeSyncState(db: DB): void {
  db.prepare(
    `INSERT INTO main.sync_state (conversation_id, latest_ts, oldest_ts, backfill_complete, last_synced_at, last_error)
     SELECT conversation_id, latest_ts, oldest_ts, backfill_complete, last_synced_at, last_error FROM bk.sync_state WHERE true
     ON CONFLICT (conversation_id) DO UPDATE SET
       latest_ts = CASE WHEN sync_state.latest_ts IS NULL
                          OR (excluded.latest_ts IS NOT NULL AND CAST(excluded.latest_ts AS REAL) > CAST(sync_state.latest_ts AS REAL))
                        THEN excluded.latest_ts ELSE sync_state.latest_ts END,
       oldest_ts = CASE WHEN sync_state.oldest_ts IS NULL
                          OR (excluded.oldest_ts IS NOT NULL AND CAST(excluded.oldest_ts AS REAL) < CAST(sync_state.oldest_ts AS REAL))
                        THEN excluded.oldest_ts ELSE sync_state.oldest_ts END,
       backfill_complete = max(sync_state.backfill_complete, excluded.backfill_complete),
       last_synced_at = max(COALESCE(sync_state.last_synced_at, 0), COALESCE(excluded.last_synced_at, 0))`,
  ).run();
}

/** Rows copied from an older version carry its search text; the lower version triggers a rebuild. */
function keepOlderSearchText(db: DB): void {
  const theirs = Number(bkMeta(db, SEARCH_TEXT_VERSION_KEY) ?? 0);
  const ours = Number(getMeta(db, SEARCH_TEXT_VERSION_KEY) ?? 0);
  if (theirs < ours) setMeta(db, SEARCH_TEXT_VERSION_KEY, String(theirs));
}

// ─── attachments ─────────────────────────────────────────────────────────────────────────────

interface Blob {
  file: FileRow;
  /** Whether this archive already has a row for the file (it is updated rather than added). */
  known: boolean;
  /** Zip entry and relative path ('/'-separated) of the file and of its thumbnail. */
  main: { entry: string; rel: string } | null;
  thumb: { entry: string; rel: string } | null;
}

function blobOf(source: ExportSource, localPath: string | null): { entry: string; rel: string } | null {
  if (!localPath) return null;
  const rel = safeEntryPath(localPath.split(/[\\/]/).join('/'));
  if (!rel) return null;
  const entry = `files/${rel}`;
  return source.entries.has(entry) ? { entry, rel } : null;
}

/** The backup's attachments this archive lacks (or hasn't downloaded), and where they go. */
function planFiles(db: DB, source: ExportSource): Blob[] {
  const plan: Blob[] = [];
  const page = db.prepare('SELECT * FROM bk.files WHERE id > ? ORDER BY id LIMIT ?');
  const ours = db.prepare('SELECT * FROM main.files WHERE id = ?');
  let last = '';
  for (;;) {
    const rows = page.all(last, BATCH) as FileRow[];
    if (!rows.length) break;
    for (const theirs of rows) {
      const mine = ours.get(theirs.id) as FileRow | undefined;
      const main = theirs.download_status === 'done' ? blobOf(source, theirs.local_path) : null;
      const thumb = blobOf(source, theirs.thumb_local_path);
      if (!mine) plan.push({ file: theirs, known: false, main, thumb });
      else if (mine.download_status !== 'done' && main) plan.push({ file: theirs, known: true, main, thumb });
    }
    last = rows[rows.length - 1].id;
  }
  return plan;
}

/**
 * Copies the planned attachments into place first, then records them, so the archive never
 * says a file is there when it isn't. A copy that fails leaves the file to be downloaded again.
 */
async function restoreFiles(
  db: DB,
  source: ExportSource,
  filesDir: string,
  plan: Blob[],
  stats: RestoreStats,
  signal: AbortSignal | undefined,
  progress: (message: string, current: number, total: number) => void,
): Promise<void> {
  const columns = columnsOfMain(db, 'files');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO files (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
  );
  const markDone = db.prepare(
    `UPDATE files SET download_status = 'done', local_path = ?, thumb_local_path = COALESCE(?, thumb_local_path),
       download_error = NULL, skip_reason = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
  );
  let done = 0;
  for (const blob of plan) {
    signal?.throwIfAborted();
    const main = blob.main ? await place(source, filesDir, blob.main) : null;
    const thumb = blob.thumb ? await place(source, filesDir, blob.thumb) : null;
    if (blob.known) {
      if (main) markDone.run(main, thumb, Date.now(), blob.file.id);
    } else {
      const status = main ? 'done' : blob.file.download_status === 'done' ? 'pending' : blob.file.download_status;
      insert.run({ ...blob.file, download_status: status, local_path: main, thumb_local_path: thumb });
    }
    if (main) stats.filesDownloaded++;
    done++;
    if (done % 25 === 0 || done === plan.length) {
      progress(
        `Importing attachments — ${done.toLocaleString('en-US')} of ${plan.length.toLocaleString('en-US')}`,
        done,
        plan.length,
      );
    }
  }
}

function columnsOfMain(db: DB, table: string): string[] {
  return columnsOf(db, 'main', table);
}

/** Copies one backup entry to `filesDir/<rel>` (this OS's separators); returns the stored path. */
async function place(
  source: ExportSource,
  filesDir: string,
  blob: { entry: string; rel: string },
): Promise<string | null> {
  const stored = path.join(...blob.rel.split('/'));
  const target = path.join(filesDir, stored);
  if (!isInside(filesDir, target)) return null;
  if (fs.existsSync(target)) return stored;
  const partial = `${target}.restoring`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await source.copyTo(blob.entry, partial);
    await renameReplacing(partial, target);
    return stored;
  } catch {
    await fs.promises.rm(partial, { force: true });
    return null;
  }
}
