/**
 * Ask AI's spending, shaped for Settings: main sends what was spent per local day
 * (AiSpendingDayDTO); this adds up today, this week and this month, and cuts the recent past into
 * the chart's bars. Weeks start on Monday.
 */
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  differenceInCalendarMonths,
  format,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import type { AiSpendingDayDTO } from '../../shared/types';

export type SpendingUnit = 'day' | 'week' | 'month';

/** How many bars each chart has: the last 30 days, 12 weeks or 12 months. */
export const SPENDING_BARS: Record<SpendingUnit, number> = { day: 30, week: 12, month: 12 };

export interface SpendingTotal {
  costUsd: number;
  questions: number;
}

export interface SpendingBucket extends SpendingTotal {
  /** First day of the period. */
  start: Date;
  /** Last day of the period (inclusive). */
  last: Date;
  /** Today, this week or this month. */
  current: boolean;
}

const WEEK = { weekStartsOn: 1 } as const;

function startOf(unit: SpendingUnit, date: Date): Date {
  if (unit === 'day') return startOfDay(date);
  return unit === 'week' ? startOfWeek(date, WEEK) : startOfMonth(date);
}

function step(unit: SpendingUnit, date: Date, n: number): Date {
  if (unit === 'day') return addDays(date, n);
  return unit === 'week' ? addWeeks(date, n) : addMonths(date, n);
}

/** "2026-09-22" as local midnight; null for anything else. */
export function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The chart's bars, oldest first, ending with the current day, week or month. */
export function spendingBuckets(days: readonly AiSpendingDayDTO[], unit: SpendingUnit, today: Date): SpendingBucket[] {
  const count = SPENDING_BARS[unit];
  const first = step(unit, startOf(unit, today), -(count - 1));
  const buckets: SpendingBucket[] = Array.from({ length: count }, (_, i) => {
    const start = step(unit, first, i);
    return { start, last: addDays(step(unit, start, 1), -1), current: i === count - 1, costUsd: 0, questions: 0 };
  });
  for (const day of days) {
    const date = parseLocalDate(day.date);
    if (!date) continue;
    const offset = differenceInCalendarDays(date, first);
    const i =
      unit === 'day' ? offset : unit === 'week' ? Math.floor(offset / 7) : differenceInCalendarMonths(date, first);
    if (offset < 0 || i >= count) continue;
    buckets[i].costUsd += day.costUsd;
    buckets[i].questions += day.questions;
  }
  return buckets;
}

export interface SpendingTotals {
  today: SpendingTotal;
  week: SpendingTotal;
  month: SpendingTotal;
  all: SpendingTotal;
  /** The first day anything was spent. */
  since: Date | null;
}

export function spendingTotals(days: readonly AiSpendingDayDTO[], today: Date): SpendingTotals {
  const totals: SpendingTotals = {
    today: { costUsd: 0, questions: 0 },
    week: { costUsd: 0, questions: 0 },
    month: { costUsd: 0, questions: 0 },
    all: { costUsd: 0, questions: 0 },
    since: null,
  };
  const day0 = startOfDay(today);
  const week0 = startOfWeek(today, WEEK);
  const add = (total: SpendingTotal, day: AiSpendingDayDTO) => {
    total.costUsd += day.costUsd;
    total.questions += day.questions;
  };
  for (const day of days) {
    const date = parseLocalDate(day.date);
    if (!date || date > day0) continue;
    add(totals.all, day);
    if (!totals.since || date < totals.since) totals.since = date;
    if (date.getTime() === day0.getTime()) add(totals.today, day);
    if (date >= week0) add(totals.week, day);
    if (isSameMonth(date, today)) add(totals.month, day);
  }
  return totals;
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** "$0.21", "$12.40"; a few tenths of a cent is "under $0.01", nothing at all "$0". */
export function formatUsd(value: number): string {
  if (value <= 0) return '$0';
  if (value < 0.005) return 'under $0.01';
  return USD.format(value);
}

/** What a bar stands for: "Tue, Sep 22", "Sep 15 – 21", "September 2026". */
export function bucketLabel(bucket: SpendingBucket, unit: SpendingUnit): string {
  if (unit === 'day') return format(bucket.start, 'EEE, MMM d');
  if (unit === 'month') return format(bucket.start, 'MMMM yyyy');
  return isSameMonth(bucket.start, bucket.last)
    ? `${format(bucket.start, 'MMM d')} – ${format(bucket.last, 'd')}`
    : `${format(bucket.start, 'MMM d')} – ${format(bucket.last, 'MMM d')}`;
}

/** Under the chart's first and last bars: "Aug 24" … "Today". */
export function axisLabel(bucket: SpendingBucket, unit: SpendingUnit): string {
  if (bucket.current) return unit === 'day' ? 'Today' : unit === 'week' ? 'This week' : 'This month';
  return unit === 'month' ? format(bucket.start, 'MMM yyyy') : format(bucket.start, 'MMM d');
}
