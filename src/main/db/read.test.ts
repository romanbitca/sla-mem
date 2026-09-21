import { describe, expect, it } from 'vitest';
import { getWorkspaceMeta, setMeta } from './meta';
import {
  getConversation,
  getMessageRevisions,
  getMessages,
  getStats,
  getThread,
  listConversations,
  listUsers,
  normalizeTs,
} from './read';
import { BASE_SECONDS, memDb, msg, seededDb, tsAt } from './test-helpers';
import type { DB } from './types';
import { markFileDownloaded, upsertConversations, upsertMessages } from './write';

/**
 * Conversation C1: top-level messages at minutes 1..10; minute 3 is a thread parent with plain
 * replies at 3.1/3.2 (minutes 31, 32) and a broadcast reply at minute 33.
 */
function threadedDb(): DB {
  const db = seededDb();
  const tops = Array.from({ length: 10 }, (_, i) => msg(tsAt(i + 1), `top ${i + 1}`));
  tops[2] = msg(tsAt(3), 'parent', { thread_ts: tsAt(3), reply_count: 3, latest_reply: tsAt(33) });
  upsertMessages(
    db,
    'C1',
    [
      ...tops,
      msg(tsAt(31), 'reply one', { thread_ts: tsAt(3), user: 'U2' }),
      msg(tsAt(32), 'reply two', { thread_ts: tsAt(3) }),
      msg(tsAt(33), 'broadcast reply', { thread_ts: tsAt(3), subtype: 'thread_broadcast' }),
    ],
    'api',
  );
  return db;
}

const minutes = (page: { messages: { ts: string }[] }) =>
  page.messages.map((m) => (Number(m.ts.split('.')[0]) - BASE_SECONDS) / 60);

