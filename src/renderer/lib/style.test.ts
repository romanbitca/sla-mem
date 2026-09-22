import { describe, expect, it } from 'vitest';
import type { StyleCheckDTO } from '../../shared/types';
import {
  checkCopy,
  daysLabel,
  formatWait,
  formatWaitShort,
  hoursLabel,
  parseClock,
  periodAxis,
  periodLabel,
  toneSentence,
  trimLeadingEmpty,
} from './style';

const check = (id: StyleCheckDTO['id'], good: boolean, count = 1, total = 10): StyleCheckDTO => ({
  id,
  good,
  count,
  total,
  words: [],
  example: null,
});

describe('My style wording', () => {
  it('says how long a wait was', () => {
    expect(formatWait(20)).toBe('under a minute');
    expect(formatWait(12 * 60)).toBe('12 min');
    expect(formatWait(3714)).toBe('1 h 02 min');
    expect(formatWait(2 * 3600)).toBe('2 h');
    expect(formatWait(26 * 3600 + 600)).toBe('26 h');
    expect(formatWaitShort(3714)).toBe('1h 02m');
    expect(formatWaitShort(30)).toBe('<1m');
  });

  it('names the working days and hours', () => {
    expect(daysLabel([1, 2, 3, 4])).toBe('Mon–Thu');
    expect(daysLabel([0, 1, 2, 3, 4])).toBe('Sun–Thu');
    expect(daysLabel([0, 1, 3])).toBe('Sun, Mon, Wed');
    expect(daysLabel([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(daysLabel([5, 6])).toBe('Fri, Sat');
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6])).toBe('every day');
    expect(hoursLabel({ days: [1, 2, 3, 4], start: 540, end: 1230, timeZone: 'America/New_York' })).toBe(
      'Mon–Thu, 09:00–20:30 New York time',
    );
    expect(parseClock('09:05')).toBe(545);
    expect(parseClock('24:00')).toBe(1440);
    expect(parseClock('24:30')).toBeNull();
    expect(parseClock('9 am')).toBeNull();
  });

  it('labels weeks and months, and starts the chart at the first answers', () => {
    const week = { start: '2026-09-14', count: 3, averageSeconds: 60 };
    expect(periodLabel(week, 'week')).toBe('Week of 14 Sep');
    expect(periodAxis(week, 'week')).toBe('14 Sep');
    expect(periodLabel({ ...week, start: '2026-01-01' }, 'month')).toBe('January 2026');
    expect(periodAxis({ ...week, start: '2026-01-01' }, 'month')).toBe('Jan 2026');
    expect(trimLeadingEmpty([{ ...week, count: 0 }, week, { ...week, count: 0 }])).toEqual([
      week,
      { ...week, count: 0 },
    ]);
    expect(trimLeadingEmpty([{ ...week, count: 0 }])).toEqual([]);
  });

  it('sums up the habits you have and the three to try first', () => {
    expect(
      toneSentence([
        check('capitals', false),
        check('casual', false),
        check('oneMessage', false),
        check('greeting', false),
        check('please', true),
        check('greetAndAsk', true),
      ]),
    ).toBe(
      'You already say please and ask right away. Capital letters and apostrophes, fewer casual words and one message instead of several would make you sound more professional.',
    );
    expect(toneSentence([check('please', true)])).toBe('You already say please. Keep it up.');
  });

  it('words each check from its numbers', () => {
    expect(checkCopy({ ...check('greeting', false, 89, 118), words: [{ word: 'how are you', count: 43 }] })).toEqual({
      title: 'A hello when you start a chat',
      stat: '75%',
      detail:
        '75% of the chats you start open with a greeting, and 43 ask how they are. Open with a hello and their name; asking how they are now and then goes a long way.',
    });
    expect(checkCopy(check('greetAndAsk', true, 1, 20)).stat).toBe('Well done');
    expect(checkCopy(check('oneMessage', false, 36, 998)).detail).toMatch(/^36 times you sent three or more messages/);
  });
});
