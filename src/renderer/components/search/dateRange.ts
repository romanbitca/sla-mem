/**
 * Date-range helpers for the date chip. URL/API ranges are [after, before): `before` is
 * exclusive, like Slack's `before:` modifier. The picker shows an inclusive "to" day instead,
 * which is what people mean by "March 1 to March 31".
 */
import { format } from 'date-fns';
import { FREE_PLAN_WINDOW_DAYS } from '../../lib/format';
import { addDays, localDay, type DateRange } from './resolve';

/** Inclusive last day for an exclusive `before`. */
export function inclusiveEnd(before: string | null): string | null {
  return before ? addDays(before, -1) : null;
}

/** Exclusive `before` for an inclusive last day. */
export function exclusiveBefore(lastDay: string | null): string | null {
  return lastDay ? addDays(lastDay, 1) : null;
}

function dayDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDayShort(day: string, now: Date): string {
  const date = dayDate(day);
  return date.getFullYear() === now.getFullYear() ? format(date, 'MMM d') : format(date, 'MMM d, yyyy');
}

/** "Mar 1 – Mar 31", "On Mar 4", "Since Mar 1", "Before Mar 1, 2025", or null for any time. */
export function dateRangeLabel(range: DateRange, now: Date = new Date()): string | null {
  const { after, before } = range;
  if (!after && !before) return null;
  const last = inclusiveEnd(before);
  if (after && last) {
    if (after === last) return `On ${formatDayShort(after, now)}`;
    if (after > last) return 'No dates (empty range)';
    return `${formatDayShort(after, now)} – ${formatDayShort(last, now)}`;
  }
  if (after) return `Since ${formatDayShort(after, now)}`;
  return `Before ${formatDayShort(before!, now)}`;
}

export interface DatePreset {
  id: string;
  label: string;
  detail?: string;
  range: DateRange;
}

export function datePresets(now: Date = new Date()): DatePreset[] {
  const today = localDay(now);
  const since = (days: number) => ({ after: addDays(today, -(days - 1)), before: null });
  return [
    { id: 'today', label: 'Today', range: { after: today, before: null } },
    { id: '7d', label: 'Last 7 days', range: since(7) },
    { id: '30d', label: 'Last 30 days', range: since(30) },
    { id: '90d', label: `Last ${FREE_PLAN_WINDOW_DAYS} days`, detail: 'What Slack Free still shows', range: since(FREE_PLAN_WINDOW_DAYS) },
    {
      id: 'beyond',
      label: `Older than ${FREE_PLAN_WINDOW_DAYS} days`,
      detail: 'Only in this archive',
      range: { after: null, before: addDays(today, -FREE_PLAN_WINDOW_DAYS) },
    },
  ];
}

export function sameRange(a: DateRange, b: DateRange): boolean {
  return a.after === b.after && a.before === b.before;
}
