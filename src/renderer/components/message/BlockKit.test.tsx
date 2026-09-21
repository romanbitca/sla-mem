// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import type { BlockDTO } from '../../../shared/types';
import { listMarker, plainTextNodes, richBlockNodes, richInlineNodes, richList, textObject } from '../../lib/blockkit';
import { loadEmojiMap } from '../../lib/emoji';
import { makeAttachment, makeMessage, renderWithProviders } from '../../test/helpers';
import { BlockKit } from './BlockKit';
import { MessageItem } from './MessageItem';

beforeAll(() => loadEmojiMap());
afterEach(cleanup);

/** A deploy notification as CI bots post it: header, section with fields and a button, context. */
const deployBlocks: BlockDTO[] = [
  { type: 'header', block_id: 'h', text: { type: 'plain_text', text: 'Deploy succeeded :rocket:', emoji: true } },
  {
    type: 'section',
    block_id: 's',
    text: { type: 'mrkdwn', text: ':white_check_mark: *billing-api* `v2.17.5` → *production* by <@U2>' },
    fields: [
      { type: 'mrkdwn', text: '*Commit*\n<https://github.com/acme/app/commit/abc123|abc123>' },
      { type: 'mrkdwn', text: '*Duration*\n4m 12s' },
    ],
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: 'View pipeline' },
      url: 'https://ci.example.com/pipelines/42',
    },
  },
  { type: 'divider', block_id: 'd' },
  {
    type: 'context',
    block_id: 'c',
    elements: [
      { type: 'image', image_url: 'https://ci.example.com/logo.png', alt_text: 'CI' },
      { type: 'mrkdwn', text: 'Pipeline #80803 · <https://ci.example.com|CI>' },
    ],
  },
  {
    type: 'actions',
    block_id: 'a',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Roll back' }, style: 'danger', action_id: 'rollback' },
      { type: 'button', text: { type: 'plain_text', text: 'Open run' }, url: 'javascript:alert(1)' },
      { type: 'static_select', placeholder: { type: 'plain_text', text: 'Pick an environment' } },
    ],
  },
];

/** Slack's rich text as sent for a formatted user message (lists, quote, code, mentions, date). */
const richBlocks: BlockDTO[] = [
  {
    type: 'rich_text',
    block_id: 'r',
    elements: [
      {
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Release plan for ' },
          { type: 'user', user_id: 'U2' },
          { type: 'text', text: ' in ' },
          { type: 'channel', channel_id: 'C1' },
          { type: 'text', text: ': ' },
          { type: 'text', text: 'read this', style: { bold: true } },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'npm run check', style: { code: true } },
          { type: 'emoji', name: '+1', skin_tone: 3 },
          { type: 'text', text: '\n' },
        ],
      },
      {
        type: 'rich_text_list',
        style: 'bullet',
        indent: 0,
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Freeze ' },
              { type: 'text', text: 'main', style: { italic: true } },
            ],
          },
          {
            type: 'rich_text_section',
            elements: [{ type: 'link', url: 'https://wiki.example.com/release', text: 'Checklist' }],
          },
        ],
      },
      {
        type: 'rich_text_list',
        style: 'bullet',
        indent: 1,
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'nested item' }] }],
      },
      {
        type: 'rich_text_list',
        style: 'ordered',
        indent: 0,
        offset: 2,
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'third step' }] }],
      },
      {
        type: 'rich_text_quote',
        elements: [
          { type: 'text', text: 'Ship it on Friday? ' },
          { type: 'broadcast', range: 'here' },
        ],
      },
      { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'git tag v2.0\ngit push --tags' }] },
      {
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Due ' },
          { type: 'date', timestamp: 1_767_225_600, format: '{date_short}', fallback: 'Jan 1st' },
          { type: 'text', text: ' ' },
          { type: 'link', url: 'javascript:alert(1)', text: 'sneaky' },
        ],
      },
    ],
  },
];

function renderBlocks(blocks: BlockDTO[]) {
  return renderWithProviders(<BlockKit blocks={blocks} />);
}

