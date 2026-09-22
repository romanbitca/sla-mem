/**
 * RunManager: executes sync / attachment-download / import jobs one at a time, records them in
 * the `runs` table and exposes live status (and plain-language problems) to the UI, the scheduler
 * and the tray. "Only one run at a time; a second request returns 'already running'" (PLAN §5.3).
 *
 * Concurrency is guarded twice: an in-memory active-run slot and the database lock `sync`, so a
 * second process (a dev script, a stray instance) can never write the archive at the same time.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PreferencesDTO,
  ProblemDTO,
  RunKind,
  RunStatus,
  SyncProgress,
  SyncRunDTO,
  SyncStatusDTO,
} from '../shared/types';
import {
  DEFAULT_LOCK_STALE_MS,
  MAX_RUN_LOG_LINES,
  createRun,
  getRun,
  getRunLog,
  lastFinishedRun,
  lastSuccessfulRun,
  lastSuccessfulRunAt,
  listRuns,
  markStaleRunsInterrupted,
  readLock,
  refreshLock,
  releaseLock,
  tryAcquireLock,
  updateRun,
  type DB,
} from './db';
import { conflict, blocked, invalid, isDiskFullError } from './errors';
import { redactSecrets } from './redact';
import type { ApiSyncOptions } from './slack/sync';
import type { ImportSlackExportOptions } from './import/slack-export';
import type { RestoreBackupOptions } from './restore';

// ─── problems ─────────────────────────────────────────────────────────────────────────────────

export type ProblemKind = ProblemDTO['kind'];

const AUTH_CODES = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);

/** What kind of failure a job error is, for the plain-language messages of PLAN §8.5. */
export function classifyFailure(err: unknown): ProblemKind {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && AUTH_CODES.has(code)) return 'signed_out';
  if (code === 'wrong_account') return 'wrong_account';
  if (isDiskFullError(err)) return 'disk_full';
  const name = err instanceof Error ? err.name : '';
  if (name === 'SlackHttpError' || (name === 'DownloadError' && (err as { kind?: string }).kind === 'network'))
    return 'offline';
  if (
    err instanceof TypeError &&
    /fetch failed|network|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(`${err.message} ${String(err.cause)}`)
  ) {
    return 'offline';
  }
  return 'unexpected';
}

function kindOrUnexpected(kind: ProblemKind): Exclude<ProblemKind, 'wrong_account'> {
  return kind === 'wrong_account' ? 'unexpected' : kind;
}

export const PROBLEM_MESSAGES: Record<Exclude<ProblemKind, 'wrong_account'>, Omit<ProblemDTO, 'kind'>> = {
  signed_out: { message: 'Slack signed you out. Reconnect to keep archiving.', action: 'reconnect' },
  offline: { message: 'Can’t reach Slack right now. We’ll try again automatically.', action: 'retry' },
  disk_full: {
    message: 'Your disk is full, so new messages can’t be saved. Free up space and we’ll continue.',
    action: 'retry',
  },
  unexpected: { message: 'Something went wrong. Nothing was lost.', action: 'show_logs' },
};

export function problemFor(kind: ProblemKind | null, error: string | null): ProblemDTO | null {
  if (!kind) return null;
  if (kind === 'wrong_account')
    return { kind, message: error ?? 'This archive belongs to a different Slack account.', action: null };
  return { kind, ...PROBLEM_MESSAGES[kind] };
}

// ─── jobs ─────────────────────────────────────────────────────────────────────────────────────

export interface JobContext {
  signal: AbortSignal;
  onProgress: (p: SyncProgress) => void;
  log: (line: string) => void;
}

export type JobStats = Record<string, number>;

export interface RunJobs {
  runApiSync(opts: ApiSyncOptions): Promise<JobStats>;
  runFileDownloads(opts: Omit<ApiSyncOptions, 'conversationIds'>): Promise<JobStats>;
  importSlackExport(opts: ImportSlackExportOptions): Promise<JobStats>;
  /** Whether a chosen zip or folder is a Slamem backup (restored) rather than a Slack export. */
  isArchiveBackup(path: string): Promise<boolean>;
  restoreBackup(opts: RestoreBackupOptions): Promise<JobStats>;
}

