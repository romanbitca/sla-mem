import { format } from 'date-fns';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadEmojiMap } from '../emoji';
import { formatSlackDate, slackDateTitle } from './date';
import { emojiOnlyCount, isJumbo, JUMBO_EMOJI_MAX } from './jumbo';
import { parseMrkdwn } from './parse';
import { mrkdwnToPlainText } from './plain';
import type { EmojiNode } from './types';
import { safeHref, safeImageSrc, trimBareUrl, unescapeEntities } from './url';

beforeAll(() => loadEmojiMap());

describe('mrkdwnToPlainText', () => {
  const ctx = {
    userLabel: (id: string) => ({ U1: 'Roman' })[id],
    channelLabel: (id: string) => ({ C1: 'general' })[id],
  };

  it('strips formatting and resolves references', () => {
    expect(mrkdwnToPlainText('*Hi* <@U1>, see <#C1> :+1:', ctx)).toBe('Hi @Roman, see #general 👍');
  });

  it('falls back to inline labels and ids', () => {
    expect(mrkdwnToPlainText('<@U9|bob> <@U8> <#C9|random> <#C8>', ctx)).toBe('@bob @U8 #random #C8');
    expect(mrkdwnToPlainText('<@U1>')).toBe('@U1');
  });

  it('renders broadcasts, user groups and dates', () => {
    expect(mrkdwnToPlainText('<!here> <!channel> <!subteam^S1|@devs> <!subteam^S2|ops>')).toBe(
      '@here @channel @devs @ops',
    );
    expect(mrkdwnToPlainText('<!date^1392734382^{date_short}|Feb 18, 2014>')).toBe('Feb 18, 2014');
  });

  it('uses link labels and unescapes entities', () => {
    expect(mrkdwnToPlainText('<https://x.com|the site> &amp; <mailto:a@b.co>')).toBe('the site & a@b.co');
  });

  it('keeps code content and puts blocks on their own lines', () => {
    expect(mrkdwnToPlainText('run `*x*` then ```a\nb``` done')).toBe('run *x* then\na\nb\ndone');
    expect(mrkdwnToPlainText('&gt; quoted\nafter')).toBe('quoted\nafter');
  });

  it('keeps unknown shortcodes literal, with their tone', () => {
    expect(mrkdwnToPlainText('at 10:30:45 :partyparrot::skin-tone-2:')).toBe('at 10:30:45 :partyparrot::skin-tone-2:');
  });

  it('resolves skin tones and custom aliases to Unicode', () => {
    expect(
      mrkdwnToPlainText(':wave::skin-tone-3: :yes:', { customEmojiUrl: (n) => (n === 'yes' ? 'alias:+1' : undefined) }),
    ).toBe('👋🏼 👍');
  });

  it('trims surrounding whitespace', () => {
    expect(mrkdwnToPlainText('\n\n hi \n')).toBe('hi');
  });
});

describe('formatSlackDate', () => {
  const ts = 1392734382; // 2014-02-18T14:39:42Z
  const d = new Date(ts * 1000);

  it('expands every documented token in local time', () => {
    expect(formatSlackDate(ts, '{date_num}')).toBe(format(d, 'yyyy-MM-dd'));
    expect(formatSlackDate(ts, '{date_slash}')).toBe(format(d, 'MM/dd/yyyy'));
    expect(formatSlackDate(ts, '{date}')).toBe(format(d, 'MMMM do, yyyy'));
    expect(formatSlackDate(ts, '{date_short}')).toBe(format(d, 'MMM d, yyyy'));
    expect(formatSlackDate(ts, '{date_long}')).toBe(format(d, 'EEEE, MMMM do, yyyy'));
    expect(formatSlackDate(ts, '{time}')).toBe(format(d, 'h:mm a'));
    expect(formatSlackDate(ts, '{time_secs}')).toBe(format(d, 'h:mm:ss a'));
  });

  it('keeps surrounding text and unknown tokens', () => {
    expect(formatSlackDate(ts, 'Due {date_num} {nope}')).toBe(`Due ${format(d, 'yyyy-MM-dd')} {nope}`);
  });

  it('uses today / yesterday / tomorrow for pretty tokens', () => {
    const now = new Date(d);
    expect(formatSlackDate(ts, '{date_pretty}', now)).toBe('today');
    expect(formatSlackDate(ts - 86400, '{date_short_pretty}', now)).toBe('yesterday');
    expect(formatSlackDate(ts + 86400, '{date_long_pretty}', now)).toBe('tomorrow');
    expect(formatSlackDate(ts, '{day_divider_pretty}', now)).toBe('Today');
    const later = new Date((ts + 30 * 86400) * 1000);
    expect(formatSlackDate(ts, '{date_pretty}', later)).toBe(format(d, 'MMMM do, yyyy'));
  });

  it('formats {ago} relative to now', () => {
    const now = new Date((ts + 3 * 3600) * 1000);
    expect(formatSlackDate(ts, '{ago}', now)).toBe('about 3 hours ago');
  });

  it('builds a tooltip even for an empty template', () => {
    expect(slackDateTitle(ts, '')).toBe(format(d, "EEEE, MMMM do, yyyy 'at' h:mm a"));
    expect(formatSlackDate(Number.NaN, '{date}')).toBe('');
  });
});