describe('<BlockKit>', () => {
  it('renders a deploy notification: header, mrkdwn section, fields, context and inert buttons', () => {
    const { container } = renderBlocks(deployBlocks);
    expect(screen.getByText(/Deploy succeeded/).textContent).toContain('🚀');
    expect(screen.getByText('billing-api').tagName).toBe('STRONG');
    expect(screen.getByText('v2.17.5').tagName).toBe('CODE');
    expect(screen.getByText('production').tagName).toBe('STRONG');
    expect(container.textContent).toContain('@Bob');
    expect(screen.getByRole('link', { name: 'abc123' }).getAttribute('href')).toBe(
      'https://github.com/acme/app/commit/abc123',
    );
    expect(screen.getByText('Duration')).toBeTruthy();
    expect(container.querySelector('hr')).not.toBeNull();
    // The context icon comes through Slack's image proxy, never straight from a third party.
    const icon = screen.getByRole('img', { name: 'CI' });
    expect(icon.getAttribute('src')).toBe(
      `https://slack-imgs.com/?c=1&o1=ro&url=${encodeURIComponent('https://ci.example.com/logo.png')}`,
    );
    // A link button may open its page; app buttons (and unsafe URLs) are inert labels.
    const pipeline = screen.getByRole('link', { name: 'View pipeline' });
    expect(pipeline.getAttribute('href')).toBe('https://ci.example.com/pipelines/42');
    expect(pipeline.getAttribute('target')).toBe('_blank');
    expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull();
    expect(screen.getByText('Roll back').closest('[title]')?.getAttribute('title')).toMatch(
      /don’t work in the archive/,
    );
    expect(screen.queryByRole('link', { name: 'Open run' })).toBeNull();
    expect(screen.getByText('Open run')).toBeTruthy();
    expect(screen.getByText('Pick an environment')).toBeTruthy();
  });

  it('renders rich text: styles, mentions, emoji, lists with nesting, quotes, code and dates', () => {
    const { container } = renderBlocks(richBlocks);
    expect(container.textContent).toContain('Release plan for @Bob in #general');
    expect(screen.getByText('read this').tagName).toBe('STRONG');
    expect(screen.getByText('npm run check').tagName).toBe('CODE');
    expect(container.querySelector('span.md-emoji[title=":+1::skin-tone-3:"]')?.textContent).toBe('👍🏼');
    expect(screen.getByRole('link', { name: '#general' }).getAttribute('href')).toBe('/c/C1');

    const lists = container.querySelectorAll('ul, ol');
    expect(lists).toHaveLength(3);
    const [bullets, nested, ordered] = [...lists] as HTMLElement[];
    expect(within(bullets).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('main').tagName).toBe('EM');
    expect(screen.getByRole('link', { name: 'Checklist' }).getAttribute('href')).toBe(
      'https://wiki.example.com/release',
    );
    expect(bullets.style.listStyleType).toBe('disc');
    expect(nested.style.listStyleType).toBe('circle');
    expect(nested.style.marginLeft).toBe('1.5em');
    expect(ordered.tagName).toBe('OL');
    expect(ordered.getAttribute('start')).toBe('3');

    const quote = container.querySelector('blockquote.md-quote');
    expect(quote?.textContent).toBe('Ship it on Friday? @here');
    expect(container.querySelector('pre.md-pre')?.textContent).toBe('git tag v2.0\ngit push --tags');
    expect(container.querySelector('time.md-date')?.textContent).toBe('Jan 1st');
    expect(screen.queryByRole('link', { name: 'sneaky' })).toBeNull();
    expect(screen.getByText(/sneaky/)).toBeTruthy();
  });

  it('shows image blocks through the proxy with their title, and hides them when they fail', () => {
    renderBlocks([
      {
        type: 'image',
        title: { type: 'plain_text', text: 'Traffic this week' },
        image_url: 'https://grafana.example.com/render/traffic.png',
        alt_text: 'Traffic graph',
      },
    ]);
    expect(screen.getByText('Traffic this week')).toBeTruthy();
    const img = screen.getByRole('img', { name: 'Traffic graph' });
    expect(img.getAttribute('src')).toMatch(/^https:\/\/slack-imgs\.com\/\?c=1&o1=ro&url=/);
  });

  it('draws video and file blocks as simple cards, never embedded players', () => {
    const { container } = renderBlocks([
      {
        type: 'video',
        title: { type: 'plain_text', text: 'Demo recording' },
        title_url: 'https://videos.example.com/watch/1',
        video_url: 'https://videos.example.com/embed/1',
        thumbnail_url: 'https://videos.example.com/thumb/1.jpg',
        alt_text: 'Demo',
        provider_name: 'VideoSite',
      },
      { type: 'file', external_id: 'ABCD1', source: 'remote' },
    ]);
    expect(screen.getByRole('link', { name: 'Demo recording' }).getAttribute('href')).toBe(
      'https://videos.example.com/watch/1',
    );
    expect(screen.getByText('VideoSite')).toBeTruthy();
    expect(screen.getByText('A file shared from another app')).toBeTruthy();
    expect(container.querySelector('iframe, video, embed, object')).toBeNull();
  });

  it('treats plain_text as literal text (only emoji are drawn), never as mrkdwn', () => {
    const { container } = renderBlocks([
      { type: 'section', text: { type: 'plain_text', text: '*not bold* <@U2> & <b>tag</b> :tada:' } },
      { type: 'section', text: { type: 'plain_text', text: 'keep :tada:', emoji: false } },
    ]);
    expect(container.querySelector('strong, b, a')).toBeNull();
    expect(container.textContent).toContain('*not bold* <@U2> & <b>tag</b> 🎉');
    expect(container.textContent).toContain('keep :tada:');
  });

  it('shows the text of unknown blocks when they have some, and skips the rest', () => {
    const { container } = renderBlocks([
      { type: 'markdown', text: 'Plain **markdown** from an AI app' },
      { type: 'call', call_id: 'R1' },
      { type: 'future_block', text: { type: 'mrkdwn', text: 'future *text*' } },
      { nope: true } as unknown as BlockDTO,
    ]);
    expect(container.textContent).toContain('Plain **markdown** from an AI app');
    expect(screen.getByText('text').tagName).toBe('STRONG');
    expect(container.textContent).not.toContain('R1');
  });
});

