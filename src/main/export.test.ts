import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConversation, upsertMessages, type DB } from './db';
import { msg, seededDb, tsAt } from './db/test-helpers';
import { exportConversationMarkdown, exportFileName, mrkdwnToMarkdown } from './export';

const resolvers = {
  userLabel: (id: string) => ({ U1: 'Ali', U2: 'Bob Brown' })[id],
  channelName: (id: string) => ({ C1: 'general' })[id],
};

describe('mrkdwnToMarkdown', () => {
  it('turns Slack formatting into Markdown and leaves words with markers inside alone', () => {
    expect(mrkdwnToMarkdown('*bold* _italic_ ~gone~ snake_case_name 2*3*4', resolvers)).toBe(
      '**bold** _italic_ ~~gone~~ snake_case_name 2*3*4',
    );
  });

  it('resolves mentions and channels, and writes links as Markdown links', () => {
    expect(
      mrkdwnToMarkdown(
        '<@U2> in <#C1> <#C9|old-name> <!here> <https://x.io|docs> <https://y.io> <mailto:a@b.c|mail>',
        resolvers,
      ),
    ).toBe('@Bob Brown in #general #old-name @here [docs](https://x.io) <https://y.io> [mail](mailto:a@b.c)');
  });

  it('keeps code verbatim, puts block code on fenced lines, and unescapes entities once', () => {
    expect(mrkdwnToMarkdown('run `a *b* c` then ```x &lt; y\n*z*``` done &amp;lt;', resolvers)).toBe(
      'run `a *b* c` then\n\n```\nx < y\n*z*\n```\n\ndone &lt;',
    );
  });

  it('keeps Slack line breaks as Markdown hard breaks, and paragraphs as paragraphs', () => {
    expect(mrkdwnToMarkdown('one\ntwo\n\nthree\n&gt; quoted', resolvers)).toBe('one  \ntwo\n\nthree  \n> quoted');
  });
});