describe('getMessages', () => {
  it('returns the latest page of top-level messages (broadcasts included, replies not)', () => {
    const db = threadedDb();
    const page = getMessages(db, { conversationId: 'C1', limit: 4 });
    expect(minutes(page)).toEqual([8, 9, 10, 33]);
    expect(page).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false });
    const all = getMessages(db, { conversationId: 'C1' });
    expect(minutes(all)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 33]);
    expect(all).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false });
  });

  it('pages before a ts with exact hasMore flags', () => {
    const db = threadedDb();
    const p1 = getMessages(db, { conversationId: 'C1', before: tsAt(9), limit: 4 });
    expect(minutes(p1)).toEqual([5, 6, 7, 8]);
    expect(p1).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
    const p2 = getMessages(db, { conversationId: 'C1', before: tsAt(5), limit: 4 });
    expect(minutes(p2)).toEqual([1, 2, 3, 4]);
    expect(p2).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true }); // exactly 4 left: no more
    const p3 = getMessages(db, { conversationId: 'C1', before: tsAt(1), limit: 4 });
    expect(p3).toMatchObject({ messages: [], hasMoreBefore: false, hasMoreAfter: true });
  });

  it('pages after a ts with exact hasMore flags', () => {
    const db = threadedDb();
    const p1 = getMessages(db, { conversationId: 'C1', after: tsAt(2), limit: 4 });
    expect(minutes(p1)).toEqual([3, 4, 5, 6]);
    expect(p1).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
    const p2 = getMessages(db, { conversationId: 'C1', after: tsAt(8), limit: 3 });
    expect(minutes(p2)).toEqual([9, 10, 33]);
    expect(p2).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false });
    const p3 = getMessages(db, { conversationId: 'C1', after: tsAt(33), limit: 3 });
    expect(p3).toMatchObject({ messages: [], hasMoreBefore: true, hasMoreAfter: false });
  });

  it('centers around a ts, including it', () => {
    const db = threadedDb();
    const p = getMessages(db, { conversationId: 'C1', around: tsAt(6), limit: 4 });
    expect(minutes(p)).toEqual([4, 5, 6, 7]);
    expect(p).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });
  });

  it('fills the page from the other side near either end', () => {
    const db = threadedDb();
    const start = getMessages(db, { conversationId: 'C1', around: tsAt(1), limit: 4 });
    expect(minutes(start)).toEqual([1, 2, 3, 4]);
    expect(start).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true });
    const end = getMessages(db, { conversationId: 'C1', around: tsAt(33), limit: 4 });
    expect(minutes(end)).toEqual([8, 9, 10, 33]);
    expect(end).toMatchObject({ hasMoreBefore: true, hasMoreAfter: false });
    const everything = getMessages(db, { conversationId: 'C1', around: tsAt(5), limit: 50 });
    expect(everything.messages).toHaveLength(11);
    expect(everything).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false });
  });

  it('centers on the thread parent when around is a plain reply, but on a broadcast itself', () => {
    const db = threadedDb();
    const onReply = getMessages(db, { conversationId: 'C1', around: tsAt(31), limit: 3 });
    expect(minutes(onReply)).toEqual([2, 3, 4]);
    const onBroadcast = getMessages(db, { conversationId: 'C1', around: tsAt(33), limit: 3 });
    expect(minutes(onBroadcast)).toEqual([9, 10, 33]);
  });

  it('centers on a ts that is not stored', () => {
    const db = threadedDb();
    const p = getMessages(db, { conversationId: 'C1', around: `${BASE_SECONDS + 5 * 60 + 30}.000000`, limit: 2 });
    expect(minutes(p)).toEqual([5, 6]);
  });

  it('accepts ts values without 6 fractional digits', () => {
    const db = threadedDb();
    expect(normalizeTs('1700000060')).toBe('1700000060.000000');
    expect(normalizeTs('1700000060.5')).toBe('1700000060.500000');
    const p = getMessages(db, { conversationId: 'C1', before: String(BASE_SECONDS + 3 * 60), limit: 5 });
    expect(minutes(p)).toEqual([1, 2]);
  });

  it('clamps limits and handles unknown conversations', () => {
    const db = threadedDb();
    expect(getMessages(db, { conversationId: 'C1', limit: 0 }).messages).toHaveLength(1);
    expect(getMessages(db, { conversationId: 'nope' })).toEqual({
      messages: [],
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
    const many = Array.from({ length: 250 }, (_, i) => msg(tsAt(1000 + i), `m${i}`));
    upsertMessages(db, 'C2', many, 'api');
    expect(getMessages(db, { conversationId: 'C2', limit: 1000 }).messages).toHaveLength(200);
    expect(getMessages(db, { conversationId: 'C2' }).messages).toHaveLength(50);
  });
});

describe('getThread', () => {
  it('returns the parent and all replies ascending, including broadcasts', () => {
    const db = threadedDb();
    const thread = getThread(db, 'C1', tsAt(3));
    expect(thread.parent?.ts).toBe(tsAt(3));
    expect(thread.parent).toMatchObject({ replyCount: 3, latestReply: tsAt(33), isReply: false, threadTs: tsAt(3) });
    expect(thread.replies.map((r) => [r.ts, r.isReply])).toEqual([
      [tsAt(31), true],
      [tsAt(32), true],
      [tsAt(33), true],
    ]);
  });

  it('resolves a reply ts to its thread and tolerates a missing parent', () => {
    const db = threadedDb();
    expect(getThread(db, 'C1', tsAt(32)).parent?.ts).toBe(tsAt(3));
    upsertMessages(db, 'C2', [msg(tsAt(51), 'orphan', { thread_ts: tsAt(50) })], 'api');
    expect(getThread(db, 'C2', tsAt(50))).toMatchObject({ parent: null, replies: [{ ts: tsAt(51) }] });
    expect(getThread(db, 'C2', tsAt(99))).toEqual({ parent: null, replies: [] });
  });
});