describe('messages with blocks', () => {
  it('renders the blocks instead of the notification fallback text', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({
          ts: '1700000000.000100',
          userId: null,
          botId: 'B1',
          username: 'Deploy Bot',
          subtype: 'bot_message',
          text: 'Deploy succeeded: billing-api v2.17.5',
          blocks: deployBlocks,
        })}
      />,
    );
    expect(screen.queryByText('Deploy succeeded: billing-api v2.17.5')).toBeNull();
    expect(screen.getByText(/Deploy succeeded/)).toBeTruthy();
    expect(screen.getByText('Duration')).toBeTruthy();
  });

  it('renders blocks inside attachments instead of an empty card', () => {
    const { container } = renderWithProviders(
      <MessageItem
        message={makeMessage({
          ts: '1700000000.000100',
          text: '',
          attachments: [
            makeAttachment({
              color: '2eb67d',
              fallback: '[acme/app] PR #12 merged',
              blocks: [
                {
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text: '*<https://github.com/acme/app/pull/12|#12 Fix the build>*\nMerged by <@U3>',
                  },
                },
                { type: 'context', elements: [{ type: 'mrkdwn', text: 'acme/app · 2 commits' }] },
              ],
            }),
          ],
        })}
      />,
    );
    expect(screen.getByRole('link', { name: '#12 Fix the build' }).getAttribute('href')).toBe(
      'https://github.com/acme/app/pull/12',
    );
    expect(container.textContent).toContain('Merged by @Carol');
    expect(screen.getByText('acme/app · 2 commits')).toBeTruthy();
    const rail = container.querySelector('[style*="border-left-color"]') as HTMLElement;
    expect(rail.style.borderLeftColor).toBe('rgb(46, 182, 125)');
  });
});

describe('block kit helpers', () => {
  it('reads text objects', () => {
    expect(textObject({ type: 'mrkdwn', text: '*a*' })).toEqual({ kind: 'mrkdwn', text: '*a*' });
    expect(textObject({ type: 'plain_text', text: 'a', emoji: false })).toEqual({
      kind: 'plain',
      text: 'a',
      emoji: false,
    });
    expect(textObject({ type: 'plain_text', text: '   ' })).toBeNull();
    expect(textObject('text')).toBeNull();
    expect(textObject({ type: 'image', text: 'x' })).toBeNull();
  });

  it('turns plain text into text, breaks and emoji nodes', () => {
    expect(plainTextNodes('a :tada:\nb :+1::skin-tone-2:')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'emoji', name: 'tada', skinTone: null },
      { type: 'br' },
      { type: 'text', text: 'b ' },
      { type: 'emoji', name: '+1', skinTone: '2' },
    ]);
  });

  it('nests styles like Slack (code innermost) and splits code at line breaks', () => {
    expect(richInlineNodes([{ type: 'text', text: 'x', style: { bold: true, italic: true, code: true } }])).toEqual([
      {
        type: 'bold',
        children: [{ type: 'italic', children: [{ type: 'code', children: [{ type: 'text', text: 'x' }] }] }],
      },
    ]);
    expect(richInlineNodes([{ type: 'text', text: 'a\nb', style: { code: true } }])).toEqual([
      { type: 'code', children: [{ type: 'text', text: 'a' }] },
      { type: 'br' },
      { type: 'code', children: [{ type: 'text', text: 'b' }] },
    ]);
  });

  it('drops the line break Slack puts at the end of a section before a list', () => {
    expect(richBlockNodes([{ type: 'text', text: 'Plan:\n' }])).toEqual([{ type: 'text', text: 'Plan:' }]);
    expect(richInlineNodes([{ type: 'text', text: 'Plan:\n' }])).toEqual([
      { type: 'text', text: 'Plan:' },
      { type: 'br' },
    ]);
    const { container } = renderBlocks(richBlocks);
    const first = container.querySelector('.md-root') as HTMLElement;
    expect(first.querySelector('br')).toBeNull();
  });

  it('ignores malformed elements instead of trusting them', () => {
    expect(
      richInlineNodes([null, 'x', { type: 'user' }, { type: 'emoji', name: '' }, { type: 'broadcast', range: 'all' }]),
    ).toEqual([]);
    expect(richList({ type: 'rich_text_list', style: 'ordered', indent: -3, offset: 'x', elements: 'nope' })).toEqual({
      ordered: true,
      indent: 0,
      start: 1,
      items: [],
    });
    expect(listMarker({ ordered: true, indent: 4 })).toBe('lower-alpha');
    expect(listMarker({ ordered: false, indent: 2 })).toBe('square');
  });
});
