import { Link } from 'react-router';
import clsx from 'clsx';
import type { SyncStatusDTO } from '../../../shared/types';
import { presentableMessage } from '../../lib/api';
import { useNow } from '../../lib/hooks';
import { timeAgo } from '../home/runs';
import { Spinner } from '../ui/Spinner';

export interface SyncIndicatorProps {
  status: SyncStatusDTO | undefined;
  error: unknown;
  /** No Slack session saved: say so and point at Settings instead of the archive home. */
  needsConnection?: boolean;
}

type Tone = 'ok' | 'warn' | 'bad' | 'busy';

export interface SyncSummary {
  text: string;
  tone: Tone;
  toSettings: boolean;
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
      ? { text: 'Sync status unavailable', tone: 'warn', toSettings: false, announce: '' }
      : { text: 'Checking…', tone: 'ok', toSettings: false, announce: '' };
  }
  if (status.running) {
    const p = status.progress;
    const count = p?.current != null && p.total ? ` ${p.current.toLocaleString()} of ${p.total.toLocaleString()}` : '';
    const what = status.currentRun?.kind === 'import' ? 'Importing' : 'Syncing';
    return {
      text: `${what}…${count}`,
      tone: 'busy',
      toSettings: false,
      detail: presentableMessage(p?.message, '') || undefined,
      announce: `${what}…`,
    };
  }
  if (status.problem?.kind === 'signed_out') {
    return { text: 'Reconnect Slack', tone: 'warn', toSettings: true, announce: 'Reconnect Slack' };
  }
  if (needsConnection) return { text: 'Connect Slack', tone: 'warn', toSettings: true, announce: 'Connect Slack' };
  if (status.blockedReason) {
    const detail = presentableMessage(status.blockedReason, 'Syncing isn’t possible right now.');
    return { text: 'Sync paused', tone: 'warn', toSettings: false, detail, announce: 'Sync paused' };
  }
  if (status.problem) {
    return { text: 'Last sync didn’t finish', tone: 'bad', toSettings: false, announce: 'Last sync didn’t finish' };
  }
  if (status.lastSuccessAt) {
    const ago = timeAgo(status.lastSuccessAt, now);
    return {
      text: ago ? `Synced ${ago}` : 'Synced',
      tone: status.stale ? 'warn' : 'ok',
      toSettings: false,
      announce: 'Synced',
    };
  }
  return { text: 'Not synced yet', tone: 'warn', toSettings: false, announce: 'Not synced yet' };
}

const DOT: Record<Exclude<Tone, 'busy'>, string> = {
  ok: 'bg-success',
  warn: 'bg-warn',
  bad: 'bg-danger',
};

/**
 * Compact status line in the sidebar footer. Links to the archive home, where syncing is shown
 * in full, or to Settings when Slack needs connecting.
 */
export function SyncIndicator({ status, error, needsConnection = false }: SyncIndicatorProps) {
  // Pushed updates only arrive when something changes; "Synced 5 minutes ago" must still move on.
  const now = useNow(30_000);
  const { text, tone, toSettings, detail, announce } = describeSync(status, error, needsConnection, now);
  return (
    <>
      <Link
        to={toSettings ? '/settings' : '/'}
        className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-hover hover:text-ink"
        title={toSettings ? 'Open Settings to connect Slack' : detail || text}
      >
        {tone === 'busy' ? (
          <Spinner size={12} className="shrink-0 text-accent-text" />
        ) : (
          <span className={clsx('size-2 shrink-0 rounded-full', DOT[tone])} aria-hidden="true" />
        )}
        <span className="truncate">{text}</span>
      </Link>
      <span className="sr-only" role="status">
        {announce}
      </span>
    </>
  );
}
