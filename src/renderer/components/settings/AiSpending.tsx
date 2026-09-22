import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import type { AiSpendingDayDTO } from '../../../shared/types';
import {
  axisLabel,
  bucketLabel,
  formatUsd,
  spendingBuckets,
  spendingTotals,
  type SpendingBucket,
  type SpendingTotal,
  type SpendingUnit,
} from '../../lib/aiSpending';
import { formatDate, pluralize } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useAiSpending } from '../../lib/queries';
import { ChevronDownIcon } from '../icons';
import { ErrorState } from '../ui/EmptyState';
import { Spinner } from '../ui/Spinner';

/**
 * Settings → Ask AI → Spending, folded away until opened: what the questions cost today, this
 * week and this month, and a bar chart by day, week or month. Pointing at a bar (or moving along
 * them with the arrow keys) shows its numbers.
 */
export function AiSpending() {
  const [open, setOpen] = useState(false);
  const spending = useAiSpending();
  const panelId = useId();
  // The day can turn while Settings stays open. A few hundred days at most: no need to memoize.
  const today = new Date(useNow(60_000));
  const days = spending.data?.days;
  const totals = days ? spendingTotals(days, today) : null;

  let summary = '';
  if (totals) summary = totals.all.questions ? `${formatUsd(totals.month.costUsd)} this month` : 'Nothing yet';

  return (
    <div className="-mx-5 -mb-4 border-t border-line">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
          className={clsx(
            'focus-ring flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-hover/60',
            !open && 'rounded-b-2xl',
          )}
        >
          <ChevronDownIcon
            size={14}
            className={clsx('shrink-0 text-ink-faint transition-transform duration-150', !open && '-rotate-90')}
          />
          <span className="text-[13.5px] font-medium text-ink">Spending</span>
          <span className="ml-auto text-xs text-ink-muted tabular-nums">{summary}</span>
        </button>
      </h3>
      {open && (
        <div id={panelId} className="flex flex-col gap-4 px-5 pt-1 pb-4">
          {totals && days ? (
            <SpendingPanel days={days} today={today} totals={totals} />
          ) : spending.isError ? (
            <ErrorState
              compact
              error={spending.error}
              title="Couldn’t load what Ask AI has cost"
              onRetry={() => void spending.refetch()}
            />
          ) : (
            <p className="flex items-center gap-2 text-xs text-ink-faint">
              <Spinner size={12} /> Adding it up…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const UNITS: { unit: SpendingUnit; label: string; chart: string }[] = [
  { unit: 'day', label: 'Days', chart: 'Spending per day, last 30 days' },
  { unit: 'week', label: 'Weeks', chart: 'Spending per week, last 12 weeks' },
  { unit: 'month', label: 'Months', chart: 'Spending per month, last 12 months' },
];

function SpendingPanel({
  days,
  today,
  totals,
}: {
  days: AiSpendingDayDTO[];
  today: Date;
  totals: ReturnType<typeof spendingTotals>;
}) {
  const [unit, setUnit] = useState<SpendingUnit>('day');
  const buckets = spendingBuckets(days, unit, today);
  const chart = UNITS.find((u) => u.unit === unit)!;

  if (!totals.all.questions) {
    return (
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Nothing spent yet. Once you ask Claude something, what each question cost adds up here by day, week and month.
      </p>
    );
  }
  return (
    <>
      <dl className="grid grid-cols-3 gap-3">
        <Figure label="Today" total={totals.today} />
        <Figure label="This week" total={totals.week} />
        <Figure label="This month" total={totals.month} />
      </dl>
      <div className="flex flex-col gap-2">
        <div
          role="group"
          aria-label="Show spending by"
          className="flex w-fit rounded-lg border border-line bg-raised p-0.5"
        >
          {UNITS.map((u) => (
            <button
              key={u.unit}
              type="button"
              aria-pressed={unit === u.unit}
              onClick={() => setUnit(u.unit)}
              className={clsx(
                'focus-ring inline-flex h-7 items-center rounded-md px-2.5 text-[13px] transition-colors',
                unit === u.unit
                  ? 'bg-accent-soft font-medium text-accent-text'
                  : 'text-ink-muted hover:bg-hover hover:text-ink',
              )}
            >
              {u.label}
            </button>
          ))}
        </div>
        <SpendingChart key={unit} buckets={buckets} unit={unit} label={chart.chart} />
      </div>
      <p className="text-xs leading-relaxed text-ink-faint">
        {formatUsd(totals.all.costUsd)} in all for {pluralize(totals.all.questions, 'question')}
        {totals.since ? ` since ${formatDate(totals.since, 'MMM d, yyyy')}` : ''}. Estimated at Anthropic’s list prices
        from what each question used; your Anthropic account has the exact bill.
      </p>
    </>
  );
}

function Figure({ label, total }: { label: string; total: SpendingTotal }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-canvas px-3 py-2">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="truncate text-lg font-semibold tracking-tight text-ink tabular-nums">
        {formatUsd(total.costUsd)}
      </dd>
      <dd className="truncate text-xs text-ink-faint">{pluralize(total.questions, 'question')}</dd>
    </div>
  );
}

function describeBucket(bucket: SpendingBucket, unit: SpendingUnit): string {
  return `${bucketLabel(bucket, unit)}: ${formatUsd(bucket.costUsd)}, ${pluralize(bucket.questions, 'question')}`;
}

/**
 * Bars, tallest = the dearest period. Each bar is in the tab order in turn (one stop for the whole
 * chart; the arrow keys move along it) and names its period and numbers to screen readers.
 */
function SpendingChart({ buckets, unit, label }: { buckets: SpendingBucket[]; unit: SpendingUnit; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [focusable, setFocusable] = useState(buckets.length - 1);
  const listRef = useRef<HTMLOListElement>(null);
  const max = Math.max(...buckets.map((b) => b.costUsd));

  const focusBar = (i: number) => {
    const index = Math.max(0, Math.min(buckets.length - 1, i));
    setFocusable(index);
    listRef.current?.querySelectorAll<HTMLElement>('li')[index]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: focusable - 1,
      ArrowRight: focusable + 1,
      Home: 0,
      End: buckets.length - 1,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    focusBar(moves[e.key]);
  };

  const shown = active != null ? buckets[active] : null;
  return (
    <div className="relative pt-14">
      {shown && active != null && (
        <Tip index={active} count={buckets.length}>
          <span className="block font-medium text-ink">{bucketLabel(shown, unit)}</span>
          <span className="block text-ink-muted tabular-nums">
            {formatUsd(shown.costUsd)} · {pluralize(shown.questions, 'question')}
          </span>
        </Tip>
      )}
      <ol
        ref={listRef}
        aria-label={label}
        onKeyDown={onKeyDown}
        // Back to the bar with the keyboard focus, if one has it.
        onMouseLeave={() => setActive(listRef.current?.contains(document.activeElement) ? focusable : null)}
        className="flex h-28 items-end gap-0.5"
      >
        {buckets.map((bucket, i) => {
          // A period with nothing spent keeps a low, grey slot, so the chart still reads as a timeline.
          const height = bucket.costUsd > 0 ? `max(${(bucket.costUsd / max) * 100}%, 4px)` : '3px';
          return (
            <li
              key={bucket.start.getTime()}
              tabIndex={i === focusable ? 0 : -1}
              aria-label={describeBucket(bucket, unit)}
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
                  'block w-full max-w-7 rounded-t-[3px] transition-colors duration-100',
                  bucket.costUsd === 0
                    ? active === i
                      ? 'bg-ink-faint'
                      : 'bg-line-strong'
                    : active === i
                      ? 'bg-accent'
                      : bucket.current
                        ? 'bg-accent/80'
                        : 'bg-accent/50',
                )}
              />
            </li>
          );
        })}
      </ol>
      <div aria-hidden="true" className="mt-1.5 flex justify-between text-[11px] text-ink-faint">
        <span>{axisLabel(buckets[0], unit)}</span>
        <span>{axisLabel(buckets[buckets.length - 1], unit)}</span>
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
