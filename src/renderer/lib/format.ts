import { differenceInCalendarDays, format, isSameYear } from 'date-fns';
import { tsToDate } from './ts';

/** Slack Free only shows this much history; older messages exist only in the archive. */
export const FREE_PLAN_WINDOW_DAYS = 90;

export function formatTime(date: Date): string {
  return format(date, 'h:mm a');
}

export function formatFullDateTime(date: Date): string {
  return format(date, "EEEE, MMMM d, yyyy 'at' h:mm:ss a");
}

/** Day divider label: "Today", "Yesterday", "Monday, March 4th" or with the year when not current. */
export function formatDayLabel(date: Date, now: Date = new Date()): string {
  const days = differenceInCalendarDays(now, date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return isSameYear(date, now) ? format(date, 'EEEE, MMMM do') : format(date, 'EEEE, MMMM do, yyyy');
}

/** Compact date for summaries: "today at 3:04 PM", "yesterday at …", "Mar 4", "Mar 4, 2023". */
export function formatShortDate(date: Date, now: Date = new Date()): string {
  const days = differenceInCalendarDays(now, date);
  if (days === 0) return `today at ${formatTime(date)}`;
  if (days === 1) return `yesterday at ${formatTime(date)}`;
  return isSameYear(date, now) ? format(date, 'MMM d') : format(date, 'MMM d, yyyy');
}

export function formatTsShort(ts: string, now?: Date): string {
  return formatShortDate(tsToDate(ts), now);
}

/** "Mar 4, 2024 – Sep 21, 2026" for the range an archive/conversation covers. */
export function formatTsRange(oldestTs: string | null, latestTs: string | null): string | null {
  if (!oldestTs || !latestTs) return null;
  const from = format(tsToDate(oldestTs), 'MMM d, yyyy');
  const to = format(tsToDate(latestTs), 'MMM d, yyyy');
  return from === to ? from : `${from} – ${to}`;
}

export function isBeyondFreeWindow(date: Date, now: Date = new Date()): boolean {
  return differenceInCalendarDays(now, date) > FREE_PLAN_WINDOW_DAYS;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** 950 → "950", 1234 → "1.2k", 25000 → "25k", 1.5e6 → "1.5M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimZero(n / 1000)}k`;
  return `${trimZero(n / 1_000_000)}M`;
}

function trimZero(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol", "Alice, Bob and 3 others". */
export function joinNames(names: string[], max = 3): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const rest = names.length - (max - 1);
  return `${names.slice(0, max - 1).join(', ')} and ${rest} others`;
}
