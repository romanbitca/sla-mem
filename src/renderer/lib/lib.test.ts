// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { MessageDTO, MessagesPage } from '../../shared/types';
import { makeMessage } from '../test/helpers';
import { formatBytes, formatCount, formatDayLabel, formatShortDate, formatTsRange, joinNames } from './format';
import { authorKey, dedupeMessages, groupByDay, guessThreadParent, isContinuation } from './grouping';
import { messagePath, slackPermalink } from './links';
import { getNewerParam, getOlderParam } from './queries';
import { remoteImageSrc, slackProxyUrl } from './remoteImage';
import { attachmentColor, safeHref } from './safeUrl';
import { workspaceHost, workspaceSlug } from './workspaceName';
import { compareTs, isValidTs, parseLocalDate, parseTsParam, toLocalDateInput, tsJustBefore, tsToMs } from './ts';

describe('ts helpers', () => {
  it('validates and parses ts params', () => {
    expect(isValidTs('1700000000.000100')).toBe(true);
    expect(isValidTs('1700000000')).toBe(false);
    expect(parseTsParam('<script>')).toBeNull();
    expect(parseTsParam(null)).toBeNull();
  });

  it('compares timestamps exactly, beyond double precision', () => {
    expect(compareTs('1712345678.123456', '1712345678.123457')).toBeLessThan(0);
    expect(compareTs('1712345678.5', '1712345678.400000')).toBeGreaterThan(0);
    expect(compareTs('999999999.9', '1000000000.0')).toBeLessThan(0);
    expect(compareTs('1700000000.000100', '1700000000.0001')).toBe(0);
  });

  it('converts to ms and builds an inclusive lower bound for a date', () => {
    expect(tsToMs('1700000000.123456')).toBe(1_700_000_000_123);
    const midnight = new Date(2024, 2, 4);
    const ts = tsJustBefore(midnight);
    expect(isValidTs(ts)).toBe(true);
    expect(compareTs(ts, `${midnight.getTime() / 1000}.000000`)).toBeLessThan(0);
    expect(compareTs(ts, `${midnight.getTime() / 1000 - 1}.999998`)).toBeGreaterThan(0);
  });

  it('round-trips date input values in local time', () => {
    const date = parseLocalDate('2024-03-04')!;
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(4);
    expect(date.getHours()).toBe(0);
    expect(toLocalDateInput(date)).toBe('2024-03-04');
    expect(parseLocalDate('03/04/2024')).toBeNull();
  });
});

describe('grouping', () => {
  const base = new Date(2024, 2, 4, 10, 0, 0).getTime() / 1000;
  const at = (secs: number, extra: Partial<MessageDTO> = {}) => makeMessage({ ...extra, ts: `${base + secs}.000000` });

  it('continues same-author messages within five minutes on the same day', () => {
    expect(isContinuation(at(0), at(60))).toBe(true);
    expect(isContinuation(at(0), at(301))).toBe(false);
    expect(isContinuation(at(0), at(60, { userId: 'U2' }))).toBe(false);
    expect(isContinuation(undefined, at(0))).toBe(false);
  });

  it('never continues system events or broadcast replies', () => {
    expect(isContinuation(at(0), at(10, { subtype: 'channel_join' }))).toBe(false);
    expect(isContinuation(at(0), at(10, { subtype: 'thread_broadcast' }))).toBe(false);
  });

  it('distinguishes bots posting under different names', () => {
    const a = at(0, { userId: null, botId: 'B1', username: 'CI' });
    const b = at(10, { userId: null, botId: 'B1', username: 'Deploys' });
    expect(authorKey(a)).not.toBe(authorKey(b));
    expect(isContinuation(a, b)).toBe(false);
  });

  it('splits messages into local days and restarts grouping each day', () => {
    const lateNight = new Date(2024, 2, 4, 23, 58).getTime() / 1000;
    const msgs = [
      makeMessage({ ts: `${lateNight}.000000` }),
      makeMessage({ ts: `${lateNight + 60}.000000` }),
      makeMessage({ ts: `${lateNight + 180}.000000` }), // 00:01 next day
    ];
    const days = groupByDay(msgs);
    expect(days).toHaveLength(2);
    expect(days[0].rows.map((r) => r.continuation)).toEqual([false, true]);
    expect(days[1].rows.map((r) => r.continuation)).toEqual([false]);
    expect(days[1].date.getDate()).toBe(5);
    expect(days[1].date.getHours()).toBe(0);
  });

  it('finds the nearest earlier parent whose thread spans a reply', () => {
    const parentA = at(0, { replyCount: 2, latestReply: `${base + 500}.000000` });
    const parentB = at(100, { replyCount: 1, latestReply: `${base + 150}.000000` });
    const plain = at(200);
    const msgs = [parentA, parentB, plain];
    expect(guessThreadParent(msgs, `${base + 120}.000000`)).toBe(parentB);
    expect(guessThreadParent(msgs, `${base + 400}.000000`)).toBe(parentA);
    expect(guessThreadParent(msgs, `${base + 900}.000000`)).toBeNull();
  });

  it('dedupes overlapping pages', () => {
    const a = at(0);
    const b = at(1);
    const c = at(2);
    expect(
      dedupeMessages([
        [a, b],
        [b, c],
      ]),
    ).toEqual([a, b, c]);
  });
});

