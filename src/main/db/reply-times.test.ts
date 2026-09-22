import { describe, expect, it } from 'vitest';
import type { SlackMessage } from '../slack/types';
import {
  measureReplies,
  RANK_MIN_ANSWERS,
  rankPeople,
  replyPeriods,
  replyStats,
  type ReplySample,
} from './reply-times';
import { msg, seededDb } from './test-helpers';
import type { DB } from './types';
import { WorkCalendar } from './work-calendar';
import { upsertMessages } from './write';

// seededDb(): the reader is USELF; U1 Alice, U2 Bob, U3, U4; C1 #general; D1 the DM with Alice;
// M1 the group DM of the reader, Alice and Bob.

const HOURS = { days: [1, 2, 3, 4], start: 9 * 60, end: 20 * 60 + 30, timeZone: 'UTC' };
const cal = (daysOff: [string, string[]][] = []) =>
  new WorkCalendar(HOURS, new Map(daysOff.map(([user, days]) => [user, new Set(days)])));
/** A ts on a September 2026 day (Monday the 21st), at a UTC time. */
const ts = (day: number, h: number, min = 0) => `${Date.UTC(2026, 8, day, h, min) / 1000}.000000`;
const put = (db: DB, conversationId: string, messages: SlackMessage[]) =>
  upsertMessages(db, conversationId, messages, 'api');
const waits = (samples: ReplySample[]) => samples.map((s) => [s.who, s.kind, s.waited / 60]);
const me = { user: 'USELF' };

describe('measureReplies: DMs', () => {
  it('times each question from when it was asked to the other’s next message, both ways', () => {
    const db = seededDb();
    put(db, 'D1', [
      msg(ts(21, 10), 'can you check the invoice?'),
      msg(ts(21, 10, 12), 'sure, looking', me),
      msg(ts(21, 11), 'could you send it to me?', me),
      msg(ts(21, 11, 30), 'sent'),
      // Thanks needs no answer, and a hello does.
      msg(ts(21, 11, 31), 'thanks!'),
      msg(ts(21, 13), 'np', me),
      msg(ts(22, 9, 5), 'hello'),
      msg(ts(22, 9, 10), 'hi Alice', me),
    ]);
    const r = measureReplies(db, 'USELF', cal());
    expect(waits(r.you)).toEqual([
      ['U1', 'dm', 12],
      ['U1', 'dm', 5],
    ]);
    expect(waits(r.them)).toEqual([['U1', 'dm', 30]]);
  });

  it('starts the wait at the question, not at what came before it', () => {
    const db = seededDb();
    put(db, 'D1', [
      msg(ts(21, 10), 'the deploy is done.'),
      msg(ts(21, 10, 30), 'can you check it?'),
      msg(ts(21, 10, 40), 'on it', me),
    ]);
    expect(waits(measureReplies(db, 'USELF', cal()).you)).toEqual([['U1', 'dm', 10]]);
  });

  it('counts working time only, and leaves out other days, days off and answers days later', () => {
    const db = seededDb();
    put(db, 'D1', [
      // Monday 20:00 → Tuesday 09:15: 30 + 15 minutes.
      msg(ts(21, 20), 'can you look tomorrow?'),
      msg(ts(22, 9, 15), 'looking now', me),
      // Wednesday is the reader's day off.
      msg(ts(23, 10), 'are you around?'),
      msg(ts(23, 12), 'yes', me),
      // Friday isn't counted.
      msg(ts(25, 10), 'can you check?'),
      msg(ts(25, 10, 5), 'done', me),
      // Monday → next Monday: more than three working days, not an answer to that.
      msg(ts(28, 10), 'any update?'),
      msg(ts(28 + 7, 10), 'here it is', me),
    ]);
    expect(waits(measureReplies(db, 'USELF', cal([['USELF', ['2026-09-23']]])).you)).toEqual([['U1', 'dm', 45]]);
  });

  it('reads only questions asked since the start it is given', () => {
    const db = seededDb();
    put(db, 'D1', [
      msg(ts(21, 10), 'can you check?'),
      msg(ts(21, 10, 5), 'yes', me),
      msg(ts(22, 10), 'and this one?'),
      msg(ts(22, 10, 7), 'yes', me),
    ]);
    const since = Date.UTC(2026, 8, 22) / 1000;
    expect(waits(measureReplies(db, 'USELF', cal(), since).you)).toEqual([['U1', 'dm', 7]]);
  });
});