/** Loaded lazily so the app window opens before the Slack client and zip reader are needed. */
export const defaultRunJobs: RunJobs = {
  runApiSync: async (opts) => (await import('./slack/sync')).runApiSync(opts),
  runFileDownloads: async (opts) => (await import('./slack/sync')).runFileDownloads(opts),
  importSlackExport: async (opts) => (await import('./import/slack-export')).importSlackExport(opts),
  isArchiveBackup: async (p) => (await import('./restore')).isArchiveBackup(p),
  restoreBackup: async (opts) => (await import('./restore')).restoreBackup(opts),
};

/** What RunManager needs from the Slack connection (ConnectionService satisfies it). */
export interface RunConnection {
  hasCredentials(): boolean;
  getCredentials(): { token: string; cookie: string } | null;
  /** `error`: why the connection needs attention, in plain language (e.g. "sign in again"). */
  status(): { expired: boolean; error?: string | null };
  markSignedOut(code: string): void;
}

export interface RunManagerOptions {
  db: DB;
  filesDir: string;
  prefs: { get(): PreferencesDTO };
  connection: RunConnection;
  /** Scratch space (a backup's database is unpacked here while it is merged). */
  tmpDir?: string;
  /** A restored backup's own "not archived" conversations, to add to this computer's list. */
  onExcludedConversations?: (ids: string[]) => void;
  /** Default https://slack.com/api (the development mock Slack overrides it). */
  apiBaseUrl?: string;
  jobs?: Partial<RunJobs>;
  /** App log (automatic actions, failures). */
  log?: (line: string) => void;
  persistIntervalMs?: number;
  lockRefreshMs?: number;
  lockStaleMs?: number;
  now?: () => number;
}

export type RunEvent =
  | { type: 'started'; run: SyncRunDTO }
  | { type: 'progress'; runId: number; progress: SyncProgress }
  | { type: 'log'; runId: number; line: string }
  | { type: 'finished'; run: SyncRunDTO };

export type RunListener = (event: RunEvent) => void;

export const SYNC_LOCK = 'sync';
export const STATUS_LOG_LINES = 50;
export const NOT_CONNECTED_REASON = 'Connect Slack to start archiving.';
/** Automatic syncs wait until onboarding asked what to archive (a sync started by hand still runs). */
export const ONBOARDING_REASON = 'Finish setting up Slamem to start archiving.';
/** Over two weeks late even for a monthly sync; what came in after it has 45 days left in Slack. */
const STALE_AFTER_MS = 45 * 86_400_000;
const SYNC_KINDS: readonly RunKind[] = ['sync'];
const FAILURE_KINDS: readonly RunKind[] = ['sync', 'files'];
const MAX_LINE_LENGTH = 2_000;

type StopReason = 'cancel' | 'lock-lost' | 'shutdown';

interface Outcome {
  status: RunStatus;
  stats: JobStats;
  error: string | null;
  problem: ProblemKind | null;
}

interface ActiveRun {
  id: number;
  kind: RunKind;
  startedAt: number;
  controller: AbortController;
  log: string[];
  logDirty: boolean;
  progress: SyncProgress | null;
  stopReason: StopReason | null;
  timers: NodeJS.Timeout[];
  finished: SyncRunDTO | null;
  done: Promise<SyncRunDTO>;
  resolveDone: (run: SyncRunDTO) => void;
}

type Job = (ctx: JobContext) => Promise<JobStats>;

const RUN_LABEL: Record<RunKind, string> = { sync: 'A sync', files: 'An attachment download', import: 'An import' };

