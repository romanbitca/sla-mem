import { describe, expect, it } from 'vitest';
import type { SlackMessage } from '../slack/types';
import { addressedPart, extractLinks, getPerson, listPeople, looksLikeAsk, weekStart } from './people';
import { BASE_SECONDS, msg, seededDb, tsAt } from './test-helpers';
import type { DB } from './types';
import { upsertConversations, upsertMessages, upsertUsers } from './write';

/** Minutes in a day, for tsAt(). */
const DAY = 24 * 60;
/** "Now" for the open questions: ten days after the first test message. */
const NOW = (BASE_SECONDS + 10 * 86400) * 1000;
const person = (db: DB, id: string) => getPerson(db, id, { now: NOW })!;
const texts = (messages: { text: string }[]) => messages.map((m) => m.text);
const put = (db: DB, conversationId: string, messages: SlackMessage[]) =>
  upsertMessages(db, conversationId, messages, 'api');

// seededDb(): the reader is USELF; U1 Alice, U2 Bob, U3, U4, bot B1; channels C1 and C2, private
// G1; D1 is the DM with Alice, D2 the reader's notes; M1 the group DM of the reader, Alice and Bob.

describe('listPeople', () => {
  it('lists people who wrote or share a DM with you: not you, apps, Slackbot or the silent', () => {
    const db = seededDb();
    upsertUsers(db, [
      { id: 'USLACKBOT', name: 'slackbot' },
      { id: 'U9', name: 'quiet' },
    ]);
    put(db, 'C1', [
      msg(tsAt(1), 'hi', { user: 'U2' }),
      msg(tsAt(2), 'from me', { user: 'USELF' }),
      msg(tsAt(3), 'deployed', { user: 'B1', bot_id: 'BB1' }),
      msg(tsAt(4), 'reminder', { user: 'USLACKBOT' }),
    ]);
    // Alice never wrote, but the reader wrote to her.
    put(db, 'D1', [msg(tsAt(5), 'hello Alice', { user: 'USELF' })]);
    expect(listPeople(db).map((p) => p.userId)).toEqual(['U1', 'U2']);
  });

  it('says how much you DM and when you last talked, in the DM or a group DM', () => {
    const db = seededDb();
    put(db, 'D1', [msg(tsAt(1), 'a'), msg(tsAt(2), 'b', { user: 'USELF' })]);
    put(db, 'M1', [msg(tsAt(9), 'group', { user: 'U2' })]);
    put(db, 'C1', [msg(tsAt(30), 'in a channel', { user: 'U1' })]);
    const people = listPeople(db);
    expect(people.find((p) => p.userId === 'U1')).toMatchObject({
      messageCount: 2,
      lastMessageTs: tsAt(30),
      dmConversationId: 'D1',
      dmMessageCount: 2,
      lastTalkedTs: tsAt(9),
    });
    expect(people.find((p) => p.userId === 'U2')).toMatchObject({
      messageCount: 1,
      dmConversationId: null,
      dmMessageCount: 0,
      lastTalkedTs: tsAt(9),
    });
  });

  it('puts whoever you were in touch with most recently first', () => {
    const db = seededDb();
    upsertUsers(db, [{ id: 'U5', name: 'eve' }]);
    put(db, 'C1', [msg(tsAt(50), 'channel only, but recent', { user: 'U5' })]);
    put(db, 'D1', [msg(tsAt(10), 'older DM')]);
    put(db, 'C2', [msg(tsAt(60), 'Alice in a channel later', { user: 'U1' })]);
    // Alice's DM (minute 10) counts, not her channel message; Eve only has her message (50).
    expect(listPeople(db).map((p) => p.userId)).toEqual(['U5', 'U1']);
  });
});

describe('getPerson: who they are', () => {
  it('reads the profile: title, time zone, email, guest, a bigger picture', () => {
    const db = seededDb();
    upsertUsers(db, [
      {
        id: 'U5',
        name: 'eve',
        real_name: 'Eve',
        tz: 'Africa/Cairo',
        tz_label: 'Eastern European Summer Time',
        is_restricted: true,
        profile: {
          title: 'Designer',
          email: 'eve@example.com',
          image_72: 'https://a/72.png',
          image_192: 'https://a/192.png',
        },
      },
    ]);
    put(db, 'C1', [msg(tsAt(1), 'hi', { user: 'U5' })]);
    expect(person(db, 'U5')).toMatchObject({
      isSelf: false,
      title: 'Designer',
      tz: 'Africa/Cairo',
      tzLabel: 'Eastern European Summer Time',
      email: 'eve@example.com',
      isGuest: true,
      avatarUrl: 'https://a/192.png',
    });
    expect(listPeople(db)[0]).toMatchObject({ userId: 'U5', title: 'Designer', tz: 'Africa/Cairo' });
  });

  it('drops profile values that are not what they claim to be', () => {
    const db = seededDb();
    upsertUsers(db, [{ id: 'U5', name: 'eve', tz: 'not a zone; drop table', profile: { email: 'nope', title: ' ' } }]);
    expect(person(db, 'U5')).toMatchObject({ title: null, tz: null, email: null, isGuest: false });
  });

  it('is null for someone the archive doesn’t know', () => {
    expect(getPerson(seededDb(), 'UNKNOWN')).toBeNull();
  });
});

