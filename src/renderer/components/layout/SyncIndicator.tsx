import { Link } from 'react-router';
import { formatDistanceToNowStrict } from 'date-fns';
import clsx from 'clsx';
import type { SyncStatusDTO } from '../../../shared/types';
import { Spinner } from '../ui/Spinner';

export interface SyncIndicatorProps {
  status: SyncStatusDTO | undefined;
  error: unknown;
  /** No Slack session saved: say so and point at Settings instead of the archive home. */
  needsConnection?: boolean;
}

type Tone = 'ok' | 'warn' | 'bad' | 'busy';

export function describeSync(
  status: SyncStatusDTO | undefined,
  error: unknown,
  needsConnection: boolean,
): { text: string; tone: Tone; toSettings: boolean } {
  if (!status) {
    return error
      ? { text: 'Sync status unavailable', tone: 'warn', toSettings: false }
      : { text: 'Checking…', tone: 'ok', toSettings: false };
  }
  if (status.running) {
    const p = status.progress;
    const count = p?.current != null && p.total ? ` ${p.current.toLocaleString()} of ${p.total.toLocaleString()}` : '';
    const what = status.currentRun?.kind === 'import' ? 'Importing' : 'Syncing';
    return { text: `${what}…${count}`, tone: 'busy', toSettings: false };
  }
  if (status.problem?.kind === 'signed_out') return { text: 'Reconnect Slack', tone: 'warn', toSettings: true };
  if (needsConnection) return { text: 'Connect Slack', tone: 'warn', toSettings: true };
  if (status.problem) return { text: 'Last sync didn’t finish', tone: 'bad', toSettings: false };
  if (status.lastSuccessAt) {
    const ago = formatDistanceToNowStrict(new Date(Math.min(status.lastSuccessAt, Date.now())), { addSuffix: true });
    return { text: `Synced ${ago}`, tone: status.stale ? 'warn' : 'ok', toSettings: false };
  }
  return { text: 'Not synced yet', tone: 'warn', toSettings: false };
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
  const { text, tone, toSettings } = describeSync(status, error, needsConnection);
  return (
    <Link
      to={toSettings ? '/settings' : '/'}
      className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-hover hover:text-ink"
      title={toSettings ? 'Open Settings to connect Slack' : status?.progress?.message || text}
    >
      {tone === 'busy' ? (
        <Spinner size={12} className="shrink-0 text-accent-text" />
      ) : (
        <span className={clsx('size-2 shrink-0 rounded-full', DOT[tone])} aria-hidden="true" />
      )}
      <span className="truncate" role="status">
        {text}
      </span>
    </Link>
  );
}
