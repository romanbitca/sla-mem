import { describe, expect, it } from 'vitest';
import type { SlackMessage } from '../slack/types';
import { getStyle, teamTimeZone } from './style';
import { msg, seededDb } from './test-helpers';
import type { DB } from './types';
import { upsertMessages, upsertUsers } from './write';

// seededDb(): the reader is USELF "Self Person"; U1 Alice; C1 #general; D1 the DM with Alice.

const HOURS = { days: [1, 2, 3, 4], start: 9 * 60, end: 20 * 60 + 30, timeZone: null };
const NOW = Date.UTC(2026, 8, 30, 12);
/** A ts on a September 2026 day (Monday the 21st), at a UTC time. */
const ts = (day: number, h: number, min = 0) => `${Date.UTC(2026, 8, day, h, min) / 1000}.000000`;
const me = { user: 'USELF' };
const put = (db: DB, conversationId: string, messages: SlackMessage[]) =>
  upsertMessages(db, conversationId, messages, 'api');

/** Alice asks a question on each of these days at 10:00; the reader answers after so many minutes. */
function answered(db: DB, answers: [day: number, minutes: number][]) {
  put(
    db,
    'D1',
    answers.flatMap(([day, minutes], i) => [
      msg(ts(day, 10), `can you check item ${i + 1}?`),
      msg(ts(day, 10, minutes), 'done', me),
    ]),
  );
}

describe('getStyle', () => {
  it('puts the page together: reply times on working hours in the team’s zone, and days off', () => {
    const db = seededDb();
    upsertUsers(db, [
      { id: 'U1', name: 'alice', real_name: 'Alice Anderson', tz: 'UTC' },
      { id: 'U2', name: 'bob', real_name: 'Bob Brown', tz: 'UTC' },
      { id: 'U3', name: 'annabel', real_name: 'Annabel Lee', tz: 'Europe/Amsterdam' },
    ]);
    // Monday to Wednesday, Thursday (the reader's leave: it doesn't count), and the next Monday and Tuesday.
    answered(db, [
      [21, 5],
      [22, 10],
      [23, 15],
      [24, 50],
      [28, 30],
      [29, 20],
    ]);
    put(db, 'C1', [
      msg(ts(24, 6), 'On leave today:\n• *Self Person* (24/09/26 to 24/09/26)', { user: 'B1', bot_id: 'BB1' }),
    ]);
    const style = getStyle(db, { workHours: HOURS, now: NOW });
    expect(style.hours).toEqual({ ...HOURS, timeZone: 'UTC', timeZoneIsDefault: true });
    expect(style.yourDaysOff).toBe(1);
    expect(style.daysOffSources).toEqual([{ conversationId: 'C1', kind: 'list', days: 1 }]);
    expect(style.you).toMatchObject({ count: 5, averageSeconds: 16 * 60, medianSeconds: 15 * 60 });
    expect(style.them).toBeNull();
    expect(style.fastest).toEqual([{ userId: 'U1', count: 5, averageSeconds: 16 * 60 }]);
    expect(style.slowest).toEqual([]);
    expect(style.weeks.at(-1)).toEqual({ start: '2026-09-28', count: 2, averageSeconds: 25 * 60 });
    expect(style.months.at(-1)).toMatchObject({ start: '2026-09-01', count: 5 });
    // The archive is younger than the year the times cover: nothing to say about it.
    expect(style.repliesSince).toBeNull();
    expect(style.messageCount).toBe(6);
  });

  it('uses the zone chosen in Settings, and says since when when the archive goes back further', () => {
    const db = seededDb();
    answered(db, [
      [21, 5],
      [22, 10],
    ]);
    put(db, 'D1', [msg(`${Date.UTC(2024, 0, 10, 10) / 1000}.000000`, 'an old message', me)]);
    const style = getStyle(db, { workHours: { ...HOURS, timeZone: 'Asia/Jerusalem' }, now: NOW });
    expect(style.hours).toMatchObject({ timeZone: 'Asia/Jerusalem', timeZoneIsDefault: false });
    // A year before the reader's latest message (Tuesday 22 September, 10:10).
    expect(style.repliesSince).toBe(`${Date.UTC(2025, 8, 22, 10, 10) / 1000}.000000`);
  });

  it('has nothing to show without the reader’s own messages', () => {
    const db = seededDb();
    const style = getStyle(db, { workHours: HOURS, now: NOW, fallbackTimeZone: 'Europe/Amsterdam' });
    expect(style).toMatchObject({ messageCount: 0, you: null, them: null, checks: [], tone: null, fastest: [] });
    expect(style.hours.timeZone).toBe('Europe/Amsterdam');
  });
});

describe('teamTimeZone', () => {
  it('is the zone most people are in, ignoring apps and names Intl doesn’t know', () => {
    const db = seededDb();
    upsertUsers(db, [
      { id: 'U1', name: 'a', tz: 'Africa/Cairo' },
      { id: 'U2', name: 'b', tz: 'Europe/Amsterdam' },
      { id: 'U3', name: 'c', tz: 'Europe/Amsterdam' },
      { id: 'U4', name: 'd', tz: 'Not/AZone' },
      { id: 'U5', name: 'e', tz: 'Not/AZone' },
      { id: 'U6', name: 'f', tz: 'Not/AZone' },
      { id: 'B9', name: 'bot', is_bot: true, tz: 'Asia/Tokyo' },
    ]);
    expect(teamTimeZone(db)).toBe('Europe/Amsterdam');
  });
});
