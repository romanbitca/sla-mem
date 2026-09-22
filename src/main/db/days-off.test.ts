import { describe, expect, it } from 'vitest';
import type { SlackMessage } from '../slack/types';
import { findDaysOff, listEntries, normalizeName, rangeDays } from './days-off';
import { msg, seededDb } from './test-helpers';
import type { DB } from './types';
import { WorkCalendar } from './work-calendar';
import { upsertConversations, upsertMessages } from './write';

// seededDb(): USELF "Self Person", U1 "Alice Anderson" (Ali), U2 "Bob Brown", U3 "Annabel Lee",
// U4 "Ann Other", bot B1; channels C1 #general and C2 #random.

const cal = new WorkCalendar({ days: [1, 2, 3, 4], start: 9 * 60, end: 20 * 60 + 30, timeZone: 'UTC' });
/** A ts on a September 2026 day (Monday the 21st), at a UTC time. */
const ts = (day: number, h: number, min = 0) => `${Date.UTC(2026, 8, day, h, min) / 1000}.000000`;
const put = (db: DB, conversationId: string, messages: SlackMessage[]) =>
  upsertMessages(db, conversationId, messages, 'api');
const days = (db: DB, user: string) => [...(findDaysOff(db, cal).byUser.get(user) ?? [])].sort();

const LIST =
  'Good morning to all! Happy Tuesday!  *The following people are on leave today:*  • *Alice Anderson* (21/09/26 to 23/09/26) • *Bob Brown* (22/09/26 to 22/09/26) • *Nobody Known* (22/09/26 to 22/09/26)';

describe('findDaysOff: leave lists', () => {
  it('reads who is on leave, for every day of their range, from a bot’s morning post', () => {
    const db = seededDb();
    put(db, 'C1', [msg(ts(22, 6, 30), LIST, { user: 'B1', bot_id: 'BB1' })]);
    const off = findDaysOff(db, cal);
    expect([...off.byUser.get('U1')!].sort()).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
    expect([...off.byUser.get('U2')!]).toEqual(['2026-09-22']);
    expect(off.byUser.size).toBe(2);
    expect(off.sources).toEqual([{ conversationId: 'C1', kind: 'list', days: 4 }]);
  });

  it('takes a day back from someone who says they aren’t on leave', () => {
    const db = seededDb();
    put(db, 'C1', [
      msg(ts(22, 6, 30), LIST, { user: 'B1', bot_id: 'BB1' }),
      msg(ts(22, 7), 'Hey, I am not on leave today :)', { user: 'U2' }),
      // Someone who wasn't on the list saying so changes nothing.
      msg(ts(22, 7, 5), 'I’m not off today either', { user: 'U3' }),
    ]);
    const off = findDaysOff(db, cal);
    expect(off.byUser.get('U2')?.size ?? 0).toBe(0);
    expect(off.byUser.get('U3')).toBeUndefined();
    expect(off.sources).toEqual([{ conversationId: 'C1', kind: 'list', days: 3 }]);
  });

  it('reads mentions, month-first dates and lists without dates', () => {
    const db = seededDb();
    put(db, 'C1', [
      msg(ts(22, 6), 'Out of office today:\n• <@U3> (22/09/26 to 22/09/26)\n• *Ann Other* (09/21/26 to 09/23/26)', {
        user: 'B1',
        bot_id: 'BB1',
      }),
      msg(ts(24, 6), 'Off today: Bob Brown, and Alice Anderson', { user: 'B1', bot_id: 'BB1' }),
    ]);
    expect(days(db, 'U3')).toEqual(['2026-09-22']);
    expect(days(db, 'U4')).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
    // Names after a heading, separated by commas and "and".
    expect(days(db, 'U2')).toEqual(['2026-09-24']);
    expect(days(db, 'U1')).toEqual(['2026-09-24']);
  });

  it('counts “I’m off today” as its author’s day off, but not a question about someone else', () => {
    const db = seededDb();
    put(db, 'C2', [
      msg(ts(24, 8), 'Heads up: I’m off today, back tomorrow', { user: 'USELF' }),
      msg(ts(24, 9), 'Is Ali off today?', { user: 'U2' }),
      msg(ts(24, 9, 30), 'I am not off today', { user: 'U4' }),
    ]);
    expect(days(db, 'USELF')).toEqual(['2026-09-24']);
    expect(days(db, 'U2')).toEqual([]);
    expect(days(db, 'U4')).toEqual([]);
  });
});