describe('page params', () => {
  const page = (overrides: Partial<MessagesPage>): MessagesPage => ({
    messages: [makeMessage({ ts: '1700000000.000001' }), makeMessage({ ts: '1700000600.000001' })],
    hasMoreBefore: true,
    hasMoreAfter: true,
    ...overrides,
  });

  it('pages older from the first message and newer from the last', () => {
    expect(getOlderParam(page({}))).toEqual({ before: '1700000000.000001' });
    expect(getNewerParam(page({}))).toEqual({ after: '1700000600.000001' });
  });

  it('stops at the ends and on empty pages', () => {
    expect(getOlderParam(page({ hasMoreBefore: false }))).toBeUndefined();
    expect(getNewerParam(page({ hasMoreAfter: false }))).toBeUndefined();
    expect(getOlderParam(page({ messages: [] }))).toBeUndefined();
  });
});

describe('format', () => {
  it('formats sizes and counts compactly', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatBytes(null)).toBe('');
    expect(formatCount(950)).toBe('950');
    expect(formatCount(1234)).toBe('1.2k');
    expect(formatCount(25_000)).toBe('25k');
    expect(formatCount(1_500_000)).toBe('1.5M');
  });

  it('joins names like a person would', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(joinNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 others');
  });

  it('labels days relative to now', () => {
    const now = new Date(2026, 8, 21, 12);
    expect(formatDayLabel(new Date(2026, 8, 21, 1), now)).toBe('Today');
    expect(formatDayLabel(new Date(2026, 8, 20, 23), now)).toBe('Yesterday');
    expect(formatDayLabel(new Date(2026, 2, 4), now)).toBe('Wednesday, March 4th');
    expect(formatDayLabel(new Date(2024, 2, 4), now)).toBe('Monday, March 4th, 2024');
    expect(formatShortDate(new Date(2025, 0, 2), now)).toBe('Jan 2, 2025');
  });

  it('describes a covered range', () => {
    expect(formatTsRange(null, '1700000000.0')).toBeNull();
    expect(formatTsRange('1700000000.0', '1700000000.0')).toMatch(/^Nov 1[45], 2023$/);
  });
});

describe('links and url safety', () => {
  it('builds message deep links', () => {
    expect(messagePath({ conversationId: 'C1', ts: '1.1', threadTs: null, isReply: false })).toBe('/c/C1?ts=1.1');
    expect(messagePath({ conversationId: 'C1', ts: '2.2', threadTs: '1.1', isReply: true })).toBe(
      '/c/C1?thread=1.1&ts=2.2',
    );
  });

  it('builds Slack permalinks, with thread_ts and cid for replies', () => {
    const top = { conversationId: 'C0123', ts: '1712345678.123456', threadTs: null, isReply: false };
    expect(slackPermalink('9h', top)).toBe('https://9h.slack.com/archives/C0123/p1712345678123456');
    expect(slackPermalink('9h.slack.com', top)).toBe('https://9h.slack.com/archives/C0123/p1712345678123456');
    const reply = { conversationId: 'C0123', ts: '1712345699.000200', threadTs: '1712345678.123456', isReply: true };
    expect(slackPermalink('9h', reply)).toBe(
      'https://9h.slack.com/archives/C0123/p1712345699000200?thread_ts=1712345678.123456&cid=C0123',
    );
    // A thread parent links to itself, like Slack's own "Copy link".
    const parent = { ...top, threadTs: top.ts };
    expect(slackPermalink('9h', parent)).toBe('https://9h.slack.com/archives/C0123/p1712345678123456');
    // Short fractions are padded to Slack's six digits.
    expect(slackPermalink('9h', { ...top, ts: '1712345678.5' })).toMatch(/\/p1712345678500000$/);
  });

  it('has no permalink without a workspace address or with malformed ids', () => {
    const top = { conversationId: 'C0123', ts: '1712345678.123456', threadTs: null, isReply: false };
    expect(slackPermalink(null, top)).toBeNull();
    expect(slackPermalink('', top)).toBeNull();
    expect(slackPermalink('9h', { ...top, ts: 'nope' })).toBeNull();
    expect(slackPermalink('9h', { ...top, conversationId: '../C1' })).toBeNull();
  });

  it('only allows http(s)/mailto links', () => {
    expect(safeHref('https://x.test')).toBe('https://x.test/');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref(' JaVaScRiPt:alert(1)')).toBeUndefined();
    expect(safeHref('file:///etc/passwd')).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
  });

  it('maps attachment colors', () => {
    expect(attachmentColor('good')).toBe('#2eb67d');
    expect(attachmentColor('36a64f')).toBe('#36a64f');
    expect(attachmentColor('#abc')).toBe('#abc');
    expect(attachmentColor('red; background: url(x)')).toBeUndefined();
  });
});

