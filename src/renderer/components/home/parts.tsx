/** Small building blocks shared by the archive-home and settings panels. */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { RunStatus, SyncStatusDTO } from '../../../shared/types';
import { formatFullDateTime, isoDateTime } from '../../lib/format';
import { STATUS_LABEL, newMessagesLabel, relativeTime, timeAgo } from './runs';

const STATUS_STYLE: Record<RunStatus, string> = {
  running: 'bg-accent-soft text-accent-text',
  ok: 'bg-success/12 text-success',
  error: 'bg-danger-soft text-danger',
  cancelled: 'bg-inset text-ink-muted',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_STYLE[status],
      )}
    >
      <span
        aria-hidden="true"
        className={clsx('size-1.5 rounded-full bg-current', status === 'running' && 'animate-pulse')}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Inline code chip for prose. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-line bg-inset px-1 py-px font-mono text-[12px] text-ink">{children}</code>
  );
}

/** A labelled fact in a small grid: "Last sync · 5 minutes ago". */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}

/** "Last successful sync · just now · 13 new messages". */
export function LastSyncFact({ status, now }: { status: SyncStatusDTO; now: number }) {
  return (
    <Fact label="Last successful sync">
      {status.lastSuccessAt ? (
        <>
          <TimeAgo ms={status.lastSuccessAt} now={now} past />
          {status.lastSuccessNewMessages != null && (
            <span className="text-ink-muted"> · {newMessagesLabel(status.lastSuccessNewMessages)}</span>
          )}
        </>
      ) : (
        'Not yet'
      )}
    </Fact>
  );
}

/** `past`: the time of something that already happened (see `timeAgo`). */
export function TimeAgo({ ms, now, past = false }: { ms: number; now: number; past?: boolean }) {
  const date = new Date(ms);
  return (
    <time dateTime={isoDateTime(date)} title={formatFullDateTime(date)}>
      {past ? timeAgo(ms, now) : relativeTime(ms, now)}
    </time>
  );
}
