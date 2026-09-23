// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { StyleDTO, StyleReviewDTO } from '../../../shared/types';
import { api } from '../../lib/api';
import { buildDirectory } from '../../lib/directory';
import StylePage from '../../pages/StylePage';
import { makeConversation, makeSettings, makeUser, renderWithProviders } from '../../test/helpers';

const directory = buildDirectory(
  [makeUser('U1', 'Me'), makeUser('U2', 'Dana Ruiz'), makeUser('U3', 'Felix'), makeUser('U4', 'Lena')],
  [
    makeConversation('C9', '9h-sick-emergency-leave', { type: 'channel' }),
    makeConversation('C1', '9h-general', { type: 'channel' }),
    makeConversation('C2', 'tech-lead-pmo', { type: 'channel' }),
  ],
  {},
  'U1',
  '9h',
);

const period = (start: string, count: number, minutes: number | null) => ({
  start,
  count,
  averageSeconds: minutes == null ? null : minutes * 60,
});

function makeStyle(extra: Partial<StyleDTO> = {}): StyleDTO {
  return {
    messageCount: 998,
    englishCount: 867,
    firstTs: '1781724739.000000',
    tone: 'friendly',
    checks: [
      {
        id: 'capitals',
        good: false,
        count: 648,
        total: 867,
        words: [
          { word: 'i', count: 295 },
          { word: 'im', count: 55 },
        ],
        example: {
          before: 'i dont have a choice.',
          after: "I don't have a choice.",
          conversationId: 'D2',
          ts: '1789000000.000100',
          threadTs: null,
          isReply: false,
        },
      },
      { id: 'please', good: true, count: 47, total: 62, words: [], example: null },
    ],
    hours: { days: [1, 2, 3, 4], start: 540, end: 1230, timeZone: 'Europe/Amsterdam', timeZoneIsDefault: true },
    you: {
      count: 161,
      averageSeconds: 3714,
      medianSeconds: 160,
      buckets: [108, 24, 15, 14],
      dm: { count: 119, averageSeconds: 4524 },
      mentions: { count: 42, averageSeconds: 1416 },
    },
    them: {
      count: 183,
      averageSeconds: 3511,
      medianSeconds: 109,
      buckets: [147, 11, 16, 9],
      dm: null,
      mentions: null,
    },
    weeks: [period('2026-08-31', 0, null), period('2026-09-07', 9, 89), period('2026-09-14', 8, 4)],
    months: [period('2026-08-01', 42, 95), period('2026-09-01', 18, 49)],
    fastest: [
      { userId: 'U4', count: 12, averageSeconds: 30 },
      { userId: 'U2', count: 14, averageSeconds: 660 },
    ],
    slowest: [{ userId: 'U3', count: 5, averageSeconds: 13_680 }],
    rules: {
      maxWaitDays: 3,
      channelAnswerHours: 24,
      windowDays: 365,
      minAnswers: 5,
      rankMinAnswers: 3,
      ranked: 10,
      writingMessages: 5000,
      openerQuietHours: 3,
      burstMin: 3,
      burstSeconds: 60,
      exampleDays: 120,
      habits: {
        smallStarts: 20,
        smallIPer100: 2,
        apostrophesPer100: 2,
        greeting: 80,
        helloOnly: 5,
        please: 50,
        runsPer100: 1.5,
        casualPer100: 1,
        friendlyGreeting: 60,
        friendlyPlease: 50,
      },
    },
    repliesSince: null,
    yourDaysOff: 12,
    daysOffSources: [
      { conversationId: 'C1', kind: 'list', days: 597 },
      { conversationId: 'C9', kind: 'notices', days: 134 },
      { conversationId: 'C2', kind: 'list', days: 1 },
    ],
    ...extra,
  };
}

const REVIEW: StyleReviewDTO = {
  summary: 'You come across as helpful and quick.',
  strengths: ['Quick to help'],
  tips: [
    {
      title: 'Lead with the ask',
      tip: 'Put the question first.',
      before: 'so about the thing, can you check',
      after: 'Could you check the invoice?',
      message: { conversationId: 'D2', ts: '1789000000.000200', threadTs: null, isReply: false },
    },
  ],
  typos: [{ wrong: 'clinet', right: 'client' }],
  messageCount: 150,
  usage: { model: 'claude-sonnet-5', inputTokens: 7000, outputTokens: 900, costUsd: 0.023 },
  at: Date.UTC(2026, 8, 22),
};