describe('remoteImageSrc', () => {
  it('passes the archive’s own files and raster data images through', () => {
    expect(remoteImageSrc('archive://file/F1')).toBe('archive://file/F1');
    expect(remoteImageSrc('archive://thumb/F1')).toBe('archive://thumb/F1');
    expect(remoteImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(remoteImageSrc('data:image/jpeg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA');
    expect(remoteImageSrc('data:image/webp;base64,AAAA')).toBe('data:image/webp;base64,AAAA');
  });

  it('loads Slack’s own image hosts directly (what the CSP allows)', () => {
    for (const url of [
      'https://emoji.slack-edge.com/T1/party/abc.gif',
      'https://avatars.slack-edge.com/2024-01-01/1_abc_72.jpg',
      'https://files.slack.com/files-tmb/T1-F1-abc/shot_360.png',
      'https://slack-imgs.com/?c=1&o1=ro&url=https%3A%2F%2Fexample.com%2Fa.png',
    ]) {
      expect(remoteImageSrc(url), url).toBe(url);
    }
  });

  it('routes every other web image through Slack’s image proxy', () => {
    const url = 'https://opengraph.githubassets.com/abc/brightwave/app/pull/1';
    expect(remoteImageSrc(url)).toBe(`https://slack-imgs.com/?c=1&o1=ro&url=${encodeURIComponent(url)}`);
    expect(slackProxyUrl(url)).toBe(remoteImageSrc(url));
    // Lookalike hosts, plain http, other ports and the bare apex are not Slack's CDN either.
    for (const other of [
      'https://slack-edge.com.evil.test/x.png',
      'https://evilslack.com/x.png',
      'http://a.slack-edge.com/x.png',
      'https://a.slack-edge.com:8443/x.png',
      'https://slack-edge.com/x.png',
      'https://secure.gravatar.com/avatar/abc?s=72',
    ]) {
      expect(remoteImageSrc(other), other).toMatch(/^https:\/\/slack-imgs\.com\/\?c=1&o1=ro&url=/);
    }
  });

  it('gives no image for anything else', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:image/svg+xml;base64,AAAA',
      'data:text/html,<script>alert(1)</script>',
      '/api/files/F1',
      '//evil.com/x.png',
      'file:///etc/passwd',
      'ftp://x.test/a.png',
      '',
      null,
      undefined,
    ]) {
      expect(remoteImageSrc(bad), String(bad)).toBeNull();
    }
  });
});

describe('workspace names', () => {
  it('accepts a subdomain, a host or a URL', () => {
    expect(workspaceHost('9h')).toBe('9h.slack.com');
    expect(workspaceHost('9H.slack.com')).toBe('9h.slack.com');
    expect(workspaceHost('https://9h.slack.com/archives/C1')).toBe('9h.slack.com');
    expect(workspaceHost('  ')).toBeNull();
    expect(workspaceHost(null)).toBeNull();
    expect(workspaceSlug('9h.slack.com')).toBe('9h');
    expect(workspaceSlug('9hdigital')).toBe('9hdigital');
    expect(workspaceSlug(undefined)).toBeNull();
  });
});
