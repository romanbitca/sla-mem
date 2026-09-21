import {
  getFileRow,
  getMeta,
  listUsers,
  markFileDownloaded,
  setMeta,
  upsertConversations,
  upsertMessages,
  upsertUsers,
  type DB,
} from '../db';
import type { SlackConversation, SlackFile, SlackMessage, SlackUser } from '../slack/types';
import type { SyncProgress } from '../../shared/types';
import { copyIntoFilesDir, isSafeFileId, localCopyExists, pickLocalCopy } from './attachments';
import { analyzeLayout, LISTING_NAMES, localFileName, type ExportLayout } from './layout';
import {
  exportingUserFromDms,
  parseListing,
  planConversations,
  unlistedConversation,
  userFromMessage,
  type Listings,
} from './listing';
import { errorMessage, openExportSource, type ExportSource } from './source';

export interface ImportSlackExportOptions {
  db: DB;
  /** Export directory or .zip (admin export or `slackdump export`, any layout). */
  path: string;
  /** Where local attachment copies go. */
  filesDir: string;
  signal?: AbortSignal;
  onProgress?: (p: SyncProgress) => void;
  log?: (line: string) => void;
  /** Copy attachment files found inside the export (default true). */
  copyFiles?: boolean;
  /**
   * The export is disposable (e.g. slackdump's temp output): move attachments out of a
   * directory export instead of copying them. Never use for a user's own export.
   */
  moveFiles?: boolean;
}

export interface ImportStats {
  conversations: number;
  users: number;
  usersSynthesized: number;
  dayFiles: number;
  messagesInserted: number;
  messagesUpdated: number;
  revisions: number;
  filesCopied: number;
  skippedFolders: number;
  errors: number;
  [k: string]: number;
}

interface ImportContext {
  db: DB;
  source: ExportSource;
  layout: ExportLayout;
  filesDir: string;
  copyFiles: boolean;
  moveFiles: boolean;
  signal?: AbortSignal;
  log: (line: string) => void;
  onProgress: (p: SyncProgress) => void;
  stats: ImportStats;
  /** File ids whose local copy was already handled in this run (shared files repeat). */
  handledFiles: Set<string>;
}

/** The day files of one export folder and the conversation they belong to. */
interface FolderJob {
  conversationId: string;
  dayFiles: string[];
}

/**
 * Imports a Slack export into the archive. Everything goes through the db merge policy, so
 * re-importing the same export changes nothing and an old export never regresses newer data.
 * Listing files are parsed and validated before the first write.
 */
export async function importSlackExport(opts: ImportSlackExportOptions): Promise<Record<string, number>> {
  opts.signal?.throwIfAborted();
  const log = opts.log ?? (() => undefined);
  const source = await openExportSource(opts.path);
  try {
    const layout = analyzeLayout(source.entries.keys());
    assertIsExport(layout, opts.path);
    const listings = await readListings(source, layout);
    const ctx: ImportContext = {
      db: opts.db,
      source,
      layout,
      filesDir: opts.filesDir,
      copyFiles: opts.copyFiles ?? true,
      moveFiles: opts.moveFiles ?? false,
      signal: opts.signal,
      log,
      onProgress: opts.onProgress ?? (() => undefined),
      stats: emptyStats(),
      handledFiles: new Set(),
    };
    log(`Importing ${source.kind} export ${opts.path}: ${describeLayout(layout)}`);
    const jobs = await prepareWorkspace(ctx, listings);
    await importFolders(ctx, jobs);
    log(summary(ctx.stats));
    return ctx.stats;
  } finally {
    await source.close();
  }
}

function emptyStats(): ImportStats {
  return {
    conversations: 0,
    users: 0,
    usersSynthesized: 0,
    dayFiles: 0,
    messagesInserted: 0,
    messagesUpdated: 0,
    revisions: 0,
    filesCopied: 0,
    skippedFolders: 0,
    errors: 0,
  };
}

function assertIsExport(layout: ExportLayout, p: string): void {
  if (layout.listings.size === 0 && layout.folders.size === 0) {
    throw new Error(
      `Not a Slack export: ${p} has no users.json, no channels/groups/dms/mpims.json and no conversation folders with YYYY-MM-DD.json files`,
    );
  }
}