describe('getPerson: where you talk', () => {
  it('has the DM, the group DMs with messages, and the channels they write in, busiest first', () => {
    const db = seededDb();
    upsertConversations(
      db,
      [{ id: 'M2', name: 'mpdm-me.self--alice--ann-1', is_mpim: true, members: ['USELF', 'U1', 'U4'] }],
      {
        selfUserId: 'USELF',
      },
    );
    put(db, 'D1', [msg(tsAt(1), 'dm')]);
    put(db, 'M1', [msg(tsAt(2), 'group', { user: 'U2' })]);
    put(db, 'C1', [msg(tsAt(3), 'one')]);
    put(db, 'C2', [msg(tsAt(4), 'two'), msg(tsAt(5), 'three'), msg(tsAt(6), 'not hers', { user: 'U2' })]);
    const alice = person(db, 'U1');
    expect(alice.dm).toEqual({ conversationId: 'D1', messageCount: 1, latestTs: tsAt(1) });
    // M2 has no messages yet.
    expect(alice.groupDms).toEqual([{ conversationId: 'M1', messageCount: 1, latestTs: tsAt(2) }]);
    expect(alice.channels).toEqual([
      { conversationId: 'C2', messageCount: 2, latestTs: tsAt(5) },
      { conversationId: 'C1', messageCount: 1, latestTs: tsAt(3) },
    ]);
    expect(alice).toMatchObject({ messageCount: 4, firstMessageTs: tsAt(1), lastMessageTs: tsAt(5) });
  });

  it('shows the latest between you: the DM, what either of you wrote in group DMs, mentions', () => {
    const db = seededDb();
    put(db, 'D1', [msg(tsAt(1), 'dm from Alice'), msg(tsAt(2), 'dm reply', { user: 'USELF' })]);
    put(db, 'M1', [
      msg(tsAt(3), 'Alice in the group'),
      msg(tsAt(4), 'Bob in the group', { user: 'U2' }),
      msg(tsAt(5), 'me in the group', { user: 'USELF' }),
    ]);
    put(db, 'C1', [
      msg(tsAt(6), '<@USELF> have a look'),
      msg(tsAt(7), 'thanks <@U1>', { user: 'USELF' }),
      msg(tsAt(8), 'Alice talking to everyone'),
    ]);
    const alice = person(db, 'U1');
    expect(texts(alice.recent)).toEqual([
      'thanks <@U1>',
      '<@USELF> have a look',
      'me in the group',
      'Alice in the group',
      'dm reply',
      'dm from Alice',
    ]);
    expect(alice.lastTalkedTs).toBe(tsAt(7));
  });

  it('counts messages between you by local week, from the first week you talked', () => {
    const db = seededDb();
    put(db, 'D1', [msg(tsAt(0), 'a'), msg(tsAt(1), 'b', { user: 'USELF' }), msg(tsAt(8 * DAY), 'c')]);
    put(db, 'M1', [msg(tsAt(8 * DAY + 1), 'd', { user: 'U2' }), msg(tsAt(8 * DAY + 2), 'e', { user: 'USELF' })]);
    const weeks = person(db, 'U1').weeks;
    const first = weekStart(BASE_SECONDS);
    expect(weeks[0]).toEqual({ start: first, count: 2 });
    expect(weeks.reduce((n, w) => n + w.count, 0)).toBe(4); // Bob's group message isn't between you
    expect(weeks[weeks.length - 1].start).toBe(weekStart(NOW / 1000));
    for (const w of weeks) expect(new Date(w.start * 1000).getDay()).toBe(1);
  });

  it('on your own page: what you wrote, nothing "between you"', () => {
    const db = seededDb();
    put(db, 'D1', [msg(tsAt(1), 'to Alice?', { user: 'USELF' })]);
    put(db, 'C1', [msg(tsAt(2), 'my channel message', { user: 'USELF' })]);
    const me = person(db, 'USELF');
    expect(me).toMatchObject({ isSelf: true, dm: null, groupDms: [], recent: [], weeks: [], lastTalkedTs: null });
    expect(me.waitingOnYou).toEqual([]);
    expect(me.waitingOnThem).toEqual([]);
    expect(me.channels.map((c) => c.conversationId)).toEqual(['C1']);
    expect(me.messageCount).toBe(2);
  });
});

