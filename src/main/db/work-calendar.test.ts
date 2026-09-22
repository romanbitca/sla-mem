import { describe, expect, it } from 'vitest';
import { isTimeZone, WorkCalendar } from './work-calendar';

/** Epoch seconds of a UTC time. */
const utc = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h, min) / 1000;

const HOURS = { days: [1, 2, 3, 4], start: 9 * 60, end: 20 * 60 + 30, timeZone: 'Europe/Amsterdam' };

// September 2026: Monday the 21st to Sunday the 27th; Amsterdam is UTC+2 (summer time).
describe('WorkCalendar', () => {
  it('names the local day and the time in it', () => {
    const cal = new WorkCalendar(HOURS);
    expect(cal.local(utc(2026, 9, 21, 21, 59) + 59)).toEqual({ day: '2026-09-21', seconds: 86_399 });
    expect(cal.local(utc(2026, 9, 21, 22))).toEqual({ day: '2026-09-22', seconds: 0 });
    expect(WorkCalendar.nextDay('2026-12-31')).toBe('2027-01-01');
  });

  it('counts only working hours: a Thursday evening question answered on Monday morning waited 45 minutes', () => {
    const cal = new WorkCalendar(HOURS);
    // Thursday 20:00 → Monday 09:15, Amsterdam time.
    expect(cal.between('U1', utc(2026, 9, 24, 18), utc(2026, 9, 28, 7, 15))).toBe(45 * 60);
    // Within one working morning.
    expect(cal.between('U1', utc(2026, 9, 21, 8), utc(2026, 9, 21, 8, 20))).toBe(20 * 60);
    // Before the day starts and after it ends count nothing.
    expect(cal.between('U1', utc(2026, 9, 21, 4), utc(2026, 9, 21, 6, 59))).toBe(0);
    expect(cal.between('U1', utc(2026, 9, 21, 19), utc(2026, 9, 21, 21))).toBe(0);
    expect(cal.between('U1', utc(2026, 9, 21, 9), utc(2026, 9, 21, 9))).toBe(0);
  });

  it('skips the days that aren’t working days, and each person’s days off', () => {
    const cal = new WorkCalendar(HOURS, new Map([['U1', new Set(['2026-09-28'])]]));
    // Friday isn't a working day here.
    expect(cal.counts('U2', utc(2026, 9, 25, 10))).toBe(false);
    expect(cal.counts('U2', utc(2026, 9, 28, 10))).toBe(true);
    expect(cal.counts('U1', utc(2026, 9, 28, 10))).toBe(false);
    // U1 was off on Monday: the wait resumes on Tuesday.
    expect(cal.between('U1', utc(2026, 9, 24, 18), utc(2026, 9, 29, 7, 15))).toBe(45 * 60);
    expect(cal.between('U2', utc(2026, 9, 24, 18), utc(2026, 9, 29, 7, 15))).toBe(30 * 60 + 11.5 * 3600 + 15 * 60);
  });

  it('moves the working hours with the clocks at both daylight-saving changes', () => {
    const cal = new WorkCalendar(HOURS);
    // Summer time ends on Sunday 25 October: Monday 09:00 is 08:00 UTC.
    expect(cal.between('U1', utc(2026, 10, 22, 18), utc(2026, 10, 26, 8, 30))).toBe(60 * 60);
    // It starts on Sunday 29 March: Thursday 20:00 was 19:00 UTC, Monday 09:10 is 07:10 UTC.
    expect(cal.between('U1', utc(2026, 3, 26, 19), utc(2026, 3, 30, 7, 10))).toBe(40 * 60);
    expect(cal.local(utc(2026, 3, 29, 1))).toEqual({ day: '2026-03-29', seconds: 3 * 3600 });
    expect(cal.local(utc(2026, 10, 25, 1))).toEqual({ day: '2026-10-25', seconds: 2 * 3600 });
  });

  it('stops counting once past a limit', () => {
    const cal = new WorkCalendar(HOURS);
    const total = cal.between('U1', utc(2026, 9, 21, 7), utc(2026, 12, 31, 7));
    const capped = cal.between('U1', utc(2026, 9, 21, 7), utc(2026, 12, 31, 7), 3600);
    expect(total).toBeGreaterThan(100 * 3600);
    expect(capped).toBeGreaterThan(3600);
    expect(capped).toBeLessThanOrEqual(11.5 * 3600);
  });

  it('knows real time zones', () => {
    expect(isTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus_Mons')).toBe(false);
  });
});
