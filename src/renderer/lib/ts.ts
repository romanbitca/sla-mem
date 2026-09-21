/**
 * Helpers for Slack message timestamps ("1712345678.123456").
 *
 * A ts is the identity of a message inside a conversation, so we never round-trip it through a
 * float when comparing: 16 significant digits sit right at the edge of double precision and two
 * adjacent messages could compare equal.
 */

const TS_RE = /^\d{9,11}\.\d{1,6}$/;

export function isValidTs(value: string | null | undefined): value is string {
  return typeof value === 'string' && TS_RE.test(value);
}

/** Returns the ts when it is well-formed, otherwise null (used for untrusted URL params). */
export function parseTsParam(value: string | null | undefined): string | null {
  return isValidTs(value) ? value : null;
}

export function tsToMs(ts: string): number {
  return Math.round(parseFloat(ts) * 1000);
}

export function tsToDate(ts: string): Date {
  return new Date(tsToMs(ts));
}

/** Exact ordering of two ts strings (negative when a < b). */
export function compareTs(a: string, b: string): number {
  const [aSec, aFrac = ''] = a.split('.');
  const [bSec, bFrac = ''] = b.split('.');
  const secDiff = Number(aSec) - Number(bSec);
  if (secDiff !== 0) return secDiff;
  return Number(aFrac.padEnd(6, '0')) - Number(bFrac.padEnd(6, '0'));
}

/**
 * A ts that sorts immediately before every message sent at or after `date`.
 * The messages API's `after` is exclusive, so asking for messages after this value
 * includes one posted exactly at midnight.
 */
export function tsJustBefore(date: Date): string {
  const seconds = Math.floor(date.getTime() / 1000);
  return `${seconds - 1}.999999`;
}

/** Local midnight of a `YYYY-MM-DD` string (as produced by `<input type="date">`), or null. */
export function parseLocalDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `YYYY-MM-DD` in local time, the format `<input type="date">` expects. */
export function toLocalDateInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