describe('measureReplies: tags in channels and group DMs', () => {
  it('times a question in a thread to your reply in it, once for several questions', () => {
    const db = seededDb();
    put(db, 'C1', [
      msg(ts(21, 9, 50), 'release notes are up', { user: 'U2' }),
      msg(ts(21, 10), '<@USELF> can you review this?', { user: 'U2', thread_ts: ts(21, 9, 50) }),
      msg(ts(21, 10, 5), '<@USELF> and the changelog?', { user: 'U2', thread_ts: ts(21, 9, 50) }),
      msg(ts(21, 10, 20), 'both look good', { user: 'USELF', thread_ts: ts(21, 9, 50) }),
    ]);
    expect(waits(measureReplies(db, 'USELF', cal()).you)).toEqual([['U2', 'mention', 20]]);
  });

  it('takes your next top-level message in the channel within a day as the answer to a top-level question', () => {
    const db = seededDb();
    put(db, 'C1', [
      msg(ts(21, 14), '<@USELF> could you look at the build?', { user: 'U2' }),
      msg(ts(21, 14, 30), 'the build is green now', me),
      // More than a day later is no answer to it.
      msg(ts(22, 14), '<@USELF> could you look at the logs?', { user: 'U2' }),
      msg(ts(23, 15), 'logs attached', me),
      // Only messages that speak to you count: this one is about you.
      msg(ts(24, 10), 'I told <@USELF> about it?', { user: 'U2' }),
      msg(ts(24, 10, 1), 'ok', me),
    ]);
    expect(waits(measureReplies(db, 'USELF', cal()).you)).toEqual([['U2', 'mention', 30]]);
  });

  it('takes anything you write next in a group DM as the answer', () => {
    const db = seededDb();
    put(db, 'M1', [msg(ts(21, 15), '<@USELF> are you free?', { user: 'U2' }), msg(ts(21, 15, 5), 'in 10', me)]);
    expect(waits(measureReplies(db, 'USELF', cal()).you)).toEqual([['U2', 'mention', 5]]);
  });

  it('times your questions to the first of the people you asked to answer, on their working days', () => {
    const db = seededDb();
    put(db, 'C1', [
      msg(ts(21, 16), '<@U2> <@U3> can you deploy?', me),
      msg(ts(21, 16, 5), 'on it', { user: 'U3', thread_ts: ts(21, 16) }),
      msg(ts(21, 16, 10), 'thanks', { user: 'U2', thread_ts: ts(21, 16) }),
      // Bob is off on Tuesday.
      msg(ts(22, 10), '<@U2> could you check the invoice?', me),
      msg(ts(22, 10, 30), 'checked', { user: 'U2', thread_ts: ts(22, 10) }),
    ]);
    expect(waits(measureReplies(db, 'USELF', cal([['U2', ['2026-09-22']]])).them)).toEqual([['U3', 'mention', 5]]);
  });
});

describe('the numbers', () => {
  const sample = (who: string, minutes: number, day = 21, kind: ReplySample['kind'] = 'dm'): ReplySample => ({
    kind,
    who,
    at: Date.UTC(2026, 8, day, 10) / 1000,
    waited: minutes * 60,
  });

  it('averages, finds the middle and buckets the waits', () => {
    expect(replyStats([sample('U1', 1), sample('U1', 2)])).toBeNull();
    const stats = replyStats([
      sample('U1', 5),
      sample('U1', 10),
      sample('U2', 30, 21, 'mention'),
      sample('U2', 90),
      sample('U3', 600, 21, 'mention'),
    ])!;
    expect(stats).toMatchObject({
      count: 5,
      averageSeconds: 147 * 60,
      medianSeconds: 30 * 60,
      buckets: [2, 1, 1, 1],
      dm: { count: 3, averageSeconds: 35 * 60 },
      mentions: { count: 2, averageSeconds: 315 * 60 },
    });
  });

  it('averages per week (from Monday) and per month, the last 12 up to now, empty ones included', () => {
    const c = cal();
    const now = Date.UTC(2026, 8, 24, 12) / 1000;
    const samples = [sample('U1', 10, 21), sample('U1', 20, 22), sample('U1', 60, 15)];
    const weeks = replyPeriods(samples, c, 'week', now);
    expect(weeks).toHaveLength(12);
    expect(weeks.slice(-3)).toEqual([
      { start: '2026-09-07', count: 0, averageSeconds: null },
      { start: '2026-09-14', count: 1, averageSeconds: 3600 },
      { start: '2026-09-21', count: 2, averageSeconds: 900 },
    ]);
    const months = replyPeriods(samples, c, 'month', now);
    expect(months[0].start).toBe('2025-10-01');
    expect(months[11]).toEqual({ start: '2026-09-01', count: 3, averageSeconds: 1800 });
  });

  it('ranks whom you answer fastest and slowest, each person once, only with enough answers', () => {
    const three = (who: string, minutes: number) =>
      Array.from({ length: RANK_MIN_ANSWERS }, () => sample(who, minutes));
    const ranked = rankPeople([
      ...three('UA', 5),
      ...three('UB', 60),
      ...three('UC', 20),
      ...three('UD', 240),
      ...three('UE', 2),
      sample('UF', 1),
      sample('UF', 1),
    ]);
    expect(ranked.fastest.map((p) => p.userId)).toEqual(['UE', 'UA', 'UC']);
    expect(ranked.slowest.map((p) => p.userId)).toEqual(['UD', 'UB']);
    expect(ranked.fastest[0]).toEqual({ userId: 'UE', count: 3, averageSeconds: 120 });
  });
});
