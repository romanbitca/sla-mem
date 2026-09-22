import clsx from 'clsx';
import type { SyncStatusDTO } from '../../../shared/types';
import { presentableMessage } from '../../lib/api';
import { useNow } from '../../lib/hooks';
import { timeAgo } from '../home/runs';
import { Spinner } from '../ui/Spinner';

export interface SyncIndicatorProps {
  status: SyncStatusDTO | undefined;
  error: unknown;
  /** No Slack session saved: say so. */
  needsConnection?: boolean;
}

type Tone = 'ok' | 'warn' | 'bad' | 'busy';

export interface SyncSummary {
  text: string;
  tone: Tone;
  /** Longer explanation for the tooltip, when there is one. */
  detail?: string;
  /**
   * What a screen reader hears when it changes: the state only, never the ticking counts or
   * "N minutes ago", so a running sync isn't read out every second.
   */
  announce: string;
}

export function describeSync(
  status: SyncStatusDTO | undefined,
  error: unknown,
  needsConnection: boolean,
  now: number = Date.now(),
): SyncSummary {
  if (!status) {
    return error
      ? { text: 'Sync status unavailable', tone: 'warn', announce: '' }
      : { text: 'Checking…', tone: 'ok', announce: '' };
  }
  if (status.running) {
    const p = status.progress;
    const count = p?.current != null && p.total ? ` ${p.current.toLocaleString()} of ${p.total.toLocaleString()}` : '';
    const what = status.currentRun?.kind === 'import' ? 'Importing' : 'Syncing';
    return {
      text: `${what}…${count}`,
      tone: 'busy',
      detail: presentableMessage(p?.message, '') || undefined,
      announce: `${what}…`,
    };
  }
  if (status.problem?.kind === 'signed_out') {
    return { text: 'Reconnect Slack', tone: 'warn', announce: 'Reconnect Slack' };
  }
  if (needsConnection) return { text: 'Connect Slack', tone: 'warn', announce: 'Connect Slack' };
  if (status.blockedReason) {
    const detail = presentableMessage(status.blockedReason, 'Syncing isn’t possible right now.');
    return { text: 'Sync paused', tone: 'warn', detail, announce: 'Sync paused' };
  }
  if (status.problem) {
    return { text: 'Last sync didn’t finish', tone: 'bad', announce: 'Last sync didn’t finish' };
  }
  if (status.lastSuccessAt) {
    const ago = timeAgo(status.lastSuccessAt, now);
    return {
      text: ago ? `Synced ${ago}` : 'Synced',
      tone: status.stale ? 'warn' : 'ok',
      announce: 'Synced',
    };
  }
  return { text: 'Not synced yet', tone: 'warn', announce: 'Not synced yet' };
}

const DOT: Record<Exclude<Tone, 'busy'>, string> = {
  ok: 'bg-success',
  warn: 'bg-warn',
  bad: 'bg-danger',
};

/**
 * Compact status line in the sidebar footer: text, not a control (Overview shows syncing in full,
 * and the gear beside it opens Settings). A tooltip adds only what the line leaves out, such as
 * what a running sync is fetching or why syncing is paused.
 */
export function SyncIndicator({ status, error, needsConnection = false }: SyncIndicatorProps) {
  // Pushed updates only arrive when something changes; "Synced 5 minutes ago" must still move on.
  const now = useNow(30_000);
  const { text, tone, detail, announce } = describeSync(status, error, needsConnection, now);
  return (
    <>
      <p
        className="flex min-w-0 flex-1 cursor-default items-center gap-2 px-2 py-1 text-xs text-ink-muted"
        title={detail}
      >
        {tone === 'busy' ? (
          <Spinner size={12} className="shrink-0 text-accent-text" />
        ) : (
          <span className={clsx('size-2 shrink-0 rounded-full', DOT[tone])} aria-hidden="true" />
        )}
        <span className="truncate">{text}</span>
      </p>
      <span className="sr-only" role="status">
        {announce}
      </span>
    </>
  );
}