export class RunManager {
  private readonly db: DB;
  private readonly opts: RunManagerOptions;
  private readonly jobs: RunJobs;
  private readonly owner = `app:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly listeners = new Set<RunListener>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private active: ActiveRun | null = null;
  private listsRefresh: Promise<void> | null = null;
  private lastLog: string[] | null = null;
  private nextRunAt: number | null = null;
  private closed = false;

  constructor(opts: RunManagerOptions) {
    this.db = opts.db;
    this.opts = opts;
    this.jobs = { ...defaultRunJobs, ...opts.jobs };
    this.now = opts.now ?? Date.now;
    const log = opts.log ?? (() => {});
    this.log = (line) => log(redactSecrets(line));
  }

  /** Boot housekeeping: runs left `running` by a crash become `error: interrupted`. */
  init(): number {
    return markStaleRunsInterrupted(this.db);
  }

  /** Why a Slack sync can't run right now (plain language), or null when it can. */
  blockedReason(): string | null {
    if (!this.opts.connection.hasCredentials()) return NOT_CONNECTED_REASON;
    const connection = this.opts.connection.status();
    if (connection.expired) return connection.error || PROBLEM_MESSAGES.signed_out.message;
    if (!this.opts.prefs.get().onboardingComplete) return ONBOARDING_REASON;
    return null;
  }

  isRunning(): boolean {
    return this.active != null;
  }

  activeKind(): RunKind | null {
    return this.active?.kind ?? null;
  }

  startSync(): number {
    this.assertCanReachSlack();
    return this.launch('sync', 'sync', (ctx) => this.runSlackJob(ctx, 'sync'));
  }

  /** Attachment downloads only (a file's Retry, or right after raising the attachment limit). */
  startFileDownloads(): number {
    this.assertCanReachSlack();
    return this.launch('files', 'attachment download', (ctx) => this.runSlackJob(ctx, 'files'));
  }

  /** Imports a Slack export, or restores a Slamem backup (moving from another computer). */
  startImport(exportPath: string): number {
    const resolved = resolveImportPath(exportPath);
    return this.launch('import', `import of ${path.basename(resolved)}`, async (ctx) => {
      if (await this.jobs.isArchiveBackup(resolved)) {
        return this.jobs.restoreBackup({
          ...ctx,
          db: this.db,
          path: resolved,
          filesDir: this.opts.filesDir,
          tmpDir: this.opts.tmpDir ?? path.join(this.opts.filesDir, '..', 'tmp'),
          onExcludedConversations: this.opts.onExcludedConversations,
        });
      }
      return this.jobs.importSlackExport({ ...ctx, db: this.db, path: resolved, filesDir: this.opts.filesDir });
    });
  }

  cancel(): boolean {
    const active = this.active;
    if (!active || active.stopReason) return false;
    this.appendLog(active, 'Cancel requested');
    this.stop(active, 'cancel');
    return true;
  }

  /** Resolves with the final record of `runId` (default: the active run) once it has finished. */
  async wait(runId?: number): Promise<SyncRunDTO | null> {
    const active = this.active;
    if (active && (runId == null || runId === active.id)) return active.done;
    return runId == null ? null : getRun(this.db, runId);
  }

  setNextRunAt(at: number | null): void {
    this.nextRunAt = at;
  }

  lastSuccessfulSyncAt(): number | null {
    return lastSuccessfulRunAt(this.db, SYNC_KINDS);
  }

  subscribe(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): SyncStatusDTO {
    const recentRuns = listRuns(this.db, 10);
    const blockedReason = this.blockedReason();
    const lastSuccess = lastSuccessfulRun(this.db, SYNC_KINDS);
    const lastSuccessAt = lastSuccess?.finishedAt ?? null;
    const common = {
      recentRuns,
      intervalMinutes: this.opts.prefs.get().syncIntervalMinutes,
      nextRunAt: blockedReason ? null : this.nextRunAt,
      lastSuccessAt,
      lastSuccessNewMessages: lastSuccess ? (lastSuccess.stats.messagesInserted ?? 0) : null,
      blockedReason,
      problem: this.currentProblem(),
      stale: lastSuccessAt != null && this.now() - lastSuccessAt > STALE_AFTER_MS,
    };
    const active = this.active;
    if (active) {
      return {
        ...common,
        running: true,
        currentRun: activeDTO(active),
        progress: active.progress,
        log: active.log.slice(-STATUS_LOG_LINES),
      };
    }
    const log = this.lastLog ?? (recentRuns[0] ? getRunLog(this.db, recentRuns[0].id).slice(-STATUS_LOG_LINES) : []);
    return { ...common, running: false, currentRun: null, progress: null, log };
  }

  /** Cancels the active run and waits (bounded) for it to stop; later starts are refused. */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.closed = true;
    const active = this.active;
    if (!active) return;
    this.stop(active, 'shutdown');
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([active.done, timedOut]);
    clearTimeout(timer);
    if (result === 'timeout')
      this.finish(active, {
        status: 'cancelled',
        stats: {},
        error: 'The app quit before the run stopped',
        problem: null,
      });
  }

  // ─── jobs ───────────────────────────────────────────────────────────────────────────────────

  private assertCanReachSlack(): void {
    const reason = this.blockedReason();
    if (reason && reason === NOT_CONNECTED_REASON) throw blocked(reason);
  }

  /**
   * Refreshes the people and conversation lists without fetching any history, so onboarding can
   * ask what to archive before the first sync. Not a run of its own: while a sync runs it
   * refreshes the lists itself, and this returns at once.
   */
  refreshLists(): Promise<void> {
    if (this.active) return Promise.resolve();
    this.listsRefresh ??= this.doRefreshLists().finally(() => {
      this.listsRefresh = null;
    });
    return this.listsRefresh;
  }

  private async doRefreshLists(): Promise<void> {
    this.assertCanReachSlack();
    try {
      const ctx: JobContext = {
        signal: new AbortController().signal,
        onProgress: () => undefined,
        log: (line) => this.log(line),
      };
      await this.runSlackJob(ctx, 'lists');
    } catch (err) {
      const kind = classifyFailure(err);
      const message =
        kind === 'wrong_account' && err instanceof Error
          ? err.message
          : PROBLEM_MESSAGES[kindOrUnexpected(kind)].message;
      throw blocked(message);
    }
  }

  private async runSlackJob(ctx: JobContext, kind: 'sync' | 'files' | 'lists'): Promise<JobStats> {
    const credentials = this.opts.connection.getCredentials();
    if (!credentials) {
      // A connection whose saved sign-in can't be read says why (and now shows Reconnect).
      const reason =
        (this.opts.connection.hasCredentials() && this.opts.connection.status().error) || NOT_CONNECTED_REASON;
      throw Object.assign(new Error(reason), { code: 'not_authed' });
    }
    const prefs = this.opts.prefs.get();
    const options: ApiSyncOptions = {
      ...ctx,
      db: this.db,
      token: credentials.token,
      cookie: credentials.cookie,
      baseUrl: this.opts.apiBaseUrl,
      filesDir: this.opts.filesDir,
      attachmentPolicy: prefs.attachmentPolicy,
      overlapSeconds: prefs.overlapDays * 86_400,
      // Read live: excluding a conversation during a sync takes effect before its turn comes.
      excludedConversationIds: () => this.opts.prefs.get().excludedConversationIds,
    };
    try {
      if (kind === 'files') return await this.jobs.runFileDownloads(options);
      return await this.jobs.runApiSync(kind === 'lists' ? { ...options, listsOnly: true } : options);
    } catch (err) {
      const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
      if (typeof code === 'string' && AUTH_CODES.has(code)) this.opts.connection.markSignedOut(code);
      throw err;
    }
  }

  private currentProblem(): ProblemDTO | null {
    if (this.opts.connection.hasCredentials()) {
      const connection = this.opts.connection.status();
      if (connection.expired)
        return {
          ...PROBLEM_MESSAGES.signed_out,
          kind: 'signed_out',
          message: connection.error || PROBLEM_MESSAGES.signed_out.message,
        };
    }
    const last = lastFinishedRun(this.db, FAILURE_KINDS);
    if (!last || last.status !== 'error') return null;
    // A failure from before the current sign-in (the user already reconnected) is old news.
    if (last.problem === 'signed_out') return null;
    return problemFor((last.problem as ProblemKind | null) ?? 'unexpected', last.error);
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────────────────────────

  private launch(kind: RunKind, description: string, job: Job): number {
    if (this.closed) throw blocked('Slamem is closing.');
    if (this.active) throw conflict(`${RUN_LABEL[this.active.kind]} is already running.`);
    this.acquireLock();
    let id: number;
    try {
      id = createRun(this.db, kind);
    } catch (err) {
      this.releaseLockQuietly();
      throw err;
    }
    const active = newActiveRun(id, kind, this.now());
    this.active = active;
    this.startTimers(active);
    this.emit({ type: 'started', run: activeDTO(active) });
    this.appendLog(active, `Started ${description}`);
    void this.execute(active, job);
    return id;
  }

  private acquireLock(): void {
    let acquired: boolean;
    try {
      acquired = tryAcquireLock(this.db, SYNC_LOCK, this.owner, this.opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);
    } catch {
      throw conflict('The archive is busy. Try again in a moment.');
    }
    if (!acquired || readLock(this.db, SYNC_LOCK)?.owner !== this.owner) {
      throw conflict('Another copy of Slamem is updating this archive. Try again when it finishes.');
    }
  }

  private releaseLockQuietly(): void {
    try {
      releaseLock(this.db, SYNC_LOCK, this.owner);
    } catch (err) {
      this.log(`Could not release the sync lock: ${String(err)}`);
    }
  }

  private async execute(active: ActiveRun, job: Job): Promise<void> {
    let outcome: Outcome;
    try {
      // Deferred a tick so launch() returns the run id before the job does anything.
      const stats = await Promise.resolve().then(() => job(this.jobContext(active)));
      outcome = successOutcome(active, stats);
    } catch (err) {
      outcome = failureOutcome(active, err);
      if (outcome.status === 'error')
        this.log(`Run #${active.id} (${active.kind}) failed: ${redactSecrets(errorMessage(err))}`);
    }
    this.finish(active, outcome);
  }

  private jobContext(active: ActiveRun): JobContext {
    return {
      signal: active.controller.signal,
      log: (line) => this.appendLog(active, line),
      onProgress: (p) => this.setProgress(active, p),
    };
  }

  private stop(active: ActiveRun, reason: StopReason): void {
    active.stopReason ??= reason;
    if (!active.controller.signal.aborted) active.controller.abort(new DOMException(stopMessage(reason), 'AbortError'));
  }

  private finish(active: ActiveRun, outcome: Outcome): SyncRunDTO {
    if (active.finished) return active.finished;
    for (const t of active.timers) clearInterval(t);
    const finishedAt = this.now();
    this.appendLog(active, summaryLine(outcome, finishedAt - active.startedAt));
    try {
      updateRun(this.db, active.id, { ...outcome, finishedAt, log: active.log });
    } catch (err) {
      this.log(`Could not record the end of run #${active.id}: ${errorMessage(err)}`);
    }
    this.releaseLockQuietly();
    const run = safeGetRun(this.db, active.id) ?? { ...activeDTO(active), ...outcome, finishedAt };
    active.finished = run;
    this.lastLog = active.log.slice(-STATUS_LOG_LINES);
    if (this.active === active) this.active = null;
    active.resolveDone(run);
    this.emit({ type: 'finished', run });
    return run;
  }

  private startTimers(active: ActiveRun): void {
    const persist = setInterval(() => this.persistLog(active), this.opts.persistIntervalMs ?? 5_000);
    const refresh = setInterval(() => this.refreshRunLock(active), this.opts.lockRefreshMs ?? 60_000);
    for (const t of [persist, refresh]) t.unref?.();
    active.timers.push(persist, refresh);
  }

  private persistLog(active: ActiveRun): void {
    if (!active.logDirty || active.finished) return;
    try {
      updateRun(this.db, active.id, { log: active.log });
      active.logDirty = false;
    } catch {
      // Busy database: the next tick (or the final write) catches up.
    }
  }

  private refreshRunLock(active: ActiveRun): void {
    if (active.finished) return;
    let held: boolean;
    try {
      held = refreshLock(this.db, SYNC_LOCK, this.owner);
    } catch {
      return;
    }
    if (held) return;
    this.appendLog(active, 'Another process took over the archive; stopping.');
    this.stop(active, 'lock-lost');
  }

  private appendLog(active: ActiveRun, message: string): void {
    if (active.finished) return;
    for (const raw of String(message).split(/\r?\n/)) {
      const text = redactSecrets(raw.trimEnd()).slice(0, MAX_LINE_LENGTH);
      if (!text) continue;
      const line = `${new Date(this.now()).toTimeString().slice(0, 8)} ${text}`;
      active.log.push(line);
      if (active.log.length > MAX_RUN_LOG_LINES * 2) active.log = active.log.slice(-MAX_RUN_LOG_LINES);
      active.logDirty = true;
      this.emit({ type: 'log', runId: active.id, line });
    }
  }

  private setProgress(active: ActiveRun, p: SyncProgress): void {
    if (active.finished) return;
    const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    active.progress = {
      phase: String(p?.phase ?? '').slice(0, 40),
      message: redactSecrets(String(p?.message ?? '')).slice(0, 300),
      current: n(p?.current),
      total: n(p?.total),
    };
    this.emit({ type: 'progress', runId: active.id, progress: active.progress });
  }

  private emit(event: RunEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log(`Run listener failed: ${errorMessage(err)}`);
      }
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────