describe('MessageDTO mapping', () => {
  it('maps files, bots, attachments, reactions, revisions and deletion', () => {
    const db = seededDb();
    const ts = tsAt(1);
    upsertMessages(
      db,
      'C1',
      [
        {
          ts,
          text: '',
          subtype: 'bot_message',
          bot_id: 'BX',
          bot_profile: { name: 'CI Bot', icons: { image_36: 'https://i/36.png', image_72: 'https://i/72.png' } },
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Build* passed' } }],
          attachments: [
            {
              color: '36a64f',
              title: 'Run #1',
              title_link: 'https://ci/1',
              text: 'ok',
              fields: [{ title: 'Env', value: 'prod', short: true }],
            },
            { color: 'good', is_msg_unfurl: true, original_url: 'https://slack/x', fallback: 'fb' },
          ],
          reactions: [{ name: 'white_check_mark', users: ['U1', 'U2'] }],
          files: [
            {
              id: 'FIMG',
              name: 'a.png',
              mimetype: 'image/png',
              url_private: 'https://f/a',
              original_w: 10,
              original_h: 20,
            },
            {
              id: 'FDOC',
              name: 'b.pdf',
              mimetype: 'application/pdf',
              url_private: 'https://f/b',
              permalink: 'https://slack/b',
            },
            { id: 'FGONE', mode: 'hidden_by_limit' },
          ],
        },
      ],
      'api',
    );
    markFileDownloaded(db, 'FIMG', 'FIMG/a.png');
    markFileDownloaded(db, 'FDOC', 'FDOC/b.pdf', 'FDOC/thumb.png');
    upsertMessages(
      db,
      'C1',
      [{ ts, text: 'now with text', subtype: 'bot_message', bot_id: 'BX', icons: { image_48: 'https://i/48.png' } }],
      'api',
    );
    upsertMessages(db, 'C1', [{ ts, subtype: 'tombstone', text: 'This message was deleted.' }], 'api');

    const [m] = getMessages(db, { conversationId: 'C1' }).messages;
    expect(m).toMatchObject({
      conversationId: 'C1',
      ts,
      threadTs: null,
      isReply: false,
      userId: null,
      botId: 'BX',
      username: null,
      botIconUrl: 'https://i/48.png',
      subtype: 'bot_message',
      text: 'now with text',
      isDeleted: true,
      revisionCount: 0, // '' → text is not a revision (nothing to keep)
      reactions: [],
      attachments: [],
    });
    expect(m.files.map((f) => [f.id, f.available, f.url, f.thumbUrl, f.status, f.isImage])).toEqual([
      ['FIMG', true, 'archive://file/FIMG', 'archive://thumb/FIMG', 'done', true],
      // PDFs aren't shown inline (open with the system app); their thumbnail is.
      ['FDOC', true, null, 'archive://thumb/FDOC', 'done', false],
      ['FGONE', false, null, null, 'unavailable', false],
    ]);
    expect(m.files[0]).toMatchObject({
      width: 10,
      height: 20,
      name: 'a.png',
      mimetype: 'image/png',
      statusReason: null,
    });
    expect(m.files[1].permalink).toBe('https://slack/b');
    expect(m.files[2].statusReason).toBe('No longer available from Slack');
  });

  it('renders Block Kit layouts instead of the fallback text (pitfall 15)', () => {
    const db = seededDb();
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Deploy finished' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*api* v2.3 is live' } },
    ];
    upsertMessages(db, 'C1', [{ ts: tsAt(1), text: 'Deploy finished', bot_id: 'BX', blocks }], 'api');
    // A user message's rich_text mirrors its text: the text is rendered, not the blocks.
    const rich = [
      { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hi' }] }] },
    ];
    upsertMessages(db, 'C1', [{ ts: tsAt(2), text: 'hi', user: 'U1', blocks: rich }], 'api');
    const [bot, user] = getMessages(db, { conversationId: 'C1' }).messages;
    expect(bot.blocks).toEqual(blocks);
    expect(bot.text).toBe('Deploy finished');
    expect(user.blocks).toEqual([]);
  });

  it('maps Block Kit carried inside attachments (pitfall 16)', () => {
    const db = seededDb();
    const inner = [{ type: 'section', text: { type: 'mrkdwn', text: 'PR #12 merged' } }];
    upsertMessages(
      db,
      'C1',
      [{ ts: tsAt(1), text: '', bot_id: 'BX', attachments: [{ color: '#ff0000', blocks: inner }] }],
      'api',
    );
    const [m] = getMessages(db, { conversationId: 'C1' }).messages;
    expect(m.attachments[0]).toMatchObject({ color: '#ff0000', blocks: inner });
  });

  it('derives text from blocks and maps legacy attachments', () => {
    const db = seededDb();
    upsertMessages(
      db,
      'C1',
      [
        {
          ts: tsAt(1),
          text: '',
          bot_profile: { name: 'CI Bot', icons: { image_36: 'https://i/36.png', image_72: 'https://i/72.png' } },
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Build* passed' } }],
          attachments: [
            {
              color: '36a64f',
              title: 'Run #1',
              title_link: 'https://ci/1',
              text: 'ok',
              fields: [{ title: 'Env', value: 'prod', short: true }],
            },
            { color: 'good', is_msg_unfurl: true, original_url: 'https://slack/x', fallback: 'fb' },
          ],
          reactions: [{ name: 'eyes', users: ['U1', 'U2'] }],
        },
      ],
      'api',
    );
    const [m] = getMessages(db, { conversationId: 'C1' }).messages;
    expect(m.text).toBe('*Build* passed');
    expect(m.username).toBe('CI Bot');
    expect(m.botIconUrl).toBe('https://i/72.png');
    expect(m.reactions).toEqual([{ name: 'eyes', count: 2, users: ['U1', 'U2'] }]);
    expect(m.attachments[0]).toMatchObject({
      color: '#36a64f',
      title: 'Run #1',
      titleLink: 'https://ci/1',
      text: 'ok',
      fields: [{ title: 'Env', value: 'prod', short: true }],
      isMsgUnfurl: false,
      fromUrl: null,
    });
    expect(m.attachments[1]).toMatchObject({
      color: 'good',
      isMsgUnfurl: true,
      fromUrl: 'https://slack/x',
      fallback: 'fb',
      fields: [],
    });
  });

  it('counts revisions and returns them oldest first', () => {
    const db = seededDb();
    const ts = tsAt(1);
    upsertMessages(db, 'C1', [msg(ts, 'v1')], 'api');
    upsertMessages(db, 'C1', [msg(ts, 'v2', { edited: { ts: tsAt(2) } })], 'api');
    upsertMessages(db, 'C1', [msg(ts, 'v3', { edited: { ts: tsAt(3) } })], 'api');
    expect(getMessages(db, { conversationId: 'C1' }).messages[0]).toMatchObject({
      text: 'v3',
      revisionCount: 2,
      editedTs: tsAt(3),
    });
    expect(getMessageRevisions(db, 'C1', ts).map((r) => [r.text, r.editedTs])).toEqual([
      ['v1', null],
      ['v2', tsAt(2)],
    ]);
  });
});

