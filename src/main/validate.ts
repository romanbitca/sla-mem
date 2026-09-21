/**
 * Validation of IPC arguments. The renderer is our own code, but it renders untrusted Slack
 * content, so every value crossing into main is checked before it reaches the database.
 */
import type { SearchHas, SearchParams, SearchSort } from '../shared/types';
import { invalid } from './errors';

/** Slack message timestamp: seconds, a dot, and up to 6 fractional digits. */
export const TS_RE = /^\d{9,11}\.\d{1,6}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEARCH_HAS: readonly SearchHas[] = ['file', 'link', 'reaction', 'thread', 'image'];
const SEARCH_SORT: readonly SearchSort[] = ['relevance', 'newest', 'oldest'];
export const MAX_QUERY_LENGTH = 1_000;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function record(v: unknown, what = 'request'): Record<string, unknown> {
  if (!isRecord(v)) throw invalid(`Invalid ${what}`);
  return v;
}

/** A Slack id (conversation, user, file…): a single safe path segment. */
export function slackId(v: unknown, name: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw invalid(`Invalid ${name}`);
  return v;
}

export function optionalTs(v: unknown, name: string): string | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string' || !TS_RE.test(v)) throw invalid(`Invalid ${name}`);
  return v;
}

export function requiredTs(v: unknown, name: string): string {
  const ts = optionalTs(v, name);
  if (!ts) throw invalid(`Missing ${name}`);
  return ts;
}

/** Integer clamped into [min, max]; garbage is rejected rather than guessed at. */
export function optionalInt(v: unknown, name: string, range: { min: number; max: number }): number | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw invalid(`Invalid ${name}`);
  return Math.min(range.max, Math.max(range.min, v));
}

export function string(v: unknown, name: string, maxLength: number): string {
  if (typeof v !== 'string' || v.length > maxLength || v.includes('\0')) throw invalid(`Invalid ${name}`);
  return v;
}

export function optionalDate(v: unknown, name: string): string | undefined {
  if (v == null || v === '') return undefined;
  const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
  if (!m || !isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) throw invalid(`Invalid ${name} date`);
  return v as string;
}

function isCalendarDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function idList(v: unknown, name: string, max = 100): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v) || v.length > max) throw invalid(`Invalid ${name} filter`);
  const ids = v.map((id) => slackId(id, name));
  return ids.length ? [...new Set(ids)] : undefined;
}

export function searchParams(v: unknown): SearchParams {
  const r = record(v, 'search');
  const q = string(r.q ?? '', 'search text', MAX_QUERY_LENGTH);
  const has = r.has == null ? undefined : r.has;
  if (has != null && (!Array.isArray(has) || has.some((h) => !(SEARCH_HAS as readonly unknown[]).includes(h)))) {
    throw invalid('Invalid has: filter');
  }
  if (r.sort != null && !(SEARCH_SORT as readonly unknown[]).includes(r.sort)) throw invalid('Invalid sort');
  return {
    q,
    conversation: idList(r.conversation, 'conversation'),
    user: idList(r.user, 'user'),
    after: optionalDate(r.after, 'after'),
    before: optionalDate(r.before, 'before'),
    has: has as SearchHas[] | undefined,
    sort: r.sort as SearchSort | undefined,
    limit: optionalInt(r.limit, 'limit', { min: 1, max: 100 }),
    offset: optionalInt(r.offset, 'offset', { min: 0, max: 1_000_000 }),
  };
}
