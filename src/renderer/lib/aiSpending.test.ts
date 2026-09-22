import { describe, expect, it } from 'vitest';
import { axisLabel, bucketLabel, formatUsd, parseLocalDate, spendingBuckets, spendingTotals } from './aiSpending';

/** Wednesday, September 23, 2026, mid-afternoon (local time). */
const TODAY = new Date(2026, 8, 23, 15, 30);
const day = (date: string, costUsd: number, questions = 1) => ({ date, costUsd, questions });

describe('spendingBuckets', () => {
  it('has a bar for each of the last 30 days, today last', () => {
    const bars = spendingBuckets(
      [day('2026-08-24', 9), day('2026-08-25', 0.5), day('2026-09-22', 0.21, 13), day('2026-09-24', 9)],
      'day',
      TODAY,
    );
    expect(bars).toHaveLength(30);
    expect(bars[0]).toMatchObject({ start: new Date(2026, 7, 25), costUsd: 0.5, questions: 1, current: false });
    expect(bars[28]).toMatchObject({ start: new Date(2026, 8, 22), costUsd: 0.21, questions: 13 });
    expect(bars[29]).toMatchObject({ start: new Date(2026, 8, 23), last: new Date(2026, 8, 23), current: true });
    // A day before the chart, and one in the future (a clock put back), are left out.
    expect(bars.reduce((sum, b) => sum + b.costUsd, 0)).toBeCloseTo(0.71, 6);
  });

  it('adds up weeks from Monday, the last 12 of them', () => {
    const bars = spendingBuckets(
      [
        day('2026-09-20', 0.1),
        day('2026-09-21', 0.2),
        day('2026-09-23', 0.3),
        day('2026-07-06', 0.4),
        day('2026-07-05', 9),
      ],
      'week',
      TODAY,
    );
    expect(bars).toHaveLength(12);
    expect(bars[11]).toMatchObject({ start: new Date(2026, 8, 21), last: new Date(2026, 8, 27), current: true });
    expect(bars[11].costUsd).toBeCloseTo(0.5, 6);
    expect(bars[10]).toMatchObject({ start: new Date(2026, 8, 14), costUsd: 0.1 });
    expect(bars[0]).toMatchObject({ start: new Date(2026, 6, 6), costUsd: 0.4 });
  });

  it('adds up calendar months, the last 12 of them', () => {
    const bars = spendingBuckets(
      [day('2025-09-30', 9), day('2025-10-01', 1), day('2026-09-01', 0.25, 2), day('2026-09-23', 0.5, 3)],
      'month',
      TODAY,
    );
    expect(bars).toHaveLength(12);
    expect(bars[0]).toMatchObject({ start: new Date(2025, 9, 1), last: new Date(2025, 9, 31), costUsd: 1 });
    expect(bars[11]).toMatchObject({ start: new Date(2026, 8, 1), costUsd: 0.75, questions: 5, current: true });
  });
});

describe('spendingTotals', () => {
  it('adds up today, this week, this month and everything, and says since when', () => {
    const totals = spendingTotals(
      [
        day('2026-06-02', 1, 10),
        day('2026-09-01', 0.5, 4),
        day('2026-09-20', 0.25, 2), // Sunday: last week
        day('2026-09-21', 0.1, 1),
        day('2026-09-23', 0.2, 3),
        day('2026-09-24', 5, 5), // tomorrow: not yet
        day('nonsense', 5, 5),
      ],
      TODAY,
    );
    expect(totals.today).toEqual({ costUsd: 0.2, questions: 3 });
    expect(totals.week.questions).toBe(4);
    expect(totals.week.costUsd).toBeCloseTo(0.3, 6);
    expect(totals.month.questions).toBe(10);
    expect(totals.month.costUsd).toBeCloseTo(1.05, 6);
    expect(totals.all.questions).toBe(20);
    expect(totals.since).toEqual(new Date(2026, 5, 2));
  });

  it('is all zero with nothing spent', () => {
    expect(spendingTotals([], TODAY)).toEqual({
      today: { costUsd: 0, questions: 0 },
      week: { costUsd: 0, questions: 0 },
      month: { costUsd: 0, questions: 0 },
      all: { costUsd: 0, questions: 0 },
      since: null,
    });
  });
});

describe('spending words', () => {
  it('formats dollars, down to “under $0.01”', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.004)).toBe('under $0.01');
    expect(formatUsd(0.006)).toBe('$0.01');
    expect(formatUsd(0.21)).toBe('$0.21');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('names each bar, and the ends of the chart', () => {
    const [firstDay, , ...days] = spendingBuckets([], 'day', TODAY);
    expect(bucketLabel(days[days.length - 1], 'day')).toBe('Wed, Sep 23');
    expect(axisLabel(firstDay, 'day')).toBe('Aug 25');
    expect(axisLabel(days[days.length - 1], 'day')).toBe('Today');

    const weeks = spendingBuckets([], 'week', TODAY);
    expect(bucketLabel(weeks[11], 'week')).toBe('Sep 21 – 27');
    expect(bucketLabel(weeks[8], 'week')).toBe('Aug 31 – Sep 6');
    expect(axisLabel(weeks[0], 'week')).toBe('Jul 6');
    expect(axisLabel(weeks[11], 'week')).toBe('This week');

    const months = spendingBuckets([], 'month', TODAY);
    expect(bucketLabel(months[11], 'month')).toBe('September 2026');
    expect(axisLabel(months[0], 'month')).toBe('Oct 2025');
    expect(axisLabel(months[11], 'month')).toBe('This month');
  });

  it('reads only whole local dates', () => {
    expect(parseLocalDate('2026-09-23')).toEqual(new Date(2026, 8, 23));
    expect(parseLocalDate('2026-9-23')).toBeNull();
    expect(parseLocalDate('')).toBeNull();
  });
});