function renderStyle({
  style = makeStyle(),
  review = null as StyleReviewDTO | null,
  aiKey = true,
}: { style?: StyleDTO; review?: StyleReviewDTO | null; aiKey?: boolean } = {}) {
  vi.spyOn(api, 'getStyle').mockResolvedValue(style);
  vi.spyOn(api, 'getStyleReview').mockResolvedValue(review);
  const settings = makeSettings({ ai: { saved: aiKey, hint: aiKey ? 'x7Qa' : null } });
  vi.spyOn(api, 'getSettings').mockResolvedValue(settings);
  return renderWithProviders(<StylePage />, { route: '/style', directory });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('My style', () => {
  it('sums up your tone, and how fast you and others answer, on working hours', async () => {
    renderStyle();
    expect(await screen.findByRole('heading', { name: 'Friendly, but casual' })).toBeTruthy();
    expect(
      screen.getByText(/You already say please\. Capital letters and apostrophes would make you sound/),
    ).toBeTruthy();
    const card = screen.getByRole('region', { name: 'Reply time' });
    expect(within(card).getByText('1 h 02 min')).toBeTruthy();
    expect(within(card).getByText('3 min')).toBeTruthy();
    expect(within(card).getByText('82%')).toBeTruthy();
    expect(card.textContent).toContain('People answer yours in 59 min on average.');
    // Only the channels most days off came from are named.
    expect(card.textContent).toContain(
      'Counted Mon–Thu, 09:00–20:30 Amsterdam time. Nights, other days and days off don’t count (12 days of yours, from #9h-general and #9h-sick-emergency-leave).',
    );
  });

  it('charts your average by week or by month, from your first answers', async () => {
    renderStyle();
    const weeks = await screen.findByRole('list', { name: 'Your average reply time per week' });
    // The empty week before the first answers is left out.
    expect(
      within(weeks)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['Week of 7 Sep: 1 h 29 min on average, 9 answers', 'Week of 14 Sep: 4 min on average, 8 answers']);
    fireEvent.click(screen.getByRole('button', { name: 'Months' }));
    const months = screen.getByRole('list', { name: 'Your average reply time per month' });
    expect(within(months).getAllByRole('listitem')[1].getAttribute('aria-label')).toBe(
      'September 2026: 49 min on average, 18 answers',
    );
  });

  it('lists whom you answer fastest and slowest, each opening their page', async () => {
    renderStyle();
    const card = await screen.findByRole('region', { name: 'Who you answer fastest and slowest' });
    const lena = within(card).getByRole('link', { name: /Lena/ });
    expect(lena.getAttribute('href')).toBe('/people/U4');
    expect(lena.textContent).toContain('under a minute');
    expect(within(card).getByRole('link', { name: /Felix/ }).textContent).toContain('3 h 48 min');
  });

  it('folds each writing check out to what it means, with your message as it could read', async () => {
    renderStyle();
    const card = await screen.findByRole('region', { name: 'How you write' });
    const capitals = within(card).getByRole('button', { name: /Capital letters and apostrophes/ });
    expect(capitals.textContent).toContain('75% start small');
    expect(within(card).queryByText('i dont have a choice.')).toBeNull();
    fireEvent.click(capitals);
    expect(capitals.getAttribute('aria-expanded')).toBe('true');
    expect(within(card).getByText('i dont have a choice.')).toBeTruthy();
    expect(within(card).getByText("I don't have a choice.")).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open the message' }).getAttribute('href')).toBe(
      '/c/D2?ts=1789000000.000100',
    );
    fireEvent.click(within(card).getByRole('button', { name: /“Please” when you ask/ }));
    expect(card.textContent).toContain('76% of your “can you …” requests say please or “could you”.');
  });

  it('saves new working hours, and checks them first', async () => {
    const update = vi
      .spyOn(api, 'updatePreferences')
      .mockImplementation(async (patch) => makeSettings({ preferences: patch }));
    renderStyle();
    fireEvent.click(await screen.findByRole('button', { name: 'Change hours' }));
    const dialog = screen.getByRole('dialog', { name: 'Working hours' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Friday' }));
    fireEvent.change(within(dialog).getByLabelText('To'), { target: { value: '18:30' } });
    fireEvent.change(within(dialog).getByLabelText('Time zone'), { target: { value: 'Africa/Cairo' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        workHours: { days: [1, 2, 3, 4, 5], start: 540, end: 1110, timeZone: 'Africa/Cairo' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Change hours' }));
    const again = screen.getByRole('dialog', { name: 'Working hours' });
    fireEvent.change(within(again).getByLabelText('From'), { target: { value: '21:00' } });
    expect(within(again).getByRole('alert').textContent).toBe('The day has to start before it ends.');
    expect((within(again).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Claude’s saved review without asking again, and asks only on a click', async () => {
    const review = vi.spyOn(api, 'reviewStyle').mockResolvedValue({ ...REVIEW, summary: 'A newer review.' });
    renderStyle({ review: REVIEW });
    const card = await screen.findByRole('region', { name: 'Claude’s review' });
    expect(await within(card).findByText('You come across as helpful and quick.')).toBeTruthy();
    expect(within(card).getByText('Could you check the invoice?')).toBeTruthy();
    expect(card.textContent).toContain('clinet→client');
    expect(card.textContent).toContain('your latest 150 messages · Claude Sonnet 5');
    expect(review).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole('button', { name: 'Review again' }));
    expect(await within(card).findByText('A newer review.')).toBeTruthy();
    expect(review).toHaveBeenCalledTimes(1);
  });

  it('points to Settings for the key before the first review', async () => {
    renderStyle({ aiKey: false });
    const card = await screen.findByRole('region', { name: 'Claude’s review' });
    expect(within(card).getByRole('link', { name: 'Add an API key' }).getAttribute('href')).toBe('/settings');
    expect(within(card).queryByRole('button', { name: /Review/ })).toBeNull();
  });

  it('explains each part behind an “i”, with the numbers it was worked out with', async () => {
    renderStyle();
    const replies = await screen.findByRole('region', { name: 'Reply time' });
    const info = within(replies).getByRole('button', { name: 'How reply time is worked out' });
    expect(info.getAttribute('aria-expanded')).toBe('false');
    fireEvent.mouseEnter(info);
    expect(info.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(info.getAttribute('aria-controls')!)!;
    expect(panel.textContent).toContain('The clock runs only Mon–Thu, 09:00–20:30 Amsterdam time.');
    expect(panel.textContent).toContain('answers more than 3 working days later');
    expect(panel.textContent).toContain('your next top-level message within 24 hours');

    fireEvent.click(within(replies).getByRole('button', { name: 'How the chart is worked out' }));
    expect(replies.textContent).toContain('(Monday to Sunday) or month, in Amsterdam time');

    const ranking = screen.getByRole('region', { name: 'Who you answer fastest and slowest' });
    fireEvent.click(within(ranking).getByRole('button', { name: 'How the lists are made' }));
    expect(ranking.textContent).toContain('Only people you answered at least 3 times');
    expect(ranking.textContent).toContain('At most 10 in each list. With fewer than 20 people');

    const writing = screen.getByRole('region', { name: 'How you write' });
    fireEvent.click(within(writing).getByRole('button', { name: 'How the writing checks work' }));
    expect(writing.textContent).toContain('over your latest 5,000 messages');
    expect(writing.textContent).toContain('at most 20% of your messages start with a small letter');
    expect(writing.textContent).toContain('3 or more messages in a row, each within 60 seconds of the last');

    const review = screen.getByRole('region', { name: 'Claude’s review' });
    fireEvent.click(within(review).getByRole('button', { name: 'What the review sends, and what it costs' }));
    expect(review.textContent).toContain('your latest 150 messages that have words in them');
    expect(review.textContent).toContain('using Claude Sonnet 5');

    fireEvent.click(screen.getByRole('button', { name: 'How the headline is decided' }));
    expect(document.body.textContent).toContain('at least 60% of the chats you start open with a hello');
  });

  it('says so when the archive holds nothing of yours', async () => {
    renderStyle({ style: makeStyle({ messageCount: 0, checks: [], you: null, tone: null }) });
    expect(await screen.findByText('Nothing of yours yet')).toBeTruthy();
  });
});
