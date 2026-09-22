import path from 'node:path';
import {
  getConversation,
  getMeta,
  getSyncState,
  listConversations,
  listUsers,
  reindexAll,
  setMeta,
  setSyncState,
  upsertConversations,
  upsertCustomEmoji,
  upsertUsers,
  type DB,
} from '../db';
import type { AttachmentPolicy, ConversationDTO, SyncProgress } from '../../shared/types';
import type { AuthTestResponse, EmojiListResponse, TeamInfoResponse } from './api-types';
import { SlackClient, redactSlackSecrets, type SlackClientOptions } from './client';
import { emptyConversationResult, syncConversation, type ConversationSyncResult } from './conversation-sync';
import { SlackApiError, SlackHttpError, WrongAccountError, isFatalAuthError, toFatalAuthError } from './errors';
import { downloadPendingFiles } from './files';
import type { SlackConversation, SlackUser } from './types';
import { formatDuration, isAbortError, plural, throwIfAborted } from './util';

export interface ApiSyncOptions {
  db: DB;
  /** Browser-session token (xoxc-…, which needs `cookie`). */
  token: string;
  /** `d` session cookie (xoxd-…) for xoxc tokens; sent to Slack hosts only. */
  cookie?: string;
  /** Default https://slack.com/api. */
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (p: SyncProgress) => void;
  log?: (line: string) => void;
  /** Where attachments are stored. */
  filesDir: string;
  /** Which attachments to download (PLAN §8.4). */
  attachmentPolicy: AttachmentPolicy;
  /** Only sync these conversations' history (the user/conversation lists are always refreshed). */
  conversationIds?: string[];
  /**
   * Conversations the user chose not to archive (Settings → What to archive): no history, threads
   * or attachments are fetched for them. Read again before each conversation and before the
   * downloads, so a change made while a sync runs applies at once.
   */
  excludedConversationIds?: () => readonly string[];
  /** Only refresh the people and conversation lists (onboarding asks what to archive first). */
  listsOnly?: boolean;
  /** Epoch ms clock (thread recheck window, last_synced_at, durations). */
  now?: () => number;
  /**
   * Incremental syncs re-read this much history before the newest known message, to catch edits,
   * reactions and thread activity (PLAN §5.2: 3 days is too short). Default 7 days.
   */
  overlapSeconds?: number;
  /** Threads whose latest reply is newer than this are re-polled on every sync. Default 21. */
  threadRecheckDays?: number;
  /** Client tuning (tests disable pacing and inject sleep). */
  clientOptions?: Omit<Partial<SlackClientOptions>, 'token' | 'cookie' | 'baseUrl' | 'fetch' | 'log' | 'signal'>;
}

export type ApiSyncStats = Record<string, number>;

export const DEFAULT_OVERLAP_SECONDS = 7 * 86_400;
export const DEFAULT_THREAD_RECHECK_DAYS = 21;
/** This many conversations failing in a row with no Slack answer at all means Slack is unreachable. */
const MAX_CONSECUTIVE_UNREACHABLE = 3;

const CONVERSATION_TYPES = 'public_channel,private_channel,mpim,im';

interface SyncContext {
  opts: ApiSyncOptions;
  db: DB;
  client: SlackClient;
  stats: ApiSyncStats;
  now: () => number;
  filesDir: string;
  log: (line: string) => void;
  progress: (phase: string, message: string, current?: number | null, total?: number | null) => void;
}

/**
 * One API sync run (PLAN §5.2). Every page is committed as it arrives, so an abort or crash keeps
 * everything fetched so far; the next run resumes from sync_state.
 *
 * Errors: per-conversation problems (not_in_channel, a channel that keeps failing…) are recorded in
 * sync_state.last_error and the run continues (pitfall 8). A signed-out session, a different
 * account, Slack being unreachable and aborts reject the promise; partial stats are attached to
 * the error (see `statsFromError`).
 */