describe('conversations and users', () => {
  it('labels channels, DMs, self-DMs and group DMs, with counts and date ranges', () => {
    const db = threadedDb();
    upsertMessages(db, 'D1', [msg(tsAt(100), 'dm new')], 'api');
    upsertMessages(db, 'M1', [msg(tsAt(50), 'group')], 'api');
    upsertConversations(db, [{ id: 'M2', name: 'mpdm-me.self--annabel--ann-1', is_mpim: true }]);
    const convs = listConversations(db);
    expect(convs.map((c) => [c.id, c.type, c.label])).toEqual([
      ['C1', 'channel', 'general'],
      ['C2', 'channel', 'random'],
      ['G1', 'private_channel', 'secret-plans'],
      ['D1', 'im', 'Ali'],
      ['M1', 'mpim', 'Ali, Bob Brown'],
      // no messages yet: after the active ones, by label
      ['M2', 'mpim', 'annabel, ann'],
      ['D2', 'im', 'You'],
    ]);
    const c1 = convs[0];
    expect(c1).toMatchObject({
      rawName: 'general',
      topic: 'Company-wide',
      purpose: 'All hands',
      isArchived: false,
      messageCount: 13,
      oldestTs: tsAt(1),
      latestTs: tsAt(33),
    });
    expect(convs[2].isArchived).toBe(true);
    expect(convs.find((c) => c.id === 'D1')).toMatchObject({ rawName: null, dmUserId: 'U1', messageCount: 1 });
    expect(convs.find((c) => c.id === 'M1')?.memberIds).toEqual(['USELF', 'U1', 'U2']);
    expect(getConversation(db, 'D2')?.label).toBe('You');
    expect(getConversation(db, 'nope')).toBeNull();
  });

  it('lists users with labels', () => {
    const db = seededDb();
    const users = listUsers(db);
    expect(users.find((u) => u.id === 'U1')).toEqual({
      id: 'U1',
      name: 'alice',
      realName: 'Alice Anderson',
      displayName: 'Ali',
      label: 'Ali',
      avatarUrl: 'https://a/72.png',
      isBot: false,
      deleted: false,
    });
    expect(users.find((u) => u.id === 'U2')).toMatchObject({ displayName: null, label: 'Bob Brown' });
    expect(users.find((u) => u.id === 'B1')).toMatchObject({ isBot: true, label: 'Deploy Bot' });
  });
});

