// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ThreadDTO } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';
import { makeFile, makeMessage, renderWithProviders } from '../../test/helpers';
import { ThreadPanel } from './ThreadPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PARENT_TS = '1700000000.000100';
const DAY = 86_400;

function thread(overrides: Partial<ThreadDTO> = {}): ThreadDTO {
  return {
    parent: makeMessage({
      ts: PARENT_TS,
      threadTs: PARENT_TS,
      text: 'the question',
      replyCount: 3,
      replyUsers: ['U2', 'U3'],
    }),
    replies: [
      makeMessage({ ts: '1700000060.000000', threadTs: PARENT_TS, isReply: true, userId: 'U2', text: 'answer one' }),
      makeMessage({ ts: '1700000090.000000', threadTs: PARENT_TS, isReply: true, userId: 'U2', text: 'answer two' }),
      makeMessage({
        ts: `${1_700_000_000 + 2 * DAY}.000000`,
        threadTs: PARENT_TS,
        isReply: true,
        userId: 'U3',
        text: 'late answer',
      }),
    ],
    ...overrides,
  };
}

function renderPanel(props: { highlightTs?: string | null; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const utils = renderWithProviders(
    <ThreadPanel conversationId="C1" threadTs={PARENT_TS} highlightTs={props.highlightTs} onClose={onClose} />,
  );
  return { ...utils, onClose };
}

describe('ThreadPanel', () => {
  it('shows the parent and every reply, grouping consecutive replies by author', async () => {
    const getThread = vi.spyOn(api, 'getThread').mockResolvedValue(thread());
    renderPanel();
    const panel = screen.getByRole('complementary', { name: 'Thread' });
    await within(panel).findByText('the question');
    expect(getThread).toHaveBeenCalledWith('C1', PARENT_TS, expect.anything());
    expect(within(panel).getByText('answer one')).toBeTruthy();
    expect(within(panel).getByText('late answer')).toBeTruthy();
    expect(within(panel).getByText('3 replies')).toBeTruthy();
    expect(within(panel).getByText('#general')).toBeTruthy();
    // "answer two" continues Bob's previous reply: his name appears once for the pair.
    expect(within(panel).getAllByText('Bob')).toHaveLength(1);
    // The parent shows no thread summary inside the thread itself.
    expect(within(panel).queryByRole('button', { name: /view thread/i })).toBeNull();
  });

  it('highlights the linked reply', async () => {
    vi.spyOn(api, 'getThread').mockResolvedValue(thread());
    renderPanel({ highlightTs: '1700000090.000000' });
    const reply = await screen.findByText('answer two');
    await waitFor(() => expect(reply.closest('article')!.dataset.highlighted).toBe('true'));
    expect(screen.getByText('answer one').closest('article')!.dataset.highlighted).toBeUndefined();
  });

  it('closes via the close button and via Escape', async () => {
    vi.spyOn(api, 'getThread').mockResolvedValue(thread());
    const { onClose } = renderPanel();
    await screen.findByText('the question');
    fireEvent.click(screen.getByRole('button', { name: 'Close thread' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('lets an open lightbox consume Escape before the panel does', async () => {
    const withImage = thread();
    withImage.replies[0] = {
      ...withImage.replies[0],
      files: [
        makeFile({ id: 'F9', name: 'shot.png', isImage: true, mimetype: 'image/png', thumbUrl: 'archive://thumb/F9' }),
      ],
    };
    vi.spyOn(api, 'getThread').mockResolvedValue(withImage);
    const { onClose } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'View image shot.png' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('explains a thread whose parent is not archived', async () => {
    vi.spyOn(api, 'getThread').mockResolvedValue(thread({ parent: null }));
    renderPanel();
    await screen.findByText(/started this thread isn’t in the archive/);
    expect(screen.getByText('answer one')).toBeTruthy();
  });

  it('notes replies Slack has that the archive does not', async () => {
    const t = thread();
    t.parent = { ...t.parent!, replyCount: 5 };
    vi.spyOn(api, 'getThread').mockResolvedValue(t);
    renderPanel();
    await screen.findByText('2 replies in Slack weren’t archived.');
  });

  it('shows an error state when the thread cannot be loaded', async () => {
    vi.spyOn(api, 'getThread').mockRejectedValue(
      new ApiError('internal', 'Something went wrong. Nothing was lost — please try again.'),
    );
    renderPanel();
    await screen.findByText('Couldn’t load this thread');
    expect(screen.getByText(/Nothing was lost/)).toBeTruthy();
  });

  it('shows an empty state for an unknown thread', async () => {
    vi.spyOn(api, 'getThread').mockResolvedValue({ parent: null, replies: [] });
    renderPanel();
    await screen.findByText('Thread not found');
  });
});