function newActiveRun(id: number, kind: RunKind, startedAt: number): ActiveRun {
  let resolveDone!: (run: SyncRunDTO) => void;
  const done = new Promise<SyncRunDTO>((resolve) => {
    resolveDone = resolve;
  });
  return {
    id,
    kind,
    startedAt,
    controller: new AbortController(),
    log: [],
    logDirty: false,
    progress: null,
    stopReason: null,
    timers: [],
    finished: null,
    done,
    resolveDone,
  };
}

function activeDTO(active: ActiveRun): SyncRunDTO {
  const { id, kind, startedAt } = active;
  return { id, kind, status: 'running', startedAt, finishedAt: null, stats: {}, error: null };
}

function safeGetRun(db: DB, id: number): SyncRunDTO | null {
  try {
    return getRun(db, id);
  } catch {
    return null;
  }
}

function sanitizeStats(value: unknown): JobStats {
  const out: JobStats = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [k, v] of Object.entries(value)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

function successOutcome(active: ActiveRun, stats: unknown): Outcome {
  const clean = sanitizeStats(stats);
  if (active.stopReason === 'lock-lost')
    return { status: 'error', stats: clean, error: stopMessage('lock-lost'), problem: 'unexpected' };
  if (active.stopReason) return { status: 'cancelled', stats: clean, error: null, problem: null };
  return { status: 'ok', stats: clean, error: null, problem: null };
}

function failureOutcome(active: ActiveRun, err: unknown): Outcome {
  const stats = sanitizeStats(err && typeof err === 'object' ? (err as { syncStats?: unknown }).syncStats : undefined);
  switch (active.stopReason) {
    case 'cancel':
    case 'shutdown':
      return { status: 'cancelled', stats, error: null, problem: null };
    case 'lock-lost':
      return { status: 'error', stats, error: stopMessage('lock-lost'), problem: 'unexpected' };
    default:
      return {
        status: 'error',
        stats,
        error: redactSecrets(errorMessage(err)).slice(0, 2_000),
        problem: classifyFailure(err),
      };
  }
}

function stopMessage(reason: StopReason): string {
  switch (reason) {
    case 'cancel':
      return 'Cancelled';
    case 'shutdown':
      return 'Stopped because the app quit';
    case 'lock-lost':
      return 'Stopped: another process took over the archive';
  }
}

function summaryLine(outcome: Outcome, elapsedMs: number): string {
  const secs = `${(elapsedMs / 1000).toFixed(1)}s`;
  if (outcome.status === 'ok') return `Finished in ${secs}`;
  if (outcome.status === 'cancelled') return `Cancelled after ${secs}`;
  return `Failed after ${secs}: ${outcome.error ?? 'unknown error'}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** An import path chosen in the native picker: an existing directory or a .zip file. */
export function resolveImportPath(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0'))
    throw invalid('Choose a Slack export folder or .zip file.');
  const resolved = path.resolve(input.trim());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw invalid('That folder or file no longer exists.');
  }
  if (stat.isDirectory() || (stat.isFile() && /\.zip$/i.test(resolved))) return resolved;
  throw invalid('Choose a Slack export folder or a .zip file.');
}
