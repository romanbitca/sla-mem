// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { api } from '../../lib/api';
import { buildDirectory } from '../../lib/directory';
import {
  installFakeBridge,
  makeAttachment,
  makeConversation,
  makeImage,
  makeMessage,
  renderWithProviders,
  testDirectory,
  testUsers,
} from '../../test/helpers';
import { MessageItem } from './MessageItem';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TS = '1700000000.000100';

function renderItem(
  props: Partial<Parameters<typeof MessageItem>[0]> & { message: ReturnType<typeof makeMessage> },
  directory = testDirectory(),
) {
  return renderWithProviders(<MessageItem {...props} />, { directory });
}

describe('MessageItem', () => {
  it('shows author, time link and mrkdwn text with resolved mentions', () => {
    renderItem({ message: makeMessage({ ts: TS, text: 'hi <@U2> see *this*' }) });
    const article = screen.getByRole('article');
    expect(within(article).getByText('Alice')).toBeTruthy();
    expect(article.textContent).toContain('@Bob');
    expect(within(article).getByText('this').tagName).toBe('STRONG');
    const timeLink = within(article).getAllByRole('link')[0];
    expect(timeLink.getAttribute('href')).toBe(`/c/C1?ts=${TS}`);
    expect(article.querySelector('time')?.getAttribute('datetime')).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('hides avatar and name for a continuation row', () => {
    renderItem({ message: makeMessage({ ts: TS, text: 'second line' }), continuation: true });
    expect(screen.queryByText('Alice')).toBeNull();
    expect(screen.getByText('second line')).toBeTruthy();
  });

  it('links replies to their thread', () => {
    renderItem({ message: makeMessage({ ts: '1700000100.000000', threadTs: TS, isReply: true }) });
    expect(screen.getAllByRole('link')[0].getAttribute('href')).toBe(`/c/C1?thread=${TS}&ts=1700000100.000000`);
  });

  it('copies the message’s Slack link (the archive’s own address means nothing elsewhere)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderItem({ message: makeMessage({ ts: '1712345678.123456', conversationId: 'C0123' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Copy link to this message in Slack' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('https://9h.slack.com/archives/C0123/p1712345678123456'),
    );
    expect(await screen.findByRole('button', { name: 'Link copied' })).toBeTruthy();
  });

  it('copies reply links with thread_ts and cid', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderItem({
      message: makeMessage({
        ts: '1712345699.000200',
        threadTs: '1712345678.123456',
        isReply: true,
        conversationId: 'C0123',
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy link to this message in Slack' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'https://9h.slack.com/archives/C0123/p1712345699000200?thread_ts=1712345678.123456&cid=C0123',
      ),
    );
  });

  it('offers no Slack link while the workspace address is unknown', () => {
    const noDomain = buildDirectory(testUsers, [makeConversation('C1', 'general')], {}, 'U1', null);
    renderItem({ message: makeMessage({ ts: TS }) }, noDomain);
    expect(screen.queryByRole('button', { name: /Copy link/ })).toBeNull();
  });

  it('renders image thumbnails that open a keyboard-navigable lightbox', () => {
    const images = [makeImage({ id: 'F1', name: 'one.png' }), makeImage({ id: 'F2', name: 'two.png' })];
    renderItem({ message: makeMessage({ ts: TS, files: images }) });

    const thumb = screen.getByRole('button', { name: 'View image one.png' });
    expect(within(thumb).getByRole('img').getAttribute('src')).toBe('archive://thumb/F1');
    fireEvent.click(thumb);
    const dialog = screen.getByRole('dialog', { name: /one\.png/ });
    expect(within(dialog).getByText(/^1 of 2/)).toBeTruthy();
    expect(within(dialog).getByRole('img', { name: 'one.png' }).getAttribute('src')).toBe('archive://file/F1');

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: /two\.png/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog', { name: /one\.png/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a lightbox image with the system app or shows it in Explorer', async () => {
    installFakeBridge(() => undefined, 'win32');
    const openFile = vi.spyOn(api, 'openFile').mockResolvedValue({ ok: true });
    const revealFile = vi.spyOn(api, 'revealFile').mockResolvedValue({ ok: true });
    renderItem({ message: makeMessage({ ts: TS, files: [makeImage({ id: 'F1', name: 'one.png' })] }) });
    fireEvent.click(screen.getByRole('button', { name: 'View image one.png' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open with the default app' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show in Explorer' }));
    await waitFor(() => expect(openFile).toHaveBeenCalledWith({ fileId: 'F1' }));
    expect(revealFile).toHaveBeenCalledWith({ fileId: 'F1' });
  });

  it('renders attachments as unfurl cards and refuses unsafe links', () => {
    const attachments = [
      makeAttachment({
        color: '36a64f',
        serviceName: 'GitHub',
        title: 'Fix the build',
        titleLink: 'https://github.com/acme/app/pull/1',
        text: 'A *bold* change',
        fields: [{ title: 'Status', value: 'Merged', short: true }],
        imageUrl: 'https://opengraph.githubassets.com/abc/acme/app/pull/1',
      }),
      makeAttachment({ title: 'Sneaky', titleLink: 'javascript:alert(1)' }),
    ];
    const { container } = renderItem({ message: makeMessage({ ts: TS, text: 'look', attachments }) });

    const link = screen.getByRole('link', { name: 'Fix the build' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/app/pull/1');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const card = link.closest('[style]') as HTMLElement;
    expect(card.style.borderLeftColor).toBe('rgb(54, 166, 79)');
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Merged')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sneaky' })).toBeNull();
    expect(screen.getByText('Sneaky')).toBeTruthy();
    // Third-party unfurl images only ever load through Slack's image proxy (CSP, PLAN §1.2).
    const image = container.querySelector('img[alt="Fix the build"]');
    expect(image?.getAttribute('src')).toBe(
      `https://slack-imgs.com/?c=1&o1=ro&url=${encodeURIComponent('https://opengraph.githubassets.com/abc/acme/app/pull/1')}`,
    );
  });

  it('does not repeat text that only duplicates an attachment fallback', () => {
    const attachments = [makeAttachment({ fallback: 'Build #12 passed', title: 'Build #12', text: 'passed' })];
    renderItem({ message: makeMessage({ ts: TS, text: 'Build #12 passed', attachments }) });
    expect(screen.queryByText('Build #12 passed')).toBeNull();
    expect(screen.getByText('Build #12')).toBeTruthy();
  });

  it('shows reactions with counts and the names of who reacted', () => {
    renderItem({
      message: makeMessage({
        ts: TS,
        reactions: [
          { name: 'tada', count: 2, users: ['U1', 'U2'] },
          { name: '+1::skin-tone-3', count: 5, users: ['U3'] },
        ],
      }),
    });
    const list = screen.getByRole('list', { name: 'Reactions' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('2')).toBeTruthy();
    expect(within(items[0]).getByRole('tooltip').textContent).toBe('Alice and Bob reacted with :tada:');
    expect(within(items[1]).getByRole('tooltip').textContent).toBe('Carol and 4 more reacted with :+1:');
  });

  it('draws custom emoji that alias standard ones (yay → alias:tada)', async () => {
    const { container } = renderItem({ message: makeMessage({ ts: TS, text: 'we shipped :yay: :partyparrot:' }) });
    await waitFor(() => expect(container.querySelector('span.md-emoji[title=":yay:"]')?.textContent).toBe('🎉'));
    expect(container.querySelector('img.md-emoji-custom')?.getAttribute('src')).toBe(
      'https://emoji.slack-edge.com/T9H/partyparrot/abc.gif',
    );
  });

  it('marks edited messages and lists earlier versions on demand', async () => {
    const getRevisions = vi
      .spyOn(api, 'getRevisions')
      .mockResolvedValue([{ text: 'first draft', editedTs: null, seenAt: 1_700_000_000_000 }]);
    renderItem({ message: makeMessage({ ts: TS, text: 'final', editedTs: '1700000300.000000', revisionCount: 1 }) });

    expect(getRevisions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '(edited)' }));
    const popover = await screen.findByRole('dialog', { name: 'Edit history' });
    await within(popover).findByText('first draft');
    expect(getRevisions).toHaveBeenCalledWith('C1', TS, expect.anything());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a plain edited marker when no earlier versions were captured', () => {
    renderItem({ message: makeMessage({ ts: TS, editedTs: '1700000300.000000' }) });
    expect(screen.getByText('(edited)').tagName).toBe('SPAN');
  });

  it('badges messages deleted in Slack', () => {
    renderItem({ message: makeMessage({ ts: TS, text: 'kept by the archive', isDeleted: true }) });
    expect(screen.getByText('Deleted in Slack')).toBeTruthy();
    expect(screen.getByText('kept by the archive')).toBeTruthy();
    expect(screen.getByRole('article').getAttribute('aria-label')).toContain('deleted in Slack');
  });

  it('summarizes threads and opens them', () => {
    const onOpenThread = vi.fn();
    renderItem({
      message: makeMessage({
        ts: TS,
        threadTs: TS,
        replyCount: 3,
        latestReply: '1700000900.000000',
        replyUsers: ['U2', 'U3'],
      }),
      onOpenThread,
    });
    fireEvent.click(screen.getByRole('button', { name: 'View thread, 3 replies' }));
    expect(onOpenThread).toHaveBeenCalledWith(TS);
    expect(screen.getByText('3 replies')).toBeTruthy();
  });

  it('labels bot posts with their integration name and icon (through the proxy when not Slack’s)', () => {
    const { container } = renderItem({
      message: makeMessage({
        ts: TS,
        userId: null,
        botId: 'B1',
        username: 'CI',
        subtype: 'bot_message',
        botIconUrl: 'https://ci.example.com/bot.png',
      }),
    });
    expect(screen.getByText('CI')).toBeTruthy();
    expect(screen.getByText('App')).toBeTruthy();
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^https:\/\/slack-imgs\.com\/\?c=1&o1=ro&url=/);
  });

  it('renders channel events as compact system lines', () => {
    renderItem({ message: makeMessage({ ts: TS, subtype: 'channel_join', text: '<@U2> has joined the channel' }) });
    const article = screen.getByRole('article');
    expect(article.textContent).toContain('@Bob has joined the channel');
    expect(within(article).queryByText('Reactions')).toBeNull();
  });

  it('flags the highlighted row for the flash animation', () => {
    renderItem({ message: makeMessage({ ts: TS }), highlighted: true });
    expect(screen.getByRole('article').dataset.highlighted).toBe('true');
  });
});
