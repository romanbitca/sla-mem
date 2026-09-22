import { Link } from 'react-router';
import clsx from 'clsx';
import type { MessageDTO } from '../../../shared/types';
import { formatFullDateTime, formatShortTime, formatTime, isoDateTime } from '../../lib/format';
import { messagePath } from '../../lib/links';
import { tsToDate } from '../../lib/ts';

/**
 * Short time that links to the message itself; the full date is on hover. `compact` drops AM/PM
 * for the narrow column beside a grouped message.
 */
export function MessageTime({
  message,
  className,
  compact = false,
}: {
  message: MessageDTO;
  className?: string;
  compact?: boolean;
}) {
  const date = tsToDate(message.ts);
  const full = formatFullDateTime(date);
  return (
    <Link
      to={messagePath(message)}
      className={clsx(
        'focus-ring rounded text-xs whitespace-nowrap text-ink-faint tabular-nums hover:text-ink-muted hover:underline',
        className,
      )}
      title={full}
      aria-label={full || 'Open this message'}
    >
      <time dateTime={isoDateTime(date)}>{(compact ? formatShortTime(date) : formatTime(date)) || '—'}</time>
    </Link>
  );
}
