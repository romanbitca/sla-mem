import { memo } from 'react';
import { formatDate, formatDayLabel, isBeyondFreeWindow } from '../../lib/format';
import { ArchiveIcon } from '../icons';

/**
 * Sticky date header for one day section. The whole band is opaque (PLAN §8.2): while it sticks
 * to the top, messages scroll underneath it instead of showing around a floating pill. Days older
 * than 90 days are marked as only in the archive, except where Slack keeps them (`keptBySlack`:
 * notes to yourself).
 */
export const DayDivider = memo(function DayDivider({
  date,
  id,
  keptBySlack = false,
}: {
  date: Date;
  id: string;
  keptBySlack?: boolean;
}) {
  const beyond = !keptBySlack && isBeyondFreeWindow(date);
  return (
    <h2 id={id} className="sticky top-0 z-[5] flex items-center gap-3 bg-canvas px-5 py-2">
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
      <span
        className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-canvas px-3 text-xs font-semibold text-ink-muted shadow-xs"
        title={
          beyond
            ? `${formatDate(date, 'PPPP')} · older than 90 days: no longer visible in Slack`
            : formatDate(date, 'PPPP')
        }
      >
        {formatDayLabel(date)}
        {beyond && (
          <>
            <ArchiveIcon size={12} className="text-ink-faint" />
            <span className="sr-only">(only in the archive)</span>
          </>
        )}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </h2>
  );
});
