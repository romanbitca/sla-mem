/**
 * Presentation helpers for sync/import runs. Pure, so the wording of statuses, durations and
 * run summaries is unit-tested in one place. Everything here is for non-technical readers:
 * no counter names, no API calls, no error codes (the raw log is one "Show logs" click away).
 */
import { formatDistanceStrict } from 'date-fns';
import type {
  RunKind,
  RunStatus,
  SlackConnectionDTO,
  StatsDTO,
  SyncProgress,
  SyncRunDTO,
  SyncStatusDTO,
  WorkspaceDTO,
} from '../../../shared/types';

export const KIND_LABEL: Record<RunKind, string> = { sync: 'Sync', files: 'Attachment downloads', import: 'Import' };

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  ok: 'Done',
  error: 'Didn’t finish',
  cancelled: 'Cancelled',
};

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** "just now", "5 minutes ago", "in 12 minutes". */
export function relativeTime(ms: number, now: number): string {
  if (Math.abs(ms - now) < 45_000) return ms <= now ? 'just now' : 'in a moment';
  return formatDistanceStrict(ms, now, { addSuffix: true });
}

/**
 * `relativeTime` for something that already happened (a finished run, a connection check). The
 * `now` from `useNow` can lag behind by up to its tick, and a sync that finished after the last
 * tick must still read "just now", not "in a moment".
 */
export function timeAgo(ms: number, now: number): string {
  return relativeTime(Math.min(ms, now), now);
}

export function runDuration(run: SyncRunDTO, now: number): string {
  return formatDuration((run.finishedAt ?? now) - run.startedAt);
}

/** The counters worth telling people about, in this order, as [singular, plural]. */
const COUNTERS: [key: string, singular: string, plural: string][] = [
  ['messagesInserted', 'new message', 'new messages'],
  ['messagesUpdated', 'updated message', 'updated messages'],
  ['revisions', 'edit saved', 'edits saved'],
  ['filesDownloaded', 'attachment saved', 'attachments saved'],
  ['filesFailed', 'attachment couldn’t be downloaded', 'attachments couldn’t be downloaded'],
];

export function counterLabel(key: string, count: number): string | null {
  const known = COUNTERS.find(([k]) => k === key);
  return known ? (count === 1 ? known[1] : known[2]) : null;
}

/** One line for the history list: what the run brought in, in words. */
export function summarizeRun(run: SyncRunDTO): string {
  const parts = COUNTERS.flatMap(([key, singular, plural]) => {
    const n = run.stats[key];
    return typeof n === 'number' && Number.isFinite(n) && n > 0
      ? [`${n.toLocaleString()} ${n === 1 ? singular : plural}`]
      : [];
  });
  const counts = parts.join(' · ');
  switch (run.status) {
    case 'running':
      return counts ? `In progress · ${counts} so far` : 'In progress';
    case 'cancelled':
      return counts ? `Cancelled · ${counts} kept` : 'Cancelled';
    case 'error':
      return counts ? `Didn’t finish · ${counts} kept` : 'Didn’t finish';
    default:
      if (counts) return counts;
      return run.kind === 'import' ? 'Nothing new in the export' : 'Up to date: nothing new';
  }
}

const PHASE_LABELS: Record<string, string> = {
  auth: 'Checking your Slack connection',
  users: 'Getting the list of people',
  conversations: 'Listing your conversations',
  history: 'Fetching messages',
  threads: 'Fetching thread replies',
  emoji: 'Fetching custom emoji',
  files: 'Downloading attachments',
  import: 'Importing the export',
};

export function phaseLabel(phase: string | null | undefined): string {
  if (!phase) return 'Starting…';
  return PHASE_LABELS[phase] ?? 'Working…';
}

/** 0–1 when the run reports a total, null for indeterminate phases. */
export function progressFraction(progress: SyncProgress | null | undefined): number | null {
  if (!progress || progress.current == null || !progress.total || progress.total <= 0) return null;
  return Math.min(1, Math.max(0, progress.current / progress.total));
}

/**
 * Which "Connect Slack" prompt the archive home shows, if any:
 *  - 'expired': Slack signed the saved session out (reconnect);
 *  - 'first-run': nothing archived, nothing running and no connection: connecting is the next step;
 *  - 'not-connected': there is data (e.g. an import) but no connection to keep it current.
 */
export type ConnectPrompt = 'first-run' | 'not-connected' | 'expired';

export function connectPrompt(
  workspace: WorkspaceDTO | undefined,
  stats: StatsDTO | undefined,
  status: SyncStatusDTO | undefined,
  connection: SlackConnectionDTO | undefined,
): ConnectPrompt | null {
  if (connection?.expired) return 'expired';
  if (!workspace || workspace.connected || connection?.connected) return null;
  if (stats?.messageCount === 0 && status?.running !== true) return 'first-run';
  return 'not-connected';
}
