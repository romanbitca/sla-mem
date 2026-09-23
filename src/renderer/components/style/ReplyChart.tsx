import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import type { ReplyPeriodDTO } from '../../../shared/types';
import { pluralize } from '../../lib/format';
import { formatWait, periodAxis, periodLabel, trimLeadingEmpty } from '../../lib/style';

export type ReplyUnit = 'week' | 'month';

const UNITS: { unit: ReplyUnit; label: string; chart: string }[] = [
  { unit: 'week', label: 'Weeks', chart: 'Your average reply time per week' },
  { unit: 'month', label: 'Months', chart: 'Your average reply time per month' },
];

/**
 * Your average reply time per week or per month (the last 12 of each), taller for slower. Pointing
 * at a bar, or moving along them with the arrow keys, shows its numbers; weeks without answers keep
 * a low grey slot, so the chart still reads as a timeline.
 */
export function ReplyChart({
  weeks,
  months,
  info,
}: {
  weeks: ReplyPeriodDTO[];
  months: ReplyPeriodDTO[];
  /** Beside the heading: how the chart is worked out. */
  info?: ReactNode;
}) {
  const [unit, setUnit] = useState<ReplyUnit>('week');
  const periods = trimLeadingEmpty(unit === 'week' ? weeks : months);
  const chart = UNITS.find((u) => u.unit === unit)!;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h3 className="text-xs font-semibold text-ink-faint">Over time</h3>
          {info}
        </div>
        <div
          role="group"
          aria-label="Show reply time by"
          className="flex w-fit rounded-lg border border-line bg-raised p-0.5"
        >
          {UNITS.map((u) => (
            <button
              key={u.unit}
              type="button"
              aria-pressed={unit === u.unit}
              onClick={() => setUnit(u.unit)}
              className={clsx(
                'focus-ring inline-flex h-6.5 items-center rounded-md px-2.5 text-[12.5px] transition-colors',
                unit === u.unit
                  ? 'bg-accent-soft font-medium text-accent-text'
                  : 'text-ink-muted hover:bg-hover hover:text-ink',
              )}
            >
              {u.label}
            </button>
          ))}
        </div>
      </div>
      {periods.length ? (
        <Bars key={unit} periods={periods} unit={unit} label={chart.chart} />
      ) : (
        <p className="text-[13px] text-ink-muted">No answers to show yet.</p>
      )}
    </div>
  );
}

function describe(p: ReplyPeriodDTO, unit: ReplyUnit): string {
  return p.averageSeconds == null
    ? `${periodLabel(p, unit)}: no answers`
    : `${periodLabel(p, unit)}: ${formatWait(p.averageSeconds)} on average, ${pluralize(p.count, 'answer')}`;
}

function Bars({ periods, unit, label }: { periods: ReplyPeriodDTO[]; unit: ReplyUnit; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [focusable, setFocusable] = useState(periods.length - 1);
  const listRef = useRef<HTMLOListElement>(null);
  const max = Math.max(...periods.map((p) => p.averageSeconds ?? 0), 1);

  const focusBar = (i: number) => {
    const index = Math.max(0, Math.min(periods.length - 1, i));
    setFocusable(index);
    listRef.current?.querySelectorAll<HTMLElement>('li')[index]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: focusable - 1,
      ArrowRight: focusable + 1,
      Home: 0,
      End: periods.length - 1,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    focusBar(moves[e.key]);
  };

  const shown = active != null ? periods[active] : null;
  return (
    <div className="relative pt-14">
      {shown && active != null && (
        <Tip index={active} count={periods.length}>
          <span className="block font-medium text-ink">{periodLabel(shown, unit)}</span>
          <span className="block text-ink-muted tabular-nums">
            {shown.averageSeconds == null
              ? 'No answers'
              : `${formatWait(shown.averageSeconds)} on average · ${pluralize(shown.count, 'answer')}`}
          </span>
        </Tip>
      )}
      <ol
        ref={listRef}
        aria-label={label}
        onKeyDown={onKeyDown}
        onMouseLeave={() => setActive(listRef.current?.contains(document.activeElement) ? focusable : null)}
        className="flex h-28 items-end gap-1"
      >
        {periods.map((p, i) => {
          const height = p.averageSeconds != null ? `max(${(p.averageSeconds / max) * 100}%, 4px)` : '3px';
          const current = i === periods.length - 1;
          return (
            <li
              key={p.start}
              tabIndex={i === focusable ? 0 : -1}
              aria-label={describe(p, unit)}
              onMouseEnter={() => setActive(i)}
              onFocus={() => {
                setFocusable(i);
                setActive(i);
              }}
              onBlur={() => setActive(null)}
              className="focus-ring flex h-full min-w-0 flex-1 cursor-default items-end justify-center rounded-t-sm"
            >
              <span
                aria-hidden="true"
                style={{ height }}
                className={clsx(
                  'block w-full max-w-9 rounded-t-[3px] transition-colors duration-100',
                  p.averageSeconds == null
                    ? active === i
                      ? 'bg-ink-faint'
                      : 'bg-line-strong'
                    : active === i
                      ? 'bg-accent'
                      : current
                        ? 'bg-accent/80'
                        : 'bg-accent/50',
                )}
              />
            </li>
          );
        })}
      </ol>
      <div aria-hidden="true" className="mt-1.5 flex justify-between text-[11px] text-ink-faint">
        <span>{periodAxis(periods[0], unit)}</span>
        {periods.length > 1 && <span>{periodAxis(periods[periods.length - 1], unit)}</span>}
      </div>
    </div>
  );
}

/** The numbers above the bar in view, kept inside the chart at either end. */
function Tip({ index, count, children }: { index: number; count: number; children: ReactNode }) {
  const center = ((index + 0.5) / count) * 100;
  const align = center < 20 ? 'start' : center > 80 ? 'end' : 'center';
  return (
    <div
      aria-hidden="true"
      style={align === 'start' ? { left: 0 } : align === 'end' ? { right: 0 } : { left: `${center}%` }}
      className={clsx(
        'pointer-events-none absolute top-0 z-10 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs whitespace-nowrap shadow-pop',
        align === 'center' && '-translate-x-1/2',
      )}
    >
      {children}
    </div>
  );
}