describe('getPerson: open questions', () => {
  it('lists their questions you never answered, and yours they never answered', () => {
    const db = seededDb();
    put(db, 'D1', [
      msg(tsAt(1), 'can you send me the estimate?'),
      msg(tsAt(2), 'also, did the client sign?'),
      msg(tsAt(3), 'sure, here it is', { user: 'USELF' }),
      msg(tsAt(4), 'and the invoice?'),
    ]);
    put(db, 'C1', [msg(tsAt(5), '<@U1> could you please review my PR?', { user: 'USELF' })]);
    const alice = person(db, 'U1');
    // In a DM whatever the other one writes next is the answer: the first two got one (minute 3).
    expect(texts(alice.waitingOnYou)).toEqual(['and the invoice?']);
    expect(texts(alice.waitingOnThem)).toEqual(['<@U1> could you please review my PR?']);
  });

  it('takes a reaction or a reply in the thread as the answer', () => {
    const db = seededDb();
    put(db, 'D1', [
      msg(tsAt(1), 'is the build green?', { reactions: [{ name: 'white_check_mark', users: ['USELF'], count: 1 }] }),
      msg(tsAt(2), 'did you see the brief?', { thread_ts: tsAt(2), reply_count: 1 }),
      msg(tsAt(3), 'yes', { thread_ts: tsAt(2), user: 'USELF' }),
    ]);
    expect(person(db, 'U1').waitingOnYou).toEqual([]);
  });

  it('in a channel: a line must speak to you, and a thread question waits for its thread', () => {
    const db = seededDb();
    put(db, 'C1', [
      msg(tsAt(1), '<@USELF> can you check the logs?'),
      msg(tsAt(2), 'I told <@USELF> about it. Does anyone know the password?'),
      msg(tsAt(3), '<@U2> can you deploy?\n<@USELF> fyi'),
      msg(tsAt(4), '<!channel> who is around? <@USELF>'),
      msg(tsAt(5), 'thread starter', { thread_ts: tsAt(5), reply_count: 2 }),
      msg(tsAt(6), 'what do you think, <@USELF>?', { thread_ts: tsAt(5) }),
      // The reader writes in the channel right after, but not in that thread.
      msg(tsAt(7), 'unrelated news', { user: 'USELF' }),
    ]);
    expect(texts(person(db, 'U1').waitingOnYou)).toEqual(['what do you think, <@USELF>?']);
  });

  it('in a channel: a top-level answer counts only within a day', () => {
    const db = seededDb();
    put(db, 'C1', [
      msg(tsAt(1), '<@USELF> can you check the logs?'),
      msg(tsAt(2 * DAY), 'hey <@USELF>, any update on the release?'),
      msg(tsAt(2 * DAY + 60), 'on it', { user: 'USELF' }),
    ]);
    expect(texts(person(db, 'U1').waitingOnYou)).toEqual(['<@USELF> can you check the logs?']);
  });

  it('an answer from anyone else it was addressed to settles it', () => {
    const db = seededDb();
    put(db, 'C1', [
      msg(tsAt(1), 'hey <@U2> <@USELF>, who can review this?', { thread_ts: tsAt(1), reply_count: 1 }),
      msg(tsAt(2), 'I will', { thread_ts: tsAt(1), user: 'U2' }),
    ]);
    expect(person(db, 'U1').waitingOnYou).toEqual([]);
  });

  it('leaves out greetings, requests of a word or two, and questions older than 30 days', () => {
    const db = seededDb();
    put(db, 'D1', [
      msg(tsAt(-40 * DAY), 'did you ever send the contract?'),
      msg(tsAt(1), 'hi, how are you?'),
      msg(tsAt(2), '2 min pls'),
      msg(tsAt(3), 'look: <https://example.com/doc?tab=2|the doc>'),
    ]);
    expect(person(db, 'U1').waitingOnYou).toEqual([]);
  });
});

