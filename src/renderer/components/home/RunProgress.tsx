import clsx from 'clsx';
import type { SyncProgress, SyncRunDTO } from '../../../shared/types';
import { formatFullDateTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { KIND_LABEL, phaseLabel, progressFraction, runDuration } from './runs';

export interface RunProgressProps {
  run: SyncRunDTO | null;
  progress: SyncProgress | null;
  className?: string;
  /** Hide the "Running for …" line (onboarding keeps it simple). */
  compact?: boolean;
}

/**
 * Live view of the active run: what it's doing in words ("Fetching #general — 1,240 messages so
 * far"), and a real progress bar when main reports a total (a calm pulse when it can't).
 */
export function RunProgress({ run, progress, className, compact = false }: RunProgressProps) {
  const now = useNow(1000);
  const fraction = progressFraction(progress);
  const percent = fraction == null ? null : Math.round(fraction * 100);
  const counter =
    progress?.current != null && progress.total
      ? `${progress.current.toLocaleString()} of ${progress.total.toLocaleString()}`
      : null;
  const phase = phaseLabel(progress?.phase);
  const label = `${run ? KIND_LABEL[run.kind] : 'Sync'} progress`;

  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="font-medium text-ink">{phase}</span>
        {counter && (
          <span className="shrink-0 text-ink-muted tabular-nums">
            {counter}
            {percent != null && <span className="text-ink-faint"> · {percent}%</span>}
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent != null ? `${phase}, ${percent}%` : phase}
        className="h-2 overflow-hidden rounded-full bg-inset"
      >
        {percent != null ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
            style={{ width: `${Math.max(percent, 2)}%` }}
          />
        ) : (
          // No total for this phase: a pulsing bar says "working" without inventing a number.
          <div className="h-full w-full animate-pulse rounded-full bg-accent/45" />
        )}
      </div>
      {progress?.message && (
        <p className="truncate text-xs text-ink-muted" title={progress.message}>
          {progress.message}
        </p>
      )}
      {run && !compact && (
        <p className="text-xs text-ink-faint" title={`Started ${formatFullDateTime(new Date(run.startedAt))}`}>
          Running for {runDuration(run, now)}
        </p>
      )}
    </div>
  );
}
