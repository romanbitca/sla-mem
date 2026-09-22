import { differenceInCalendarDays, format, isSameYear } from 'date-fns';
import { tsToDate } from './ts';

/** Slack Free only shows this much history; older messages exist only in the archive. */
export const FREE_PLAN_WINDOW_DAYS = 90;

/**
 * Whether a Date holds an actual time. date-fns throws on an invalid one, and archived data
 * (or an imported export) can carry a malformed timestamp: a bad date must never take a whole
 * screen down, so everything here formats it as '' instead.
 */
export function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

/** date-fns `format` that returns '' for an invalid date. */
export function formatDate(date: Date, pattern: string): string {
  return isValidDate(date) ? format(date, pattern) : '';
}

/** For `<time dateTime>`: nothing rather than a crash when the date is invalid. */
export function isoDateTime(date: Date): string | undefined {
  return isValidDate(date) ? date.toISOString() : undefined;
}

export function formatTime(date: Date): string {
  return formatDate(date, 'h:mm a');
}

/** The time without AM/PM, for the narrow column beside grouped messages (as Slack does). */
export function formatShortTime(date: Date): string {
  return formatDate(date, 'h:mm');
}

export function formatFullDateTime(date: Date): string {
  return formatDate(date, "EEEE, MMMM d, yyyy 'at' h:mm:ss a");
}

/** Day divider label: "Today", "Yesterday", "Monday, March 4th" or with the year when not current. */
export function formatDayLabel(date: Date, now: Date = new Date()): string {
  if (!isValidDate(date)) return '';
  const days = differenceInCalendarDays(now, date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return isSameYear(date, now) ? format(date, 'EEEE, MMMM do') : format(date, 'EEEE, MMMM do, yyyy');
}

/** Compact date for summaries: "today at 3:04 PM", "yesterday at …", "Mar 4", "Mar 4, 2023". */
export function formatShortDate(date: Date, now: Date = new Date()): string {
  if (!isValidDate(date)) return '';
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
  const from = formatDate(tsToDate(oldestTs), 'MMM d, yyyy');
  const to = formatDate(tsToDate(latestTs), 'MMM d, yyyy');
  if (!from || !to) return null;
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