describe('stats and workspace meta', () => {
  it('computes archive stats including the beyond-90-days count', () => {
    const db = threadedDb();
    upsertMessages(
      db,
      'C2',
      [
        msg(`${BASE_SECONDS + 200 * 86400}.000000`, 'recent', {
          files: [
            { id: 'F1', name: 'x.bin', size: 1000, url_private: 'https://f/x' },
            { id: 'F2', name: 'y', size: 5, url_private: 'https://f/y' },
          ],
        }),
      ],
      'api',
    );
    markFileDownloaded(db, 'F1', 'F1/x.bin');
    const now = (BASE_SECONDS + 250 * 86400) * 1000; // 50 days after the recent message
    const stats = getStats(db, { now });
    expect(stats).toMatchObject({
      messageCount: 14,
      conversationCount: 6,
      userCount: 6,
      fileCount: 2,
      filesDownloaded: 1,
      filesBytes: 1000,
      oldestTs: tsAt(1),
      newestTs: `${BASE_SECONDS + 200 * 86400}.000000`,
      beyondFreeWindowCount: 13,
    });
    expect(stats.dbBytes).toBeGreaterThan(0);
  });

  it('returns empty stats for an empty archive', () => {
    const stats = getStats(memDb());
    expect(stats).toMatchObject({
      messageCount: 0,
      oldestTs: null,
      newestTs: null,
      beyondFreeWindowCount: 0,
      filesBytes: 0,
    });
  });

  it('reads workspace meta', () => {
    const db = memDb();
    expect(getWorkspaceMeta(db)).toEqual({ teamId: null, teamName: null, teamDomain: null, selfUserId: null });
    setMeta(db, 'team_id', 'T1');
    setMeta(db, 'team_name', '9hdigital');
    setMeta(db, 'team_domain', '9hdigital');
    setMeta(db, 'self_user_id', 'U1');
    expect(getWorkspaceMeta(db)).toEqual({
      teamId: 'T1',
      teamName: '9hdigital',
      teamDomain: '9hdigital',
      selfUserId: 'U1',
    });
  });
});