export async function runApiSync(opts: ApiSyncOptions): Promise<ApiSyncStats> {
  const now = opts.now ?? Date.now;
  const log = (line: string) => opts.log?.(redactSlackSecrets(line, [opts.token, opts.cookie]));
  const client = new SlackClient({
    ...opts.clientOptions,
    token: opts.token,
    cookie: opts.cookie,
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    log,
    signal: opts.signal,
  });
  const ctx: SyncContext = {
    opts,
    db: opts.db,
    client,
    stats: emptyStats(),
    now,
    filesDir: path.resolve(opts.filesDir),
    log,
    progress: (phase, message, current = null, total = null) => opts.onProgress?.({ phase, message, current, total }),
  };
  const started = now();
  try {
    const selfUserId = await authenticate(ctx);
    const namesBefore = nameSnapshot(ctx.db);
    await syncUsers(ctx);
    const conversations = await syncConversationList(ctx, selfUserId);
    refreshSearchTextIfRenamed(ctx, namesBefore);
    if (opts.listsOnly) {
      ctx.stats.apiCalls = client.apiCalls;
      log(`Conversation list refreshed: ${conversations.length} conversations`);
      return ctx.stats;
    }
    await syncHistories(ctx, conversations);
    await syncEmoji(ctx);
    await syncFiles(ctx);
    ctx.stats.apiCalls = client.apiCalls;
    log(`Sync finished in ${formatDuration(now() - started)}: ${summarize(ctx.stats)}`);
    return ctx.stats;
  } catch (err) {
    ctx.stats.apiCalls = client.apiCalls;
    throw withStats(isFatalAuthError(err) ? toFatalAuthError(err) : err, ctx.stats);
  }
}

/**
 * Attachment downloads only (the "Retry" action on a file, or after raising the attachment limit):
 * no history is fetched.
 */
export async function runFileDownloads(opts: Omit<ApiSyncOptions, 'conversationIds'>): Promise<ApiSyncStats> {
  const log = (line: string) => opts.log?.(redactSlackSecrets(line, [opts.token, opts.cookie]));
  const client = new SlackClient({
    ...opts.clientOptions,
    token: opts.token,
    cookie: opts.cookie,
    baseUrl: opts.baseUrl,
    fetch: opts.fetch,
    log,
    signal: opts.signal,
  });
  const stats = await downloadPendingFiles({
    db: opts.db,
    client,
    filesDir: path.resolve(opts.filesDir),
    policy: opts.attachmentPolicy,
    signal: opts.signal,
    onProgress: opts.onProgress,
    log,
    now: opts.now,
    excludedConversationIds: opts.excludedConversationIds?.(),
  });
  return { ...stats, apiCalls: client.apiCalls };
}

/** Partial stats of a failed or cancelled run, if the error came from `runApiSync`. */
export function statsFromError(err: unknown): ApiSyncStats | null {
  const stats = err && typeof err === 'object' ? (err as { syncStats?: unknown }).syncStats : undefined;
  return stats && typeof stats === 'object' ? (stats as ApiSyncStats) : null;
}

function withStats(err: unknown, stats: ApiSyncStats): unknown {
  if (err && typeof err === 'object') {
    Object.defineProperty(err, 'syncStats', { value: { ...stats }, enumerable: false, configurable: true });
  }
  return err;
}

function emptyStats(): ApiSyncStats {
  return {
    conversations: 0,
    messagesInserted: 0,
    messagesUpdated: 0,
    revisions: 0,
    threadsFetched: 0,
    filesDownloaded: 0,
    filesFailed: 0,
    filesSkipped: 0,
    apiCalls: 0,
    errors: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

async function authenticate(ctx: SyncContext): Promise<string> {
  ctx.progress('auth', 'Connecting to Slack');
  const auth = await ctx.client.call<AuthTestResponse>('auth.test');
  if (!auth.user_id) throw new Error('Slack auth.test returned no user id');
  assertSameOwner(ctx.db, auth);
  if (auth.team_id) setMeta(ctx.db, 'team_id', auth.team_id);
  if (auth.team) setMeta(ctx.db, 'team_name', auth.team);
  const domain = teamDomainFromUrl(auth.url);
  if (domain) setMeta(ctx.db, 'team_domain', domain);
  setMeta(ctx.db, 'self_user_id', auth.user_id);
  ctx.log(`Connected to ${auth.team ?? auth.team_id ?? 'Slack'} as ${auth.user ?? auth.user_id}`);
  return auth.user_id;
}

/**
 * One archive = one person's view of one workspace (PLAN §5.7). Credentials for another workspace
 * or user would silently merge a second archive into this one, so refuse.
 */
export function assertSameOwner(db: DB, auth: Pick<AuthTestResponse, 'team_id' | 'user_id' | 'team' | 'user'>): void {
  const knownTeam = getMeta(db, 'team_id');
  const knownSelf = getMeta(db, 'self_user_id');
  const mismatch =
    (knownTeam && auth.team_id && knownTeam !== auth.team_id) ||
    (knownSelf && auth.user_id && knownSelf !== auth.user_id);
  if (!mismatch) return;
  const owner = knownSelf
    ? (listUsers(db).find((u) => u.id === knownSelf)?.label ?? 'another person')
    : 'another person';
  const team = getMeta(db, 'team_name') ?? 'another workspace';
  throw new WrongAccountError(
    `This archive belongs to ${owner} at ${team}. To archive a different account, use a different archive folder.`,
  );
}

/** `https://9hdigital.slack.com/` → `9hdigital`. */
export function teamDomainFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('.slack.com') ? host.split('.')[0] || null : null;
  } catch {
    return null;
  }
}