describe('getPerson: what they shared', () => {
  it('has their newest messages with files, and the links they posted, each once', () => {
    const db = seededDb();
    put(db, 'C1', [
      msg(tsAt(1), 'spec', { files: [{ id: 'F1', name: 'spec.pdf', mimetype: 'application/pdf' }] }),
      msg(tsAt(2), 'see <https://example.com/a?x=1&amp;y=2|the plan> and <https://9h.slack.com/archives/C1/p1>'),
      msg(tsAt(3), 'again <https://example.com/a?x=1&amp;y=2> and <https://docs.example.com/b|docs.example.com/b>'),
      msg(tsAt(4), 'not hers', { user: 'U2', files: [{ id: 'F2', name: 'x.png', mimetype: 'image/png' }] }),
    ]);
    const alice = person(db, 'U1');
    expect(alice.fileMessages.map((m) => m.files.map((f) => f.id))).toEqual([['F1']]);
    expect(alice.links).toEqual([
      {
        url: 'https://example.com/a?x=1&y=2',
        label: null,
        conversationId: 'C1',
        ts: tsAt(3),
        threadTs: null,
        isReply: false,
      },
      {
        url: 'https://docs.example.com/b',
        label: null,
        conversationId: 'C1',
        ts: tsAt(3),
        threadTs: null,
        isReply: false,
      },
    ]);
  });
});

describe('looksLikeAsk', () => {
  it.each([
    ['can you send the file?', true],
    ['could you please review it', true],
    ['please send it to the client before it expires', true],
    ['let me know when it is live', true],
    ['هل يمكنك المراجعة؟', true],
    ['ok?', true],
    ['2 min pls', false],
    ['hi, how are you?', false],
    ['not bad thanks for asking hbu ?', false],
    ['how are you? can you check the PR?', true],
    ['the doc: <https://example.com/doc?tab=2>', false],
    ['run `curl -s "x?y"` first', false],
    ['> did you get it?\nyes, got it', false],
    ['Thanks, all done.', false],
  ])('%s → %s', (text, expected) => {
    expect(looksLikeAsk(text)).toBe(expected);
  });
});

describe('addressedPart', () => {
  it('takes a DM whole', () => {
    expect(addressedPart('any news?', 'UME', true)).toEqual({ text: 'any news?', alsoTo: [] });
  });

  it.each([
    ['<@UME> can you check?', ['<@UME> can you check?'], []],
    ['hey <@UA> <@UME>, who can review?', ['hey <@UA> <@UME>, who can review?'], ['UA']],
    ['Thanks <@UA> and <@UME|me>!', ['Thanks <@UA> and <@UME|me>!'], ['UA']],
    ['Please involve me in the meeting with the client <@UME>. I can join.', null, []],
    ['can someone look at this? cc <@UME>', ['can someone look at this? cc <@UME>'], []],
    ['<@UA> can you deploy?\n<@UME> fyi\nsee the notes?', ['<@UME> fyi', 'see the notes?'], []],
  ])('%s', (text, lines, alsoTo) => {
    const part = addressedPart(text, 'UME', false);
    if (lines === null) {
      expect(part?.text).toBe(text);
    } else {
      expect(part).toEqual({ text: lines.join('\n'), alsoTo });
    }
  });

  it('is nothing when the mention is only about them, or for everyone', () => {
    expect(addressedPart('I told <@UME> about it. Does anyone know?', 'UME', false)).toBeNull();
    expect(addressedPart('created 3 tasks for <@UME>: <https://x.com/t>', 'UME', false)).toBeNull();
    expect(addressedPart('a message to <@UME>, waiting for her go ahead', 'UME', false)).toBeNull();
    expect(addressedPart('<!here> can someone help <@UME>?', 'UME', false)).toBeNull();
    expect(addressedPart('<@UA> do you need help?', 'UME', false)).toBeNull();
  });
});

describe('extractLinks', () => {
  it('reads Slack links with their labels, unescaped, without Slack’s own', () => {
    expect(
      extractLinks(
        'a <https://x.com/p?a=1&amp;b=2|the plan> b <https://y.com> c <https://y.com/|y.com> d <mailto:a@b.c|mail> e <https://files.slack.com/f>',
      ),
    ).toEqual([
      { url: 'https://x.com/p?a=1&b=2', label: 'the plan' },
      { url: 'https://y.com', label: null },
      { url: 'https://y.com/', label: null },
    ]);
  });
});

describe('weekStart', () => {
  it('is local Monday midnight', () => {
    // 2026-09-17 was a Thursday.
    const thursday = new Date(2026, 8, 17, 15, 30).getTime() / 1000;
    expect(new Date(weekStart(thursday) * 1000)).toEqual(new Date(2026, 8, 14));
    const monday = new Date(2026, 8, 14, 0, 0).getTime() / 1000;
    expect(weekStart(monday)).toBe(monday);
  });
});
