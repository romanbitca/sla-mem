// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { BeyondFreeWindowDTO, MessageDTO, ThreadDTO } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';
import ConversationPage from '../../pages/ConversationPage';
import { MESSAGE_MAX_PAGES, MESSAGE_PAGE_SIZE } from '../../lib/queries';
import { toLocalDateInput, tsJustBefore, tsToDate } from '../../lib/ts';
import {
  FakeIntersectionObserver,
  fakeMessagesEndpoint,
  installFakeLayout,
  intersect,
  makeConversation,
  makeMessage,
  observerCount,
  renderWithProviders,
  tsAt,
} from '../../test/helpers';

const ROW = 40;
const TOTAL = 1000;
const PARENT = 500;
const replyTs = (k: number) => `${1_700_000_000 + PARENT * 600 + k * 30}.000200`;

const messages: MessageDTO[] = Array.from({ length: TOTAL }, (_, i) =>
  makeMessage({
    ts: tsAt(i),
    userId: i % 3 === 0 ? 'U1' : 'U2',
    text: `msg-${i}`,
    ...(i === PARENT ? { threadTs: tsAt(i), replyCount: 2, latestReply: replyTs(2), replyUsers: ['U3'] } : {}),
  }),
);

const thread: ThreadDTO = {
  parent: messages[PARENT],
  replies: [1, 2].map((k) =>
    makeMessage({ ts: replyTs(k), threadTs: tsAt(PARENT), isReply: true, userId: 'U3', text: `reply-${k}` }),
  ),
};

let getMessages: MockInstance<typeof api.getMessages>;
let restoreLayout: () => void;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  restoreLayout = installFakeLayout(ROW, 600);
  const endpoint = fakeMessagesEndpoint(messages);
  getMessages = vi.spyOn(api, 'getMessages').mockImplementation(async (_id, query = {}) => endpoint(query));
  vi.spyOn(api, 'getConversation').mockResolvedValue(
    makeConversation('C1', 'general', {
      messageCount: TOTAL,
      oldestTs: tsAt(0),
      latestTs: tsAt(TOTAL - 1),
      topic: 'Team chatter',
    }),
  );
  vi.spyOn(api, 'getThread').mockResolvedValue(thread);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreLayout();
  FakeIntersectionObserver.instances.clear();
});

function renderAt(route: string) {
  return renderWithProviders(<ConversationPage />, { route, path: '/c/:id' });
}

const scroller = () => screen.getByTestId('message-scroller');
const rows = () => Array.from(scroller().querySelectorAll<HTMLElement>('[data-msg-ts]'));
const row = (i: number) => scroller().querySelector<HTMLElement>(`[data-msg-ts="${tsAt(i)}"]`);

async function loadOlderOnce() {
  const before = getMessages.mock.calls.length;
  act(() => {
    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());
  });
  const sentinel = screen.getByTestId('sentinel-older');
  await waitFor(() => expect(observerCount(sentinel)).toBe(1));
  act(() => {
    intersect(sentinel);
  });
  await waitFor(() => expect(getMessages.mock.calls.length).toBe(before + 1));
  await waitFor(() => expect(scroller().getAttribute('aria-busy')).toBeNull());
}