async function syncUsers(ctx: SyncContext): Promise<void> {
  ctx.progress('users', 'Fetching people');
  let count = 0;
  for await (const members of ctx.client.paginate<SlackUser>('users.list', { limit: 200 }, 'members')) {
    count += upsertUsers(ctx.db, members);
    ctx.progress('users', `Fetching people — ${count.toLocaleString('en-US')} so far`);
  }
  ctx.stats.users = count;
  ctx.log(`Users: ${count}`);
  await refreshTeamInfo(ctx);
}

/** team.info has the canonical name/domain; optional (ignore errors, PLAN §2.5). */
async function refreshTeamInfo(ctx: SyncContext): Promise<void> {
  try {
    const info = await ctx.client.call<TeamInfoResponse>('team.info');
    if (info.team?.name) setMeta(ctx.db, 'team_name', info.team.name);
    if (info.team?.domain) setMeta(ctx.db, 'team_domain', info.team.domain);
  } catch (err) {
    if (!isIgnorable(err)) throw err;
  }
}

async function syncConversationList(ctx: SyncContext, selfUserId: string): Promise<SlackConversation[]> {
  ctx.progress('conversations', 'Listing your conversations');
  const conversations: SlackConversation[] = [];
  const params = { types: CONVERSATION_TYPES, exclude_archived: false, limit: 200, user: selfUserId };
  for await (const page of ctx.client.paginate<SlackConversation>('users.conversations', params, 'channels')) {
    conversations.push(...page.filter((c) => c && typeof c.id === 'string' && c.id));
  }
  // users.conversations lists only conversations the user belongs to, but IM/MPIM objects omit the flag.
  for (const c of conversations) c.is_member ??= true;
  await fillMpimMembers(ctx, conversations);
  upsertConversations(ctx.db, conversations, { selfUserId });
  ctx.log(`Conversations: ${describeCounts(conversations)}`);
  return conversations;
}

/**
 * users.conversations doesn't include MPIM members, and their label ("alice, bob") comes from
 * member ids. Membership of a group DM never changes, so each is looked up only once.
 */
async function fillMpimMembers(ctx: SyncContext, conversations: SlackConversation[]): Promise<void> {
  for (const c of conversations) {
    if (!c.is_mpim || c.members?.length) continue;
    if (getConversation(ctx.db, c.id)?.memberIds.length) continue;
    try {
      const members: string[] = [];
      for await (const page of ctx.client.paginate<string>(
        'conversations.members',
        { channel: c.id, limit: 200 },
        'members',
      )) {
        members.push(...page.filter((m) => typeof m === 'string'));
      }
      if (members.length) c.members = members;
    } catch (err) {
      if (!isIgnorable(err)) throw err;
    }
  }
}

function describeCounts(conversations: SlackConversation[]): string {
  const ims = conversations.filter((c) => c.is_im).length;
  const mpims = conversations.filter((c) => c.is_mpim).length;
  const channels = conversations.length - ims - mpims;
  return `${conversations.length} (${plural(channels, 'channel')}, ${plural(ims, 'DM')}, ${plural(mpims, 'group DM')})`;
}

interface NameSnapshot {
  users: Map<string, string>;
  channels: Map<string, string | null>;
}

function nameSnapshot(db: DB): NameSnapshot {
  return {
    users: new Map(listUsers(db).map((u) => [u.id, u.label])),
    channels: new Map(listConversations(db).map((c) => [c.id, c.rawName])),
  };
}