async function readListings(source: ExportSource, layout: ExportLayout): Promise<Listings> {
  const listings: Listings = {};
  for (const name of LISTING_NAMES) {
    if (layout.listings.has(name)) listings[name] = parseListing(name, await source.readText(`${name}.json`));
  }
  return listings;
}

function describeLayout(layout: ExportLayout): string {
  const days = [...layout.folders.values()].reduce((n, d) => n + d.length, 0);
  const listed = [...layout.listings].map((n) => `${n}.json`).join(', ') || 'no listing files';
  return `${listed}; ${layout.folders.size} folders, ${days} day files, ${layout.attachments.size} local files`;
}

// ---------------------------------------------------------------------------------------------
// Users and conversations
// ---------------------------------------------------------------------------------------------

/** Writes users and conversations first, so message search text can resolve their names. */
async function prepareWorkspace(ctx: ImportContext, listings: Listings): Promise<FolderJob[]> {
  const selfUserId = resolveSelfUser(ctx, listings);
  if (listings.users?.length) {
    ctx.stats.users += upsertUsers(ctx.db, listings.users as SlackUser[]);
  } else {
    await synthesizeUsers(ctx); // users.json missing or empty
  }
  const plan = planConversations(listings, selfUserId);
  const { jobs, unlisted } = planFolderJobs(ctx, plan.folderToConversation);
  const all = [...plan.conversations, ...unlisted];
  ctx.stats.conversations += upsertConversations(ctx.db, all, selfUserId ? { selfUserId } : {});
  if (unlisted.length)
    ctx.log(`Imported ${unlisted.length} unlisted folder(s) by id: ${unlisted.map((c) => c.id).join(', ')}`);
  return jobs;
}

/** Matches each day-file folder to a listed conversation, or to an unlisted one named by id. */
function planFolderJobs(
  ctx: ImportContext,
  folderToConversation: Map<string, string>,
): { jobs: FolderJob[]; unlisted: SlackConversation[] } {
  const jobs: FolderJob[] = [];
  const unlisted: SlackConversation[] = [];
  for (const [folder, dayFiles] of ctx.layout.folders) {
    const listedId = folderToConversation.get(folder);
    const extra = listedId ? null : unlistedConversation(folder);
    if (!listedId && !extra) {
      ctx.stats.skippedFolders++;
      ctx.log(`Skipping folder "${folder}": not in any listing file and not named by a conversation id`);
      continue;
    }
    if (extra) unlisted.push(extra);
    jobs.push({ conversationId: listedId ?? folder, dayFiles });
  }
  return { jobs, unlisted };
}

/**
 * Meta wins (set by API sync from auth.test). Otherwise derive it from dms.json and remember it,
 * so DM labels and "You" work for archives fed only by exports.
 */
function resolveSelfUser(ctx: ImportContext, listings: Listings): string | null {
  const known = getMeta(ctx.db, 'self_user_id');
  if (known) return known;
  const derived = exportingUserFromDms(listings.dms);
  if (derived) {
    setMeta(ctx.db, 'self_user_id', derived);
    ctx.log(`Exporting user identified from dms.json: ${derived}`);
  } else if (listings.dms?.length) {
    ctx.log('Could not identify the exporting user from dms.json; DM partners stay unknown for now');
  }
  return derived;
}

/**
 * Exports without users.json: build minimal users from the `user_profile` embedded in
 * messages, before any message is written (a separate pass, so mentions resolve everywhere).
 * Users already in the archive are left alone.
 */