describe('ConversationView', () => {
  it('loads the latest page first and starts at the bottom', async () => {
    renderAt('/c/C1');
    await screen.findByText('msg-999');
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getMessages.mock.calls[0].slice(0, 2)).toEqual(['C1', { limit: MESSAGE_PAGE_SIZE }]);
    expect(rows()).toHaveLength(MESSAGE_PAGE_SIZE);
    expect(scroller().scrollTop).toBe(MESSAGE_PAGE_SIZE * ROW);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('#general');
  });

  it('prepends older messages at the top and keeps the reading position', async () => {
    renderAt('/c/C1');
    await screen.findByText('msg-999');
    await loadOlderOnce();

    expect(getMessages.mock.calls[1].slice(0, 2)).toEqual(['C1', { before: tsAt(900), limit: MESSAGE_PAGE_SIZE }]);
    expect(rows()).toHaveLength(2 * MESSAGE_PAGE_SIZE);
    expect(rows()[0].dataset.msgTs).toBe(tsAt(800));
    // msg-900 was at the top of the viewport before the prepend, and still is.
    expect(scroller().scrollTop).toBe(MESSAGE_PAGE_SIZE * ROW);
    expect(row(900)!.getBoundingClientRect().top).toBe(0);
  });

  it('keeps the mounted window bounded and can jump back to the latest messages', async () => {
    renderAt('/c/C1');
    await screen.findByText('msg-999');
    for (let i = 0; i < MESSAGE_MAX_PAGES; i++) await loadOlderOnce();

    // 7 pages fetched, only 6 kept: the newest page was dropped.
    expect(rows()).toHaveLength(MESSAGE_MAX_PAGES * MESSAGE_PAGE_SIZE);
    expect(rows()[0].dataset.msgTs).toBe(tsAt(300));
    expect(row(999)).toBeNull();
    expect(screen.getByTestId('sentinel-newer')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /jump to latest/i }));
    await waitFor(() => expect(row(999)).not.toBeNull());
    expect(rows()).toHaveLength(MESSAGE_PAGE_SIZE);
    expect(scroller().scrollTop).toBe(MESSAGE_PAGE_SIZE * ROW);
  });

  it('loads newer pages when scrolled down inside a jumped-to window', async () => {
    renderAt(`/c/C1?ts=${tsAt(250)}`);
    await screen.findByText('msg-250');
    const sentinel = screen.getByTestId('sentinel-newer');
    await waitFor(() => expect(observerCount(sentinel)).toBe(1));
    act(() => {
      intersect(sentinel);
    });
    await waitFor(() => expect(row(349)).not.toBeNull());
    expect(getMessages.mock.calls.at(-1)!.slice(0, 2)).toEqual(['C1', { after: tsAt(299), limit: MESSAGE_PAGE_SIZE }]);
  });

  it('?ts= loads a window around the message, centers it and highlights it', async () => {
    renderAt(`/c/C1?ts=${tsAt(250)}`);
    await screen.findByText('msg-250');
    expect(getMessages.mock.calls[0].slice(0, 2)).toEqual(['C1', { around: tsAt(250), limit: MESSAGE_PAGE_SIZE }]);
    const target = row(250)!;
    await waitFor(() => expect(target.dataset.highlighted).toBe('true'));
    // Window is 200..299; row 250 is 50 rows down, centered in a 600px viewport.
    expect(scroller().scrollTop).toBe(50 * ROW - (600 - ROW) / 2);
  });

  it('scrolls to an already loaded message without refetching', async () => {
    const { location } = renderAt('/c/C1');
    await screen.findByText('msg-999');
    const calls = getMessages.mock.calls.length;
    const timeLink = within(row(950)!)
      .getAllByRole('link')
      .find((a) => a.getAttribute('href')?.startsWith('/c/'))!;
    fireEvent.click(timeLink);
    await waitFor(() => expect(row(950)!.dataset.highlighted).toBe('true'));
    expect(location.current?.search).toBe(`?ts=${tsAt(950)}`);
    expect(getMessages.mock.calls.length).toBe(calls);
  });

  it('jump to date finds the first message on that day via after=&limit=1, then loads around it', async () => {
    const { location } = renderAt('/c/C1');
    await screen.findByText('msg-999');

    const day = tsToDate(tsAt(300));
    const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const firstOfDay = messages.findIndex((m) => tsToDate(m.ts) >= midnight);

    fireEvent.click(screen.getByRole('button', { name: /jump to date/i }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: toLocalDateInput(day) } });
    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));

    await waitFor(() => expect(location.current?.search).toBe(`?ts=${tsAt(firstOfDay)}`));
    expect(getMessages).toHaveBeenCalledWith('C1', { after: tsJustBefore(midnight), limit: 1 });
    await waitFor(() => expect(row(firstOfDay)?.dataset.highlighted).toBe('true'));
    expect(getMessages.mock.calls.at(-1)!.slice(0, 2)).toEqual([
      'C1',
      { around: tsAt(firstOfDay), limit: MESSAGE_PAGE_SIZE },
    ]);
  });

  it('a link to a thread reply opens the thread and highlights the reply', async () => {
    const { location } = renderAt(`/c/C1?ts=${replyTs(1)}`);
    await screen.findByText('msg-500');
    await waitFor(() => expect(location.current?.search).toContain(`thread=${tsAt(PARENT)}`));
    expect(location.current?.search).toContain(`ts=${replyTs(1)}`);

    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    const reply = await within(panel).findByText('reply-1');
    await waitFor(() => expect(reply.closest('article')!.dataset.highlighted).toBe('true'));
  });

  it('shows a notice when the linked message is not archived', async () => {
    vi.spyOn(api, 'getThread').mockResolvedValue({ parent: null, replies: [] });
    const missing = `${1_700_000_000 + 100 * 600 + 7}.000000`;
    renderAt(`/c/C1?ts=${missing}`);
    await screen.findByText(/isn’t in the archive/);
    expect(rows().length).toBeGreaterThan(0);
  });

  it('opens a thread from the thread summary and closes it again', async () => {
    const { location } = renderAt(`/c/C1?ts=${tsAt(PARENT)}`);
    await screen.findByText('msg-500');
    fireEvent.click(within(row(PARENT)!).getByRole('button', { name: /view thread, 2 replies/i }));
    await waitFor(() => expect(location.current?.search).toBe(`?thread=${tsAt(PARENT)}`));
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    await within(panel).findByText('reply-2');

    fireEvent.click(within(panel).getByRole('button', { name: 'Close thread' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Thread' })).toBeNull());
    expect(location.current?.search).toBe('');
  });

  it('exports the conversation through main and says where it went', async () => {
    const exportConversation = vi
      .spyOn(api, 'exportConversation')
      .mockResolvedValueOnce(null) // the save dialog was cancelled: nothing to say
      .mockResolvedValueOnce({ path: '/Users/me/Documents/#general (Slack).md', messages: 1234 })
      .mockRejectedValueOnce(new ApiError('internal', 'Your disk is full.'));
    renderAt('/c/C1');
    await screen.findByText('msg-999');
    const button = screen.getByRole('button', { name: 'Export as a Markdown file' });

    fireEvent.click(button);
    await waitFor(() => expect(exportConversation).toHaveBeenCalledWith({ conversationId: 'C1' }));
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(button);
    const done = await screen.findByRole('status');
    expect(done.textContent).toContain('Exported 1,234 messages to #general (Slack).md.');
    fireEvent.click(within(done).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());

    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t export: Your disk is full.');
  });

  it('shows an error state with retry when messages fail to load', async () => {
    getMessages.mockRejectedValueOnce(new Error('boom'));
    renderAt('/c/C1');
    await screen.findByText('Couldn’t load messages');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByText('msg-999');
  });
});

describe('the conversation header', () => {
  const seconds = (d: Date) => d.getTime() / 1000;
  const conversation = (hidden?: Omit<BeyondFreeWindowDTO, 'notesToSelf'>) =>
    makeConversation('C1', 'general', {
      messageCount: 1234,
      oldestTs: `${seconds(new Date(2026, 2, 18, 10))}.000000`,
      latestTs: `${seconds(new Date(2026, 8, 18, 15))}.000000`,
      beyondFreeWindow: hidden && { ...hidden, notesToSelf: false },
    });
  async function header(): Promise<HTMLElement> {
    const title = await screen.findByRole('heading', { level: 1, name: '#general' });
    return title.closest('header')!;
  }

  it('gives the total, then how many messages Slack no longer shows and from when to when', async () => {
    vi.spyOn(api, 'getConversation').mockResolvedValue(
      conversation({
        count: 12,
        oldest: seconds(new Date(2026, 2, 18, 10)),
        newest: seconds(new Date(2026, 5, 18, 9)),
      }),
    );
    renderAt('/c/C1');
    const facts = await header();
    await waitFor(() =>
      expect(facts.textContent).toContain(`${(1234).toLocaleString()} messages · Mar 18 – Sep 18, 2026`),
    );
    const hidden = within(facts).getByText(/12 no longer in Slack/);
    expect(hidden.textContent).toBe('12 no longer in Slack · Mar 18 – Jun 18, 2026');
    expect(hidden.getAttribute('title')).toBe(
      '12 messages are older than 90 days (Mar 18 – Jun 18, 2026): Slack Free no longer shows them. They’re kept here.',
    );
    expect(within(facts).queryByText('All still in Slack')).toBeNull();
  });

  it('opens a DM partner’s page from the name, but not from your notes to yourself', async () => {
    vi.spyOn(api, 'getConversation').mockResolvedValue(
      makeConversation('C1', 'Bob', { type: 'im', dmUserId: 'U2', rawName: null }),
    );
    renderAt('/c/C1');
    const title = await screen.findByRole('heading', { level: 1 });
    const name = await within(title).findByRole('link', { name: 'Bob' });
    expect(name.getAttribute('href')).toBe('/people/U2');
    cleanup();
    // The test directory's reader is U1.
    vi.spyOn(api, 'getConversation').mockResolvedValue(
      makeConversation('C1', 'You', { type: 'im', dmUserId: 'U1', rawName: null }),
    );
    renderAt('/c/C1');
    const own = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(own.textContent).toContain('You'));
    expect(within(own).queryByRole('link')).toBeNull();
  });

  it('says when everything is still in Slack, and when the first message drops out', async () => {
    vi.spyOn(api, 'getConversation').mockResolvedValue(conversation({ count: 0, oldest: null, newest: null }));
    renderAt('/c/C1');
    const still = await within(await header()).findByText('All still in Slack');
    expect(still.getAttribute('title')).toBe(
      'Slack Free shows the last 90 days. The oldest message here drops out of Slack on Jun 16, 2026; it stays in your archive.',
    );
    expect(screen.queryByText(/no longer in Slack/)).toBeNull();
  });

  it('never counts notes to yourself as gone from Slack, however old', async () => {
    // The self-DM: an IM with the reader (U1 in the test directory). Its messages are from 2023.
    vi.spyOn(api, 'getConversation').mockResolvedValue(
      makeConversation('D1', 'You', {
        type: 'im',
        rawName: null,
        dmUserId: 'U1',
        messageCount: TOTAL,
        oldestTs: tsAt(0),
        latestTs: tsAt(TOTAL - 1),
        beyondFreeWindow: { count: 0, oldest: null, newest: null, notesToSelf: true },
      }),
    );
    renderAt('/c/D1');
    const title = await screen.findByRole('heading', { level: 1, name: 'You' });
    const still = await within(title.closest('header')!).findByText('All still in Slack');
    expect(still.getAttribute('title')).toBe(
      'Slack Free shows the last 90 days, but it keeps showing notes to yourself however old they are.',
    );
    await screen.findByText(`msg-${TOTAL - 1}`);
    const days = scroller().querySelectorAll('h2');
    expect(days.length).toBeGreaterThan(0);
    expect(scroller().textContent).not.toContain('only in the archive');
  });

  it('marks days older than 90 days in other conversations', async () => {
    renderAt('/c/C1');
    await screen.findByText(`msg-${TOTAL - 1}`);
    expect(scroller().textContent).toContain('only in the archive');
  });
});