/**
 * Search text embeds user and channel names (`<@U1>` → `@alice`). When a known user or channel
 * was renamed, archived messages would no longer match the new name, so the index is rebuilt
 * (pitfall 9).
 */
function refreshSearchTextIfRenamed(ctx: SyncContext, before: NameSnapshot): void {
  const after = nameSnapshot(ctx.db);
  const renamed = (a: Map<string, unknown>, b: Map<string, unknown>) =>
    [...a].some(([id, name]) => b.has(id) && b.get(id) !== name);
  if (!renamed(before.users, after.users) && !renamed(before.channels, after.channels)) return;
  ctx.progress('reindex', 'Names changed in Slack; updating search');
  const changed = reindexAll(ctx.db);
  ctx.log(`Names changed in Slack; refreshed search text of ${changed} messages`);
}

/** Shared by every conversation read in one run. */
interface HistoryRun {
  labels: Map<string, string>;
  done: number;
  total: number;
  unreachableInARow: number;
}

/**
 * Reads every conversation (PLAN §5.2): new messages and edits within the overlap window, and
 * quiet threads from their parents (conversation-sync.ts), one paced history read each at least.
 * Slack's documented Web API has no call that says which conversations changed; the Slack app's
 * own summary (`client.counts`, which 0.2.x used to skip unchanged ones) is not part of it, and
 * sla-mem only uses the published API.
 */
async function syncHistories(ctx: SyncContext, listed: SlackConversation[]): Promise<void> {
  const targets = orderTargets(ctx, selectTargets(ctx, listed));
  const run: HistoryRun = {
    labels: new Map(listConversations(ctx.db).map((c) => [c.id, displayLabel(c)])),
    done: 0,
    total: targets.length,
    unreachableInARow: 0,
  };
  for (const conv of targets) await readConversation(ctx, run, conv);
}

async function readConversation(ctx: SyncContext, run: HistoryRun, conv: SlackConversation): Promise<void> {
  throwIfAborted(ctx.opts.signal);
  const position = { current: ++run.done, total: run.total };
  if (isExcluded(ctx, conv.id)) return; // excluded while this sync was running
  const label = run.labels.get(conv.id) ?? conv.id;
  ctx.progress('history', `Fetching ${label}`, position.current, position.total);
  const result = emptyConversationResult();
  try {
    await syncConversation(
      {
        db: ctx.db,
        client: ctx.client,
        filesDir: ctx.filesDir,
        overlapSeconds: ctx.opts.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS,
        threadRecheckDays: ctx.opts.threadRecheckDays ?? DEFAULT_THREAD_RECHECK_DAYS,
        now: ctx.now,
        signal: ctx.opts.signal,
        log: ctx.log,
        label,
        onProgress: (e) =>
          ctx.progress(
            e.phase,
            e.phase === 'threads' && e.threadsTotal
              ? `Fetching ${label} — checking threads (${e.threadsDone ?? 0} of ${e.threadsTotal})`
              : `Fetching ${label} — ${e.fetched.toLocaleString('en-US')} messages so far`,
            position.current,
            position.total,
          ),
      },
      conv.id,
      result,
    );
    run.unreachableInARow = 0;
    ctx.stats.conversations++;
    const summary = describeResult(result);
    if (summary) ctx.log(`${label}: ${summary}`);
  } catch (err) {
    run.unreachableInARow = err instanceof SlackHttpError ? run.unreachableInARow + 1 : 0;
    if (run.unreachableInARow >= MAX_CONSECUTIVE_UNREACHABLE) throw err;
    recordConversationError(ctx, conv.id, label, err);
  } finally {
    // Pages committed before a failure count too (they're in the archive).
    addCounts(ctx.stats, result);
  }
}

function isExcluded(ctx: SyncContext, conversationId: string): boolean {
  return ctx.opts.excludedConversationIds?.().includes(conversationId) ?? false;
}

function selectTargets(ctx: SyncContext, listed: SlackConversation[]): SlackConversation[] {
  const included = listed.filter((c) => !isExcluded(ctx, c.id));
  const skipped = listed.length - included.length;
  if (skipped) ctx.log(`Not archiving ${skipped} conversation${skipped === 1 ? '' : 's'} excluded in Settings`);
  return pickRequested(ctx, included);
}

