import clsx from 'clsx';
import { localTimeIn, timeDifferenceLabel } from '../../lib/people';
import { ClockIcon } from '../icons';

/**
 * Someone's clock, from their Slack time zone: "4:12 PM local time · 1 hour ahead of you". The
 * compact form (lists) shows only a clock that differs from yours.
 */
export function LocalTime({
  tz,
  tzLabel,
  now,
  compact = false,
  className,
}: {
  tz: string | null;
  /** Slack's name for the zone, for the tooltip. */
  tzLabel?: string | null;
  now: number;
  compact?: boolean;
  className?: string;
}) {
  if (!tz) return null;
  const info = localTimeIn(tz, new Date(now));
  if (!info) return null;
  const difference = timeDifferenceLabel(info.diffMinutes);
  // "1 hour ahead of you", "1 hour behind you".
  const relative = difference && `${difference}${info.diffMinutes > 0 ? ' of' : ''} you`;
  if (compact) {
    if (!relative) return null;
    return (
      <span
        title={`${info.time} for them, ${relative}`}
        className={clsx('inline-flex shrink-0 items-center gap-1 text-xs text-ink-faint tabular-nums', className)}
      >
        <ClockIcon size={12} />
        {info.time}
      </span>
    );
  }
  return (
    <span title={tzLabel ?? tz} className={clsx('inline-flex items-center gap-1.5', className)}>
      <ClockIcon size={14} className="shrink-0 text-ink-faint" />
      <span>
        {info.time} local time
        {relative ? ` · ${relative}` : ' · same as yours'}
      </span>
    </span>
  );
}