describe('findDaysOff: absence channels', () => {
  const withChannel = (name: string) => {
    const db = seededDb();
    upsertConversations(db, [{ id: 'C3', name, is_channel: true }], { selfUserId: 'USELF' });
    return db;
  };

  it('takes each post in a channel of absence notices as its author’s day off', () => {
    const db = withChannel('9h-sick-emergency-leave');
    put(db, 'C3', [
      msg(ts(24, 5), 'Morning, not feeling well, will start later', { user: 'U4' }),
      msg(ts(24, 5, 10), 'get well soon!', { user: 'U1', thread_ts: ts(24, 5) }),
      msg(ts(24, 9), 'Back online', { user: 'U4' }),
      // After the working day: it's about tomorrow.
      msg(ts(24, 21), 'Been unwell all evening, for tomorrow I will start later', { user: 'U2' }),
      msg(ts(24, 22), 'Power cut here, offline for now', { user: 'B1', bot_id: 'BB1' }),
    ]);
    const off = findDaysOff(db, cal);
    expect([...off.byUser.get('U4')!]).toEqual(['2026-09-24']);
    expect([...off.byUser.get('U2')!]).toEqual(['2026-09-25']);
    // A reply to someone's notice is sympathy, not a notice; bots aren't people.
    expect(off.byUser.get('U1')).toBeUndefined();
    expect(off.byUser.get('B1')).toBeUndefined();
    expect(off.sources).toEqual([{ conversationId: 'C3', kind: 'notices', days: 2 }]);
  });

  it('ignores a channel named for holidays whose posts are about work', () => {
    const db = withChannel('project-holiday-campaign');
    put(db, 'C3', [
      msg(ts(24, 9), 'Banner copy is ready for review', { user: 'U4' }),
      msg(ts(24, 10), 'Shipping the landing page today', { user: 'U2' }),
      msg(ts(24, 11), 'I will be offline after 5', { user: 'U1' }),
    ]);
    expect(findDaysOff(db, cal).byUser.size).toBe(0);
  });

  it('ignores channels not named for absences', () => {
    const db = withChannel('support');
    put(db, 'C3', [msg(ts(24, 5), 'not feeling well, offline today', { user: 'U4' })]);
    expect(findDaysOff(db, cal).byUser.size).toBe(0);
  });
});

describe('leave list parts', () => {
  const names = new Map([
    ['alice anderson', 'U1'],
    ['bob brown', 'U2'],
  ]);

  it('finds one person per bullet or line, by name or mention, each once', () => {
    expect(
      listEntries('On leave today: • *Alice Anderson* (21/09/26 to 23/09/26) • <@U7> • *Alice Anderson*', names),
    ).toEqual([
      { userId: 'U1', range: { from: [21, 9, 26], to: [23, 9, 26] } },
      { userId: 'U7', range: null },
    ]);
    expect(listEntries('Bob Brown - all day\nAlice Anderson: 2026-09-22', names).map((e) => e.userId)).toEqual([
      'U2',
      'U1',
    ]);
  });

  it('reads dates day-first, then month-first, then year-first, always including the post’s day', () => {
    expect(rangeDays({ from: [13, 9, 26], to: [15, 9, 26] }, '2026-09-14')).toEqual([
      '2026-09-13',
      '2026-09-14',
      '2026-09-15',
    ]);
    expect(rangeDays({ from: [9, 13, 26], to: [9, 14, 26] }, '2026-09-13')).toEqual(['2026-09-13', '2026-09-14']);
    expect(rangeDays({ from: [2026, 9, 22], to: [2026, 9, 22] }, '2026-09-22')).toEqual(['2026-09-22']);
    // A range that doesn't hold the post's own day is taken as that day alone.
    expect(rangeDays({ from: [1, 1, 26], to: [2, 1, 26] }, '2026-09-22')).toEqual(['2026-09-22']);
    expect(rangeDays(null, '2026-09-22')).toEqual(['2026-09-22']);
    // A year at most.
    expect(rangeDays({ from: [1, 1, 26], to: [31, 12, 30] }, '2026-06-01')).toHaveLength(366);
  });

  it('compares names without case, accents or punctuation', () => {
    expect(normalizeName('  *Ștefan  Popescu-Ionescu* ')).toBe('stefan popescu-ionescu');
    expect(normalizeName('Zoë O’Neil')).toBe('zoe o neil');
  });
});