describe('safeHref', () => {
  it('allows http, https and mailto', () => {
    expect(safeHref('https://x.com/a?b=1')).toBe('https://x.com/a?b=1');
    expect(safeHref('HTTP://X.COM')).toBe('http://x.com/');
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(safeHref('  https://x.com  ')).toBe('https://x.com/');
  });

  it('rejects everything else', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      '//evil.com',
      '/relative',
      'https://',
      '',
      null,
      undefined,
    ]) {
      expect(safeHref(bad), String(bad)).toBeNull();
    }
  });
});

describe('safeImageSrc (custom emoji)', () => {
  it('allows Slack’s emoji CDN, proxied web images and raster data images only', () => {
    expect(safeImageSrc('https://emoji.slack-edge.com/T1/party/abc.gif')).toBe(
      'https://emoji.slack-edge.com/T1/party/abc.gif',
    );
    expect(safeImageSrc('https://example.com/party.gif')).toBe(
      `https://slack-imgs.com/?c=1&o1=ro&url=${encodeURIComponent('https://example.com/party.gif')}`,
    );
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeImageSrc('data:image/svg+xml;base64,AAAA')).toBeNull();
    expect(safeImageSrc('javascript:alert(1)')).toBeNull();
    expect(safeImageSrc('/api/emoji/party')).toBeNull();
    expect(safeImageSrc('//evil.com/x.png')).toBeNull();
  });
});

describe('url helpers', () => {
  it('unescapes the three Slack entities exactly once', () => {
    expect(unescapeEntities('&amp;amp; &lt;&gt;')).toBe('&amp; <>');
  });

  it('trims trailing punctuation from bare URLs', () => {
    const trim = (u: string) => u.slice(0, trimBareUrl(u));
    expect(trim('https://x.com/a.')).toBe('https://x.com/a');
    expect(trim('https://x.com/a),')).toBe('https://x.com/a');
    expect(trim('https://x.com/a_(b)')).toBe('https://x.com/a_(b)');
    expect(trim('https://x.com/[x]]')).toBe('https://x.com/[x]');
    expect(trim('https://x.com/?a&amp;')).toBe('https://x.com/?a');
    expect(trim('https://x.com/&gt;more')).toBe('https://x.com/');
  });
});

describe('jumbomoji detection', () => {
  const known = (n: EmojiNode) => n.name !== 'unknown';
  const count = (text: string) => emojiOnlyCount(parseMrkdwn(text), known);

  it('counts emoji-only messages, ignoring whitespace and line breaks', () => {
    expect(count(':smile:')).toBe(1);
    expect(count(':smile: :tada:\n:+1::skin-tone-2:')).toBe(3);
    expect(count('😀 🎉')).toBe(2);
    expect(count('👨‍👩‍👧 🇺🇸')).toBe(2);
  });

  it('rejects any other content', () => {
    expect(count('hi :smile:')).toBe(0);
    expect(count(':smile: *x*')).toBe(0);
    expect(count(':unknown:')).toBe(0);
    expect(count('123')).toBe(0);
    expect(count('')).toBe(0);
    expect(count('`:smile:`')).toBe(0);
  });

  it('caps jumbo at 23 emoji', () => {
    expect(isJumbo(parseMrkdwn(':a: '.repeat(JUMBO_EMOJI_MAX)), known)).toBe(true);
    expect(isJumbo(parseMrkdwn(':a: '.repeat(JUMBO_EMOJI_MAX + 1)), known)).toBe(false);
  });
});
