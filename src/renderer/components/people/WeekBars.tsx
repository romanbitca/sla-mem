import { useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import type { PersonWeekDTO } from '../../../shared/types';
import { formatDate, pluralize } from '../../lib/format';

/**
 * Messages between you per week, as columns. One series, so no legend: the card's title says
 * what they count. Each column tells its week on hover and on keyboard focus (one tab stop, the
 * arrow keys move between weeks), and a table carries the same numbers for screen readers.
 */
export function WeekBars({ weeks }: { weeks: readonly PersonWeekDTO[] }) {
  const [active, setActive] = useState(weeks.length - 1);
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  if (weeks.length === 0) return null;
  const current = Math.min(active, weeks.length - 1);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const total = weeks.reduce((n, w) => n + w.count, 0);
  const busiest = weeks.reduce((a, b) => (b.count > a.count ? b : a));
  const label = (w: PersonWeekDTO) => formatDate(new Date(w.start * 1000), 'MMM d');

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const next =
      e.key === 'ArrowLeft'
        ? current - 1
        : e.key === 'ArrowRight'
          ? current + 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? weeks.length - 1
              : null;
    if (next == null) return;
    e.preventDefault();
    const index = Math.max(0, Math.min(weeks.length - 1, next));
    setActive(index);
    refs.current[index]?.focus();
  };

  return (
    <figure className="flex flex-col gap-2">
      <div className="flex h-20 items-end gap-0.5">
        {weeks.map((w, i) => (
          <span
            key={w.start}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="img"
            tabIndex={i === current ? 0 : -1}
            onKeyDown={onKeyDown}
            onFocus={() => setActive(i)}
            aria-label={`Week of ${label(w)}: ${pluralize(w.count, 'message')}`}
            className="group/week focus-ring relative flex h-full min-w-0 flex-1 items-end justify-center rounded-sm outline-none"
          >
            <span
              className={clsx(
                'w-full max-w-6 transition-opacity duration-100',
                w.count > 0
                  ? 'rounded-t-[4px] bg-chart group-hover/week:opacity-75 group-focus-visible/week:opacity-75'
                  : 'bg-line',
              )}
              style={{ height: w.count > 0 ? `${Math.max(4, (w.count / max) * 100)}%` : 2 }}
            />
            {/* Hidden, not just invisible, so it takes no room at the edges; it opens away from the
                nearer edge of the chart. */}
            <span
              role="tooltip"
              className={clsx(
                'pointer-events-none absolute bottom-full z-30 mb-1.5 hidden w-max rounded-md bg-tooltip px-2 py-1 text-xs leading-snug text-tooltip-ink shadow-lg group-hover/week:block group-focus-visible/week:block',
                i < weeks.length / 2 ? 'left-0' : 'right-0',
              )}
            >
              <strong className="font-semibold tabular-nums">{w.count.toLocaleString()}</strong>{' '}
              <span className="opacity-80">· week of {label(w)}</span>
            </span>
          </span>
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-ink-faint tabular-nums" aria-hidden="true">
        <span>{label(weeks[0])}</span>
        <span>This week</span>
      </div>
      <figcaption className="text-xs text-ink-muted">
        {pluralize(total, 'message')} in {pluralize(weeks.length, 'week')}
        {busiest.count > 0 && ` · busiest: the week of ${label(busiest)} (${busiest.count.toLocaleString()})`}
      </figcaption>
      <table className="sr-only">
        <caption>Messages between you per week</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Messages</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.start}>
              <td>{label(w)}</td>
              <td>{w.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