function pickRequested(ctx: SyncContext, listed: SlackConversation[]): SlackConversation[] {
  if (!ctx.opts.conversationIds) return listed;
  const wanted = [...new Set(ctx.opts.conversationIds)];
  const byId = new Map(listed.map((c) => [c.id, c]));
  for (const id of wanted) {
    if (byId.has(id)) continue;
    ctx.stats.errors++;
    ctx.log(`${id}: not one of your conversations; skipped`);
  }
  return wanted.flatMap((id) => byId.get(id) ?? []);
}

/** Conversations that failed last time go last, so one broken channel never holds up the rest. */
function orderTargets(ctx: SyncContext, targets: SlackConversation[]): SlackConversation[] {
  const failedBefore = (c: SlackConversation) => (getSyncState(ctx.db, c.id)?.last_error ? 1 : 0);
  return targets
    .map((c, index) => ({ c, index, failed: failedBefore(c) }))
    .sort((a, b) => a.failed - b.failed || a.index - b.index)
    .map((x) => x.c);
}

/**
 * Failures that end the run are rethrown; anything else is recorded against the conversation
 * (sync_state.last_error) so one inaccessible channel doesn't stop the archive.
 */
function recordConversationError(ctx: SyncContext, conversationId: string, label: string, err: unknown): void {
  if (isAbortError(err) || ctx.opts.signal?.aborted) throw err;
  if (isFatalAuthError(err)) throw err;
  if ((err as NodeJS.ErrnoException)?.code === 'ENOSPC' || /SQLITE_FULL/.test(String((err as Error)?.message)))
    throw err;
  const reason = err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err);
  setSyncState(ctx.db, conversationId, { last_error: reason });
  ctx.stats.errors++;
  ctx.log(`${label}: skipped this time (${reason})`);
}

async function syncEmoji(ctx: SyncContext): Promise<void> {
  throwIfAborted(ctx.opts.signal);
  ctx.progress('emoji', 'Fetching custom emoji');
  try {
    const res = await ctx.client.call<EmojiListResponse>('emoji.list');
    ctx.stats.emoji = upsertCustomEmoji(ctx.db, res.emoji ?? {});
  } catch (err) {
    // Custom emoji then just render as :name:; not worth failing (or warning about) the run.
    if (!isIgnorable(err)) throw err;
    if (err.code !== 'missing_scope') ctx.log(`Custom emoji skipped (${err.code})`);
  }
}

async function syncFiles(ctx: SyncContext): Promise<void> {
  throwIfAborted(ctx.opts.signal);
  const result = await downloadPendingFiles({
    db: ctx.db,
    client: ctx.client,
    filesDir: ctx.filesDir,
    policy: ctx.opts.attachmentPolicy,
    signal: ctx.opts.signal,
    onProgress: ctx.opts.onProgress,
    log: ctx.log,
    now: ctx.now,
    excludedConversationIds: ctx.opts.excludedConversationIds?.(),
  });
  Object.assign(ctx.stats, result);
}

/** Non-fatal Slack answers (missing scope, not allowed…) for optional steps. */
function isIgnorable(err: unknown): err is SlackApiError {
  return err instanceof SlackApiError && !isFatalAuthError(err);
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

function displayLabel(c: ConversationDTO): string {
  if (c.type === 'channel' || c.type === 'private_channel') return `#${c.label}`;
  return c.label;
}

function addCounts(stats: ApiSyncStats, r: ConversationSyncResult): void {
  stats.messagesInserted += r.inserted;
  stats.messagesUpdated += r.updated;
  stats.revisions += r.revisions;
  stats.threadsFetched += r.threadsFetched;
}

function describeResult(r: ConversationSyncResult): string {
  const parts = [
    r.inserted && `${r.inserted} new`,
    r.updated && `${r.updated} updated`,
    r.revisions && `${r.revisions} edited`,
    r.threadsFetched && plural(r.threadsFetched, 'thread'),
  ];
  return parts.filter(Boolean).join(', ');
}

function summarize(s: ApiSyncStats): string {
  return [
    plural(s.conversations, 'conversation'),
    `${s.messagesInserted} new`,
    `${s.messagesUpdated} updated`,
    `${s.revisions} edited`,
    plural(s.threadsFetched, 'thread'),
    plural(s.filesDownloaded, 'file'),
    plural(s.apiCalls, 'API call'),
    plural(s.errors, 'error'),
  ].join(', ');
}