describe('exportConversationMarkdown', () => {
  let dir: string;
  let db: DB;
  const now = new Date('2026-09-21T12:00:00Z');
  const opts = { locale: 'en-GB', timeZone: 'UTC', now };
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...o });
  const DAY = fmt({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const DATE = fmt({ year: 'numeric', month: 'long', day: 'numeric' });
  const at = (ts: string) => new Date(Number(ts) * 1000);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-export-'));
    db = seededDb();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(conversationId = 'C1', extra: Parameters<typeof exportConversationMarkdown>[3] = {}) {
    const file = path.join(dir, 'out.md');
    return exportConversationMarkdown(db, conversationId, file, { ...opts, ...extra }).then((r) => ({
      ...r,
      text: fs.readFileSync(file, 'utf8'),
    }));
  }

  it('writes day headings, authors, threads, edits, deletions, files and reactions', async () => {
    const parent = tsAt(1);
    upsertMessages(
      db,
      'C1',
      [
        msg(tsAt(0), 'Hello <@U2>, see <https://x.io|the docs> and *this*', {
          reactions: [{ name: 'tada', count: 2, users: ['U2', 'U3'] }],
        }),
        msg(parent, 'Thread start', { user: 'U2', thread_ts: parent, reply_count: 2, latest_reply: tsAt(125) }),
        msg(tsAt(2), 'first reply', { thread_ts: parent }),
        msg(tsAt(125), 'late reply\nsecond line', { user: 'U3', thread_ts: parent }),
        msg(tsAt(130), 'Deployed ```npm run build``` ok', { user: undefined, bot_id: 'B9', username: 'Deploy Bot' }),
        msg(tsAt(131), 'fixed typo', {
          edited: { user: 'U1', ts: tsAt(132) },
          files: [
            { id: 'F1', name: 'report.pdf', mimetype: 'application/pdf', url_private: 'https://files.slack.com/x' },
          ],
        }),
        msg(tsAt(133), 'secret plan'),
        msg(tsAt(140), 'orphan reply', { user: 'U2', thread_ts: tsAt(100) }),
      ],
      'api',
    );
    upsertMessages(
      db,
      'C1',
      [{ type: 'message', subtype: 'tombstone', ts: tsAt(133), text: 'This message was deleted.' }],
      'api',
    );

    const result = await run();
    const day1 = DAY.format(at(tsAt(0)));
    const day2 = DAY.format(at(tsAt(130)));
    expect(result.messages).toBe(8);
    expect(result.text).toBe(
      [
        '# #general',
        '',
        `Exported from Slack Archive on ${DATE.format(now)} · ${DATE.format(at(tsAt(0)))} – ${DATE.format(at(tsAt(140)))}`,
        '',
        '> **Topic:** Company-wide',
        '>',
        '> **Purpose:** All hands',
        '',
        `## ${day1}`,
        '',
        '**Ali** · 22:13',
        '',
        'Hello @Bob Brown, see [the docs](https://x.io) and **this**',
        '',
        'Reactions: :tada: 2',
        '',
        '**Bob Brown** · 22:14',
        '',
        'Thread start',
        '',
        '> **Thread: 2 replies**',
        '>',
        '> **Ali** · 22:15',
        '>',
        '> first reply',
        '>',
        `> **Annabel Lee** · ${DATE.format(at(tsAt(125)))}, 00:18`,
        '>',
        '> late reply  ',
        '> second line',
        '',
        `## ${day2}`,
        '',
        '**Deploy Bot** · 00:23',
        '',
        'Deployed',
        '',
        '```',
        'npm run build',
        '```',
        '',
        'ok',
        '',
        '**Ali** · 00:24 · _edited_',
        '',
        'fixed typo',
        '',
        '📎 report.pdf (not archived)',
        '',
        '**Ali** · 00:26 · _deleted in Slack_',
        '',
        'secret plan',
        '',
        '---',
        '',
        '## Replies to threads that aren’t in the archive',
        '',
        '> **Thread: 1 reply**',
        '>',
        `> **Bob Brown** · ${DATE.format(at(tsAt(140)))}, 00:33`,
        '>',
        '> orphan reply',
        '',
      ].join('\n'),
    );
  });

  it('shows a reply sent to the channel in both places, as Slack does, and counts it once', async () => {
    const parent = tsAt(0);
    upsertMessages(
      db,
      'C1',
      [
        msg(parent, 'question', { thread_ts: parent, reply_count: 1, latest_reply: tsAt(1) }),
        msg(tsAt(1), 'answer for everyone', { user: 'U2', thread_ts: parent, subtype: 'thread_broadcast' }),
      ],
      'api',
    );
    const { text, messages } = await run();
    expect(messages).toBe(2);
    expect(text).toContain('_Replied to a thread:_ answer for everyone');
    expect(text).toContain('> answer for everyone');
  });

  it('writes an empty conversation with a note instead of nothing', async () => {
    const { text, messages } = await run('C2');
    expect(messages).toBe(0);
    expect(text).toContain('# #random');
    expect(text).toContain('_No messages archived yet._');
  });

  it('names direct messages after the person and makes file names safe', () => {
    expect(exportFileName(getConversation(db, 'C1')!)).toBe('#general (Slack).md');
    expect(exportFileName(getConversation(db, 'D1')!)).toBe('Ali (Slack).md');
    expect(exportFileName({ ...getConversation(db, 'C1')!, label: 'a/b:c?' })).toBe('#a_b_c_ (Slack).md');
  });

  it('leaves no file behind when cancelled, and refuses unknown conversations', async () => {
    upsertMessages(db, 'C1', [msg(tsAt(0), 'hello')], 'api');
    const controller = new AbortController();
    controller.abort();
    await expect(run('C1', { signal: controller.signal })).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
    await expect(run('C404')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('pages through long conversations in order', async () => {
    upsertMessages(
      db,
      'C1',
      Array.from({ length: 450 }, (_, i) => msg(tsAt(i), `message ${i}`)),
      'api',
    );
    const { text, messages } = await run();
    expect(messages).toBe(450);
    const order = [...text.matchAll(/^message (\d+)$/gm)].map((m) => Number(m[1]));
    expect(order).toEqual(Array.from({ length: 450 }, (_, i) => i));
  });
});