async function synthesizeUsers(ctx: ImportContext): Promise<void> {
  const known = new Set(listUsers(ctx.db).map((u) => u.id));
  const found = new Map<string, SlackUser>();
  for (const dayFiles of ctx.layout.folders.values()) {
    for (const entry of dayFiles) {
      ctx.signal?.throwIfAborted();
      for (const msg of (await readDayFile(ctx, entry, { quiet: true })) ?? []) {
        const user = userFromMessage(msg);
        // Day files are read oldest first, so the newest profile wins.
        if (user && !known.has(user.id)) found.set(user.id, user);
      }
    }
  }
  if (found.size === 0) return;
  const n = upsertUsers(ctx.db, [...found.values()]);
  ctx.stats.users += n;
  ctx.stats.usersSynthesized += n;
  ctx.log(`No users.json: created ${n} user(s) from message profiles`);
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

async function importFolders(ctx: ImportContext, jobs: FolderJob[]): Promise<void> {
  const total = jobs.reduce((n, j) => n + j.dayFiles.length, 0);
  let done = 0;
  for (const job of jobs) {
    for (const entry of job.dayFiles) {
      ctx.signal?.throwIfAborted();
      ctx.onProgress({ phase: 'import', message: `Importing ${entry}`, current: done, total });
      await importDayFile(ctx, job.conversationId, entry);
      done++;
    }
  }
  ctx.onProgress({ phase: 'import', message: 'Import finished', current: done, total });
}

async function importDayFile(ctx: ImportContext, conversationId: string, entry: string): Promise<void> {
  const msgs = await readDayFile(ctx, entry);
  if (!msgs) return;
  ctx.stats.dayFiles++;
  const r = upsertMessages(ctx.db, conversationId, msgs, 'import', { filesDir: ctx.filesDir });
  ctx.stats.messagesInserted += r.inserted;
  ctx.stats.messagesUpdated += r.updated;
  ctx.stats.revisions += r.revisions;
  if (ctx.copyFiles) await copyLocalFiles(ctx, msgs);
}

/**
 * A corrupt day file is reported and skipped rather than failing the whole import: an archive
 * that has years of good history shouldn't lose all of it to one bad file.
 */
async function readDayFile(
  ctx: ImportContext,
  entry: string,
  opts: { quiet?: boolean } = {},
): Promise<SlackMessage[] | null> {
  let value: unknown;
  try {
    value = JSON.parse(await ctx.source.readText(entry));
  } catch (err) {
    if (!opts.quiet) reportError(ctx, `Skipping ${entry}: ${errorMessage(err)}`);
    return null;
  }
  if (!Array.isArray(value)) {
    if (!opts.quiet) reportError(ctx, `Skipping ${entry}: expected a JSON array of messages`);
    return null;
  }
  return value.filter(isMessageLike);
}

function isMessageLike(v: unknown): v is SlackMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { ts?: unknown }).ts === 'string' &&
    /^\d+(\.\d+)?$/.test((v as { ts: string }).ts)
  );
}

function reportError(ctx: ImportContext, line: string): void {
  ctx.stats.errors++;
  ctx.log(line);
}

// ---------------------------------------------------------------------------------------------
// Local attachment copies
// ---------------------------------------------------------------------------------------------

async function copyLocalFiles(ctx: ImportContext, msgs: SlackMessage[]): Promise<void> {
  for (const msg of msgs) {
    for (const file of Array.isArray(msg.files) ? msg.files : []) {
      if (!file || typeof file.id !== 'string' || ctx.handledFiles.has(file.id)) continue;
      const candidates = ctx.layout.attachments.get(file.id);
      if (!candidates) continue; // no local copy: stays pending/unavailable per the merge policy
      ctx.handledFiles.add(file.id);
      ctx.signal?.throwIfAborted();
      try {
        await copyLocalFile(ctx, file, candidates);
      } catch (err) {
        reportError(ctx, `Could not copy file ${file.id}: ${errorMessage(err)}`);
      }
    }
  }
}

async function copyLocalFile(ctx: ImportContext, file: SlackFile, candidates: string[]): Promise<void> {
  if (!isSafeFileId(file.id)) return;
  const row = getFileRow(ctx.db, file.id);
  if (!row) return; // e.g. a tombstone's placeholder, which upsertMessages doesn't record
  if (row.download_status === 'done' && localCopyExists(ctx.filesDir, row.local_path)) return;
  const entry = pickLocalCopy(candidates, row.name ?? file.name);
  const size = ctx.source.entries.get(entry) ?? 0;
  if (size === 0 && (row.size ?? 0) > 0) {
    ctx.log(`Skipping empty local copy of ${file.id} (${entry}); expected ${row.size} bytes`);
    return;
  }
  const name = row.name ?? file.name ?? localFileName(entry, file.id);
  const localPath = await copyIntoFilesDir(ctx.source, entry, ctx.filesDir, file.id, name, { move: ctx.moveFiles });
  markFileDownloaded(ctx.db, file.id, localPath);
  ctx.stats.filesCopied++;
}

function summary(s: ImportStats): string {
  return (
    `Import done: ${s.messagesInserted} new, ${s.messagesUpdated} updated, ${s.revisions} revisions ` +
    `from ${s.dayFiles} day files in ${s.conversations} conversations; ${s.filesCopied} files copied` +
    (s.errors ? `; ${s.errors} error(s)` : '')
  );
}
