/**
 * My style: how you write and how quickly you answer, read from your own messages in the archive.
 * Everything here runs on this computer; nothing is sent anywhere.
 */
import type { StyleDTO, WorkHoursDTO } from '../../shared/types';
import { findDaysOff } from './days-off';
import { getMeta } from './meta';
import { measureReplies, rankPeople, RANK_MIN_ANSWERS, replyPeriods, replyStats } from './reply-times';
import { tsAtSecond } from './read';
import { stmt } from './stmt';
import type { DB } from './types';
import { isTimeZone, WorkCalendar } from './work-calendar';
import { writingChecks } from './writing';

export interface StyleOptions {
  workHours: WorkHoursDTO;
  now?: number;
  /** The zone when the archive tells nothing (this computer's). */
  fallbackTimeZone?: string;
}

/** Reply times cover the year before your latest message. */
export const REPLY_WINDOW_DAYS = 365;

export function getStyle(db: DB, opts: StyleOptions): StyleDTO {
  const self = getMeta(db, 'self_user_id');
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const timeZone = opts.workHours.timeZone ?? teamTimeZone(db) ?? opts.fallbackTimeZone ?? 'UTC';
  const hours = { ...opts.workHours, timeZone };
  const dayKeys = new WorkCalendar(hours);
  const daysOff = findDaysOff(db, dayKeys);
  const cal = new WorkCalendar(hours, daysOff.byUser);
  const writing = self ? writingChecks(db, self, { now: opts.now }) : null;
  const latest = self
    ? stmt<{ time: number | null }>(db, 'SELECT max(time) AS time FROM messages WHERE user_id = ?').get(self)?.time
    : null;
  const since = latest != null ? latest - REPLY_WINDOW_DAYS * 86400 : null;
  const replies = self && since != null ? measureReplies(db, self, cal, since) : { you: [], them: [] };
  // The year only needs saying when the archive goes back further.
  const cut =
    self != null &&
    since != null &&
    stmt(db, 'SELECT 1 FROM messages WHERE user_id = ? AND time < ? LIMIT 1').get(self, since) !== undefined;
  const ranked = rankPeople(replies.you);
  return {
    messageCount: writing?.messageCount ?? 0,
    englishCount: writing?.englishCount ?? 0,
    firstTs: writing?.firstTime != null ? tsAtSecond(writing.firstTime) : null,
    tone: writing?.tone ?? null,
    checks: writing?.checks ?? [],
    hours: { ...hours, timeZoneIsDefault: opts.workHours.timeZone == null },
    you: replyStats(replies.you),
    them: replyStats(replies.them),
    weeks: replyPeriods(replies.you, cal, 'week', now),
    months: replyPeriods(replies.you, cal, 'month', now),
    fastest: ranked.fastest,
    slowest: ranked.slowest,
    rankMinAnswers: RANK_MIN_ANSWERS,
    repliesSince: cut && since != null ? tsAtSecond(since) : null,
    yourDaysOff: self ? (daysOff.byUser.get(self)?.size ?? 0) : 0,
    daysOffSources: daysOff.sources,
  };
}

/** The time zone most people in the archive are in (their Slack profiles), or null. */
export function teamTimeZone(db: DB): string | null {
  const counts = new Map<string, number>();
  for (const { tz } of stmt<{ tz: string | null }>(
    db,
    "SELECT json_extract(raw, '$.tz') AS tz FROM users WHERE is_bot = 0 AND deleted = 0 AND id <> 'USLACKBOT' AND json_valid(raw)",
  ).all()) {
    if (typeof tz === 'string' && tz.length <= 64) counts.set(tz, (counts.get(tz) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked.find(([tz]) => isTimeZone(tz))?.[0] ?? null;
}
