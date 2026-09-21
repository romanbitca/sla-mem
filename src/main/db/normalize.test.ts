import { describe, expect, it } from 'vitest';
import type { SlackMessage } from '../slack/types';
import {
  displayTextFromMessage,
  mrkdwnToPlain,
  normalizeForSearch,
  unescapeEntities,
  type NormalizeResolvers,
} from './normalize';

const r: NormalizeResolvers = {
  userLabel: (id) => ({ U1: 'Alice', U2: 'Bob' })[id],
  channelName: (id) => ({ C1: 'general' })[id],
};

const plain = (text: string) => mrkdwnToPlain(text, r);
const m = (extra: Partial<SlackMessage>): SlackMessage => ({ ts: '1700000000.000100', ...extra });

describe('mrkdwnToPlain', () => {
  it('resolves user mentions to labels, falling back to the inline label or id', () => {
    expect(plain('hi <@U1> and <@U2|bobby>')).toBe('hi @Alice and @Bob');
    expect(plain('<@U9|ghost> <@U8>')).toBe('@ghost @U8');
  });

  it('resolves channel references', () => {
    expect(plain('see <#C1|old-name> and <#C1>')).toBe('see #general and #general');
    expect(plain('<#C9|elsewhere> <#C8>')).toBe('#elsewhere #C8');
  });

  it('handles special mentions, subteams and dates', () => {
    expect(plain('<!here> <!channel> <!everyone>')).toBe('@here @channel @everyone');
    expect(plain('<!here|here>')).toBe('@here');
    expect(plain('<!subteam^S123|@devs> ping')).toBe('@devs ping');
    expect(plain('due <!date^1392734382^{date_short}|Feb 18, 2014>')).toBe('due Feb 18, 2014');
  });

  it('turns links into "label url" or the bare url', () => {
    expect(plain('<https://example.com/a|the docs>')).toBe('the docs https://example.com/a');
    expect(plain('<https://example.com>')).toBe('https://example.com');
    expect(plain('<mailto:a@b.co|mail me>')).toBe('mail me mailto:a@b.co');
  });

  it('unescapes entities exactly once, after resolving references', () => {
    expect(plain('a &lt;b&gt; &amp; c &amp;lt;')).toBe('a <b> & c &lt;');
    expect(unescapeEntities('&amp;amp;')).toBe('&amp;');
  });

  it('strips formatting markers that wrap words but keeps intra-word ones', () => {
    expect(plain('*bold* _italic_ ~strike~')).toBe('bold italic strike');
    expect(plain('*_nested_*, ok')).toBe('nested, ok');
    expect(plain('snake_case_word 2*3*4 a * b * c')).toBe('snake_case_word 2*3*4 a * b * c');
    expect(plain('`code` and ```block\nx```')).toBe('code and \nblock\nx\n');
  });

  it('keeps :emoji: names as words', () => {
    expect(plain('ship it :rocket: :+1::skin-tone-2:')).toBe('ship it :rocket: :+1::skin-tone-2:');
  });
});

describe('normalizeForSearch', () => {
  it('adds attachment and file text, de-duplicated', () => {
    const text = normalizeForSearch(
      m({
        text: 'look <https://x.io|here>',
        attachments: [
          {
            title: 'X Title',
            text: 'Attachment *body*',
            fallback: 'Attachment *body*',
            pretext: 'pre',
            fields: [{ title: 'Field', value: 'Value' }],
            from_url: 'https://x.io',
          },
        ],
        files: [{ id: 'F1', name: 'report.pdf', title: 'Quarterly report' }],
      }),
      r,
    );
    expect(text.split('\n')).toEqual([
      'look here https://x.io',
      'pre',
      'X Title',
      'Attachment body',
      'Field',
      'Value',
      'https://x.io',
      'report.pdf',
      'Quarterly report',
    ]);
  });

  it('indexes layout blocks even when text holds only the notification fallback (pitfall 15)', () => {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: 'from *blocks*' } }];
    expect(normalizeForSearch(m({ text: '', blocks }), r)).toBe('from blocks');
    expect(normalizeForSearch(m({ text: 'from text', blocks }), r)).toBe('from text\nfrom blocks');
  });

  it('uses rich_text blocks only when text is empty (they mirror the text)', () => {
    const rich = [
      {
        type: 'rich_text',
        elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'same words' }] }],
      },
    ];
    expect(normalizeForSearch(m({ text: 'same words', blocks: rich }), r)).toBe('same words');
    expect(normalizeForSearch(m({ text: '', blocks: rich }), r)).toBe('same words');
  });

  it('indexes header, fields, image titles and blocks inside attachments', () => {
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Weekly report' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: '*Owner*' },
          { type: 'plain_text', text: 'Priya' },
        ],
      },
      { type: 'image', image_url: 'https://x/y.png', alt_text: 'burndown chart' },
    ];
    const out = normalizeForSearch(
      m({
        text: 'fallback',
        blocks,
        attachments: [{ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'inside attachment' } }] }],
      }),
      r,
    );
    expect(out).toContain('Weekly report');
    expect(out).toContain('Priya');
    expect(out).toContain('burndown chart');
    expect(out).toContain('inside attachment');
  });

  it('removes snippet highlight control characters from content', () => {
    expect(normalizeForSearch(m({ text: 'a\u0002b\u0003c' }), r)).toBe('abc');
  });
});

describe('displayTextFromMessage', () => {
  it('returns text when present', () => {
    expect(displayTextFromMessage(m({ text: 'hello *there*' }))).toBe('hello *there*');
  });

  it('derives mrkdwn from rich_text blocks', () => {
    const blocks = [
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Hi ' },
              { type: 'user', user_id: 'U1' },
              { type: 'text', text: ' see ', style: {} },
              { type: 'link', url: 'https://a.b', text: 'this' },
              { type: 'text', text: ' now ', style: { bold: true } },
              { type: 'emoji', name: 'tada' },
              { type: 'text', text: ' 1 < 2 & 3' },
            ],
          },
          {
            type: 'rich_text_list',
            style: 'bullet',
            elements: [
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'one' }] },
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'two', style: { code: true } }] },
            ],
          },
          {
            type: 'rich_text_list',
            style: 'ordered',
            elements: [{ type: 'rich_text_section', elements: [{ type: 'channel', channel_id: 'C1' }] }],
          },
          { type: 'rich_text_quote', elements: [{ type: 'text', text: 'quoted' }] },
          { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'x = *y*' }] },
        ],
      },
    ];
    expect(displayTextFromMessage(m({ text: '', blocks }))).toBe(
      [
        'Hi <@U1> see <https://a.b|this> *now* :tada: 1 &lt; 2 &amp; 3',
        '• one',
        '• `two`',
        '1. <#C1>',
        '> quoted',
        '```\nx = *y*\n```',
      ].join('\n'),
    );
  });

  it('derives mrkdwn from section, context and header blocks', () => {
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Deploy <done>' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*prod* ok' }, fields: [{ type: 'mrkdwn', text: 'a' }] },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: 'by bot' },
          { type: 'image', image_url: 'x' },
        ],
      },
      { type: 'divider' },
    ];
    expect(displayTextFromMessage(m({ text: '', blocks }))).toBe('*Deploy &lt;done&gt;*\n*prod* ok\na\nby bot');
  });

  it('falls back to attachment fallbacks', () => {
    expect(
      displayTextFromMessage(m({ text: '', attachments: [{ fallback: 'Build #12 passed' }, { fallback: 'second' }] })),
    ).toBe('Build #12 passed\nsecond');
    expect(displayTextFromMessage(m({}))).toBe('');
  });
});
