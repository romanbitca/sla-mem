import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getConversation,
  getFileRow,
  getMessageRevisions,
  getMessages,
  getSyncState,
  getThread,
  getWorkspaceMeta,
  listCustomEmoji,
  listUsers,
  openDb,
  search,
  setMeta,
  type DB,
} from '../db';
import type { SyncProgress } from '../../shared/types';
import { SlackApiError, SlackHttpError } from './errors';
import { FAKE_BASE_URL, FAKE_TOKEN, FakeSlack, fakeClock } from './fake-slack';
import { runApiSync, statsFromError, teamDomainFromUrl, teamIconUrl, type ApiSyncOptions } from './sync';
import type { SlackMessage } from './types';
import { subtractSeconds } from './util';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const DAY = 24 * 60;
const HOUR = 60;

/** Slack ts `minutesAgo` minutes before NOW. */
function ts(minutesAgo: number, micros = 100): string {
  return `${NOW_S - minutesAgo * 60}.${String(micros).padStart(6, '0')}`;
}

function msg(tsValue: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage {
  return { type: 'message', ts: tsValue, user: 'U1', text, ...extra };
}

let db: DB;
let fake: FakeSlack;
let filesDir: string;
let logs: string[];
let progress: SyncProgress[];
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  db = openDb(':memory:');
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-sync-'));
  logs = [];
  progress = [];
  clock = fakeClock();
  fake = new FakeSlack();
  fake.now = () => NOW;
  fake.users = [
    { id: 'USELF', name: 'me', real_name: 'Me Myself', profile: { display_name: 'me' } },
    { id: 'U1', name: 'alice', real_name: 'Alice Anderson', profile: { display_name: 'Ali' } },
    { id: 'U2', name: 'bob', real_name: 'Bob Brown', profile: {} },
    { id: 'B1', name: 'deploybot', is_bot: true, profile: { real_name: 'Deploy Bot' } },
  ];
  fake.conversations = [
    { id: 'C1', name: 'general', is_channel: true, topic: { value: 'All hands' }, purpose: { value: '' } },
    { id: 'C2', name: 'secret', is_group: true, is_private: true },
    { id: 'D1', is_im: true, user: 'U1' },
    { id: 'G1', name: 'mpdm-me--alice--bob-1', is_mpim: true, is_group: true, is_private: true },
  ];
  fake.members.set('G1', ['USELF', 'U1', 'U2']);
});

afterEach(() => {
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
  const everything = [...logs, ...progress.map((p) => p.message)].join('\n');
  expect(everything).not.toContain(FAKE_TOKEN);
});

function sync(extra: Partial<ApiSyncOptions> = {}) {
  return runApiSync({
    db,
    token: FAKE_TOKEN,
    baseUrl: FAKE_BASE_URL,
    fetch: fake.fetch,
    filesDir,
    now: () => NOW,
    log: (l) => logs.push(l),
    onProgress: (p) => progress.push(p),
    attachmentPolicy: 'none',
    overlapSeconds: 3 * 3600,
    threadRecheckDays: 21,
    clientOptions: { throttle: false, sleep: clock.sleep, now: clock.now, random: () => 0.5 },
    ...extra,
  });
}

function storedTs(conversationId: string): string[] {
  return (
    db.prepare('SELECT ts FROM messages WHERE conversation_id = ? ORDER BY ts').all(conversationId) as { ts: string }[]
  ).map((r) => r.ts);
}

function historyCalls(channel: string) {
  return fake.callsOf('conversations.history').filter((c) => c.params.channel === channel);
}

function repliesCalls(threadTs?: string) {
  return fake.callsOf('conversations.replies').filter((c) => !threadTs || c.params.ts === threadTs);
}

/** Conversations whose history was read since call number `since`, in order. */
function historyChannels(since: number): string[] {
  return fake.calls
    .slice(since)
    .filter((c) => c.method === 'conversations.history')
    .map((c) => c.params.channel);
}

describe('first sync', () => {
  it('stores workspace meta, users, conversations and the full history across pages', async () => {
    fake.pageSize = 3;
    for (let i = 0; i < 8; i++) fake.addMessage('C1', msg(ts(100 - i), `general message ${i}`));
    fake.addMessage('D1', msg(ts(50), 'hi me', { user: 'U1' }));
    fake.addMessage('D1', msg(ts(49), 'hi alice', { user: 'USELF' }));
    fake.addMessage('G1', msg(ts(10), 'group hello', { user: 'U2' }));

    const stats = await sync();

    expect(stats).toMatchObject({ conversations: 4, messagesInserted: 11, messagesUpdated: 0, errors: 0 });
    expect(stats.apiCalls).toBe(fake.calls.length);
    expect(getWorkspaceMeta(db)).toEqual({
      teamId: 'T0001',
      teamName: '9hdigital',
      teamDomain: '9hdigital',
      selfUserId: 'USELF',
      teamIcon: null,
    });
    expect(listUsers(db)).toHaveLength(4);
    expect(getConversation(db, 'D1')).toMatchObject({ type: 'im', dmUserId: 'U1' });
    expect(getConversation(db, 'C2')).toMatchObject({ type: 'private_channel' });
    expect(getConversation(db, 'G1')).toMatchObject({ type: 'mpim', memberIds: ['USELF', 'U1', 'U2'] });

    // 8 messages at 3 per page: three cursor-linked calls, newest page first.
    const calls = historyCalls('C1');
    expect(calls).toHaveLength(3);
    expect(calls[0].params).toMatchObject({ limit: '200' });
    expect(calls[0].params.cursor).toBeUndefined();
    expect(calls[1].params.cursor).toBeTruthy();
    expect(storedTs('C1')).toHaveLength(8);
    expect(getMessages(db, { conversationId: 'C1' }).messages.map((m) => m.text)).toEqual(
      Array.from({ length: 8 }, (_, i) => `general message ${i}`),
    );
    expect(getSyncState(db, 'C1')).toEqual({
      conversation_id: 'C1',
      latest_ts: ts(93),
      oldest_ts: ts(100),
      backfill_complete: true,
      last_synced_at: NOW,
      last_error: null,
    });
    // An empty conversation completes too, without a latest_ts.
    expect(getSyncState(db, 'C2')).toMatchObject({ latest_ts: null, backfill_complete: true, last_error: null });

    const history = progress.filter((p) => p.phase === 'history' && /^Fetching [^—]+$/.test(p.message));
    expect(history.map((p) => [p.current, p.total])).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
    expect(history.map((p) => p.message)).toEqual([
      'Fetching #general',
      'Fetching #secret',
      'Fetching Ali',
      'Fetching Ali, Bob Brown',
    ]);
    // Plain-language running counts (PLAN §8.1: "Fetching #general — 1,240 messages so far").
    expect(progress.map((p) => p.message)).toContain('Fetching #general — 8 messages so far');
  });

  it('asks users.conversations for every conversation type the user is in', async () => {
    await sync();
    expect(fake.callsOf('users.conversations')[0].params).toMatchObject({
      types: 'public_channel,private_channel,mpim,im',
      exclude_archived: 'false',
      limit: '200',
      user: 'USELF',
    });
    expect(fake.callsOf('users.list')[0].params).toMatchObject({ limit: '200' });
  });

  it('looks up group DM members only once', async () => {
    await sync();
    await sync();
    expect(fake.callsOf('conversations.members')).toHaveLength(1);
  });

  it('on the Free plan, stops at the 90-day limit and never drops what aged out', async () => {
    fake.addMessage('C1', msg(ts(100 * DAY), 'too old, invisible'));
    fake.addMessage('C1', msg(ts(89 * DAY), 'about to age out'));
    fake.addMessage('C1', msg(ts(60), 'recent'));
    await sync();
    expect(storedTs('C1')).toEqual([ts(89 * DAY), ts(60)]);
    expect(getSyncState(db, 'C1')!.backfill_complete).toBe(true);

    // Five days later Slack hides the 89-day-old message; the archive keeps it.
    const later = NOW + 5 * 86_400_000;
    fake.now = () => later;
    await sync({ now: () => later });
    expect(storedTs('C1')).toEqual([ts(89 * DAY), ts(60)]);
    expect(getMessages(db, { conversationId: 'C1' }).messages[0].text).toBe('about to age out');
  });
});

describe('incremental sync', () => {
  it('re-reads the overlap window: catches edits and new messages without duplicates', async () => {
    fake.addMessage('C1', msg(ts(5 * HOUR), 'outside the window'));
    fake.addMessage('C1', msg(ts(2 * HOUR), 'v1'));
    fake.addMessage('C1', msg(ts(1 * HOUR), 'latest'));
    await sync();

    fake.editMessage('C1', ts(2 * HOUR), 'v2', ts(30));
    fake.editMessage('C1', ts(5 * HOUR), 'edited but too old to notice', ts(29));
    fake.addMessage('C1', msg(ts(10), 'brand new'));
    const calls = fake.calls.length;
    const stats = await sync();

    expect(stats).toMatchObject({ messagesInserted: 1, revisions: 1, messagesUpdated: 1 });
    const call = fake.calls
      .slice(calls)
      .find((c) => c.method === 'conversations.history' && c.params.channel === 'C1')!;
    expect(call.params).toMatchObject({ oldest: subtractSeconds(ts(HOUR), 3 * 3600), inclusive: 'true' });
    expect(storedTs('C1')).toEqual([ts(5 * HOUR), ts(2 * HOUR), ts(HOUR), ts(10)]);
    expect(getMessageRevisions(db, 'C1', ts(2 * HOUR)).map((r) => r.text)).toEqual(['v1']);
    const texts = getMessages(db, { conversationId: 'C1' }).messages.map((m) => m.text);
    expect(texts).toEqual(['outside the window', 'v2', 'latest', 'brand new']);
    expect(getSyncState(db, 'C1')!.latest_ts).toBe(ts(10));
  });

  it('does nothing when nothing changed', async () => {
    fake.addMessage('C1', msg(ts(30), 'hello'));
    await sync();
    const stats = await sync();
    expect(stats).toMatchObject({
      messagesInserted: 0,
      messagesUpdated: 0,
      revisions: 0,
      threadsFetched: 0,
      errors: 0,
    });
  });
});

describe('every sync, with documented calls only', () => {
  it('reads every conversation, and never calls the Slack app’s own unread summary', async () => {
    fake.addMessage('C1', msg(ts(30), 'active today'));
    fake.addMessage('C2', msg(ts(10 * DAY), 'quiet for ten days'));
    await sync();
    fake.addMessage('D1', msg(ts(-1), 'a new DM'));
    const before = fake.calls.length;
    const stats = await sync();
    expect(historyChannels(before)).toEqual(['C1', 'C2', 'D1', 'G1']);
    expect(stats).toMatchObject({ conversations: 4, messagesInserted: 1 });
    expect(fake.calls.map((c) => c.method)).not.toContain('client.counts');
  });
});

describe('threads', () => {
  it('fetches new threads, deduplicates the parent across pages, and refetches when latest_reply changes', async () => {
    fake.pageSize = 2;
    const parent = ts(2 * HOUR);
    fake.addMessage('C1', msg(parent, 'thread parent'));
    fake.addReply('C1', parent, msg(ts(100), 'reply 1', { user: 'U2' }));
    fake.addReply('C1', parent, msg(ts(90), 'reply 2'));
    fake.addReply('C1', parent, msg(ts(80), 'reply 3', { user: 'U2' }));

    const first = await sync();
    expect(first.threadsFetched).toBe(1);
    expect(repliesCalls(parent)).toHaveLength(2); // parent repeated on both pages
    expect(getThread(db, 'C1', parent).replies.map((r) => r.text)).toEqual(['reply 1', 'reply 2', 'reply 3']);

    fake.addReply('C1', parent, msg(ts(5), 'reply 4'));
    const before = repliesCalls(parent).length;
    const second = await sync();
    expect(second).toMatchObject({ threadsFetched: 1, messagesInserted: 1 });
    expect(repliesCalls(parent).length).toBeGreaterThan(before);
    expect(getThread(db, 'C1', parent).replies).toHaveLength(4);
    expect(getThread(db, 'C1', parent).parent).toMatchObject({ replyCount: 4, latestReply: ts(5) });

    const settled = repliesCalls().length;
    const third = await sync();
    expect(third.threadsFetched).toBe(0);
    expect(repliesCalls()).toHaveLength(settled);
  });

  it('finds new replies to quiet threads on their parents, reading history a little further back', async () => {
    const quiet = ts(10 * DAY);
    const dormant = ts(40 * DAY);
    fake.addMessage('C1', msg(quiet, 'old parent, replies a week ago'));
    fake.addReply('C1', quiet, msg(ts(9 * DAY), 'first reply'));
    fake.addMessage('C1', msg(dormant, 'dormant thread'));
    fake.addReply('C1', dormant, msg(ts(39 * DAY), 'long ago'));
    fake.addMessage('C1', msg(ts(30), 'recent top-level'));
    await sync({ overlapSeconds: 3600 });

    // Nothing new: one history read reaching back to the quiet thread's parent, and no thread polls
    // (it used to be one conversations.replies call per thread with a reply in the last 21 days).
    let before = fake.calls.length;
    await sync({ overlapSeconds: 3600 });
    let calls = fake.calls.slice(before);
    expect(calls.filter((c) => c.method === 'conversations.replies')).toEqual([]);
    expect(
      calls
        .filter((c) => c.method === 'conversations.history' && c.params.channel === 'C1')
        .map((c) => c.params.oldest),
    ).toEqual([quiet]);

    // A new reply shows on the parent, so that thread (and only that one) is fetched.
    fake.addReply('C1', quiet, msg(ts(10), 'new reply'));
    before = fake.calls.length;
    const stats = await sync({ overlapSeconds: 3600 });
    calls = fake.calls.slice(before);
    expect(calls.filter((c) => c.method === 'conversations.replies').map((c) => c.params.ts)).toEqual([quiet]);
    expect(stats.threadsFetched).toBe(1);
    expect(getThread(db, 'C1', quiet).replies.map((r) => r.text)).toEqual(['first reply', 'new reply']);
  });

  it('polls a quiet thread instead when its parent is several history pages back', async () => {
    const parent = ts(12 * DAY);
    fake.addMessage('C1', msg(parent, 'old thread in a busy channel'));
    fake.addReply('C1', parent, msg(ts(11 * DAY), 'reply'));
    for (let i = 0; i < 450; i++) fake.addMessage('C1', msg(ts(11 * DAY - (i + 1) * 30), `chatter ${i}`));
    fake.addMessage('C1', msg(ts(20), 'latest'));
    await sync({ overlapSeconds: 3600 });

    const before = fake.calls.length;
    await sync({ overlapSeconds: 3600 });
    const calls = fake.calls.slice(before);
    expect(
      calls
        .filter((c) => c.method === 'conversations.history' && c.params.channel === 'C1')
        .map((c) => c.params.oldest),
    ).toEqual([subtractSeconds(ts(20), 3600)]);
    expect(calls.filter((c) => c.method === 'conversations.replies').map((c) => c.params)).toEqual([
      expect.objectContaining({ ts: parent, oldest: ts(11 * DAY), inclusive: 'true' }),
    ]);
  });

  it('still polls a thread whose latest reply is recent, to notice an edit to it (pitfall 6)', async () => {
    const quiet = ts(10 * DAY);
    const fresh = ts(8 * DAY);
    fake.addMessage('C1', msg(quiet, 'quiet thread'));
    fake.addReply('C1', quiet, msg(ts(9 * DAY), 'a reply from last week'));
    fake.addMessage('C1', msg(fresh, 'thread with a fresh reply'));
    const reply = fake.addReply('C1', fresh, msg(ts(40), 'teh answer'));
    fake.addMessage('C1', msg(ts(30), 'latest'));
    await sync({ overlapSeconds: 3600 });

    fake.editMessage('C1', reply.ts, 'the answer', ts(5));
    const before = fake.calls.length;
    const stats = await sync({ overlapSeconds: 3600 });
    const calls = fake.calls.slice(before);
    expect(calls.find((c) => c.method === 'conversations.history')?.params.oldest).toBe(quiet);
    expect(calls.filter((c) => c.method === 'conversations.replies').map((c) => c.params.ts)).toEqual([fresh]);
    expect(stats.revisions).toBe(1);
    expect(getMessageRevisions(db, 'C1', reply.ts).map((r) => r.text)).toEqual(['teh answer']);
  });

  it('still checks the threads that were active at the last sync when the next one is a month later', async () => {
    const parent = ts(10 * DAY);
    fake.addMessage('C1', msg(parent, 'question from last week'));
    fake.addReply('C1', parent, msg(ts(9 * DAY), 'first answer'));
    fake.addMessage('C1', msg(ts(30), 'recent'));
    await sync({ overlapSeconds: 3600 });

    // A month passes without a sync; the thread gets a reply the day before the next one. Counted
    // from the new sync, its last reply (39 days back) is outside the 21 days; counted from the
    // previous sync (9 days back) it isn't, so the thread is still checked.
    const later = NOW + 30 * DAY * 60_000;
    fake.now = () => later;
    fake.addReply('C1', parent, msg(ts(-29 * DAY), 'answer a month later'));
    const stats = await sync({ overlapSeconds: 3600, now: () => later });

    expect(stats.threadsFetched).toBe(1);
    expect(getThread(db, 'C1', parent).replies.map((r) => r.text)).toEqual(['first answer', 'answer a month later']);
  });

  it('fetches a dormant thread when a broadcast reply shows up in history', async () => {
    const parent = ts(40 * DAY);
    fake.addMessage('C1', msg(parent, 'ancient parent'));
    fake.addReply('C1', parent, msg(ts(39 * DAY), 'old reply'));
    fake.addMessage('C1', msg(ts(60), 'recent'));
    await sync({ overlapSeconds: 3600 });

    fake.addReply('C1', parent, msg(ts(20), 'quiet reply'));
    fake.addReply('C1', parent, msg(ts(10), 'also sent to channel'), { broadcast: true });
    await sync({ overlapSeconds: 3600 });

    expect(getThread(db, 'C1', parent).replies.map((r) => r.text)).toEqual([
      'old reply',
      'quiet reply',
      'also sent to channel',
    ]);
    // The broadcast is a top-level message in the channel view too.
    expect(getMessages(db, { conversationId: 'C1' }).messages.map((m) => m.text)).toContain('also sent to channel');
  });

  it('treats thread_not_found as a deleted thread, not a conversation error', async () => {
    const parent = ts(60);
    fake.addMessage('C1', msg(parent, 'parent'));
    fake.addReply('C1', parent, msg(ts(50), 'reply'));
    fake.inject('conversations.replies', { error: 'thread_not_found' });
    const stats = await sync();
    expect(stats).toMatchObject({ errors: 0, threadsFetched: 0, messagesInserted: 1 });
    expect(getSyncState(db, 'C1')).toMatchObject({ last_error: null, backfill_complete: true });
    expect(logs).toContain(`#general: thread ${parent} no longer exists in Slack`);
  });
});

describe('errors', () => {
  it('records per-conversation errors and keeps going', async () => {
    fake.channelErrors.set('C2', 'not_in_channel');
    fake.channelErrors.set('D1', 'missing_scope');
    fake.addMessage('C1', msg(ts(10), 'still archived'));
    const stats = await sync();

    expect(stats).toMatchObject({ conversations: 2, errors: 2, messagesInserted: 1 });
    expect(getSyncState(db, 'C2')!.last_error).toBe('not_in_channel');
    expect(getSyncState(db, 'D1')!.last_error).toBe('missing_scope');
    expect(logs).toContain('#secret: skipped this time (not_in_channel)');

    fake.channelErrors.clear();
    await sync();
    expect(getSyncState(db, 'C2')!.last_error).toBeNull();
  });

  it('aborts on invalid_auth with an actionable message that never includes the token', async () => {
    fake.token = 'xoxp-some-other-token';
    const err = await sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).code).toBe('invalid_auth');
    expect((err as Error).message).toMatch(/Slack signed you out \(invalid_auth\)\. Reconnect/);
    expect((err as Error).message).not.toContain(FAKE_TOKEN);
    expect(statsFromError(err)).toMatchObject({ conversations: 0, apiCalls: 1 });
  });

  it('refuses a token for a different workspace or user than the archive', async () => {
    setMeta(db, 'team_id', 'T9999');
    setMeta(db, 'team_name', 'other-co');
    await expect(sync()).rejects.toThrow(
      'This archive belongs to another person at other-co. To archive a different account, use a different archive folder.',
    );
    expect(fake.callsOf('users.list')).toHaveLength(0);
    expect(getWorkspaceMeta(db).teamId).toBe('T9999');

    setMeta(db, 'team_id', 'T0001');
    setMeta(db, 'self_user_id', 'UOTHER');
    await expect(sync()).rejects.toMatchObject({ name: 'WrongAccountError', code: 'wrong_account' });
    expect(listUsers(db)).toHaveLength(0);
  });

  it('aborts the whole run when the token is revoked mid-sync', async () => {
    fake.addMessage('C1', msg(ts(10), 'x'));
    fake.inject('conversations.history', { error: 'token_revoked' });
    const err = await sync().catch((e: unknown) => e);
    expect((err as SlackApiError).code).toBe('token_revoked');
    expect((err as Error).message).toMatch(/revoked/);
    expect(getSyncState(db, 'C1')?.last_error ?? null).toBeNull();
    expect(historyCalls('C2')).toHaveLength(0);
  });

  it('rides out a 429 with Retry-After and a transient 500', async () => {
    fake.addMessage('C1', msg(ts(10), 'x'));
    fake.inject('conversations.history', { status: 429, retryAfter: 7 });
    fake.inject('users.list', { status: 500 });
    const stats = await sync();
    expect(stats).toMatchObject({ messagesInserted: 1, errors: 0 });
    expect(clock.sleeps).toEqual(expect.arrayContaining([7000, 750]));
    expect(logs.some((l) => l.includes('conversations.history rate limited'))).toBe(true);
  });

  it('aborts when Slack stays unreachable', async () => {
    fake.inject('users.list', { network: 'ENOTFOUND' }, 10);
    const err = await sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackHttpError);
    expect((err as Error).message).toContain('ENOTFOUND');
  });
});

describe('cancellation', () => {
  it('keeps committed pages when aborted mid-conversation and resumes next run', async () => {
    fake.pageSize = 2;
    for (let i = 0; i < 6; i++) fake.addMessage('C1', msg(ts(60 - i), `m${i}`));
    const controller = new AbortController();
    fake.onCall = (call) => {
      if (call.method === 'conversations.history' && call.params.channel === 'C1' && call.params.cursor)
        controller.abort();
    };

    const err = await sync({ signal: controller.signal }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(statsFromError(err)).toMatchObject({ messagesInserted: 2 });
    expect(storedTs('C1')).toEqual([ts(56), ts(55)]);
    expect(getSyncState(db, 'C1')).toMatchObject({ latest_ts: ts(55), oldest_ts: ts(56), backfill_complete: false });
    expect(historyCalls('C2')).toHaveLength(0);

    fake.onCall = undefined;
    const before = fake.calls.length;
    const stats = await sync();
    expect(stats.messagesInserted).toBe(4);
    expect(storedTs('C1')).toHaveLength(6);
    expect(getSyncState(db, 'C1')).toMatchObject({ latest_ts: ts(55), oldest_ts: ts(60), backfill_complete: true });
    const resumed = fake.calls
      .slice(before)
      .filter((c) => c.method === 'conversations.history' && c.params.channel === 'C1');
    expect(resumed.some((c) => c.params.latest === ts(56) && c.params.inclusive === 'false')).toBe(true);
  });

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sync({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('excluded conversations (Settings → What to archive)', () => {
  const pdf = (id: string) => {
    const url = `https://files.slack.com/files-pri/T0001-${id}/download/${id}.pdf`;
    fake.files.set(url, { body: '%PDF', contentType: 'application/pdf' });
    return {
      id,
      name: `${id}.pdf`,
      mimetype: 'application/pdf',
      filetype: 'pdf',
      mode: 'hosted',
      url_private: url,
      url_private_download: url,
    };
  };

  it('fetches nothing for them: no history, threads or attachments', async () => {
    fake.addMessage('C1', msg(ts(30), 'public'));
    fake.addMessage('D1', msg(ts(20), 'private', { files: [pdf('F9')] }));
    const stats = await sync({ attachmentPolicy: 'everything', excludedConversationIds: () => ['D1'] });
    expect(storedTs('C1')).toHaveLength(1);
    expect(storedTs('D1')).toHaveLength(0);
    expect(fake.callsOf('conversations.history').map((c) => c.params.channel)).not.toContain('D1');
    expect(stats.filesDownloaded).toBe(0);
    // Still listed, so Settings can show it by name.
    expect(getConversation(db, 'D1')).not.toBeNull();
    expect(logs.join('\n')).toContain('Not archiving 1 conversation excluded in Settings');
  });

  it('applies an exclusion made while the sync runs, before that conversation’s turn', async () => {
    fake.addMessage('C1', msg(ts(30), 'one'));
    fake.addMessage('C2', msg(ts(30), 'two'));
    let excluded: string[] = [];
    await sync({
      excludedConversationIds: () => excluded,
      onProgress: (p) => {
        progress.push(p);
        if (p.message.includes('#general')) excluded = ['C2'];
      },
    });
    expect(storedTs('C1')).toHaveLength(1);
    expect(storedTs('C2')).toHaveLength(0);
  });

  it('can refresh only the people and conversation lists (onboarding asks first)', async () => {
    fake.addMessage('C1', msg(ts(30), 'not yet'));
    await sync({ listsOnly: true });
    expect(listUsers(db).map((u) => u.id)).toContain('U1');
    expect(getConversation(db, 'G1')).not.toBeNull();
    expect(storedTs('C1')).toHaveLength(0);
    expect(fake.callsOf('conversations.history')).toHaveLength(0);
  });
});

describe('options and extras', () => {
  it('limits history to conversationIds and reports unknown ids', async () => {
    fake.addMessage('C1', msg(ts(10), 'not synced'));
    fake.addMessage('D1', msg(ts(10), 'synced'));
    const stats = await sync({ conversationIds: ['D1', 'CNOPE'] });
    expect(stats).toMatchObject({ conversations: 1, errors: 1, messagesInserted: 1 });
    expect(historyCalls('C1')).toHaveLength(0);
    expect(logs.some((l) => l.startsWith('CNOPE'))).toBe(true);
  });

  it('refreshes search text when a user is renamed', async () => {
    fake.addMessage('C1', msg(ts(10), 'ping <@U1> about the deploy', { user: 'U2' }));
    await sync();
    expect(search(db, { q: 'Alicia' }).total).toBe(0);

    fake.users[1] = { ...fake.users[1], profile: { display_name: 'Alicia' } };
    await sync();
    expect(search(db, { q: 'Alicia' }).total).toBe(1);
    expect(logs.some((l) => l.includes('refreshed search text'))).toBe(true);
  });

  it('stores custom emoji, and skips them silently without emoji:read', async () => {
    fake.emoji = { partyparrot: 'https://emoji.slack-edge.com/T0001/partyparrot/abc.gif', parrot: 'alias:partyparrot' };
    await sync();
    expect(listCustomEmoji(db)).toEqual({
      partyparrot: 'https://emoji.slack-edge.com/T0001/partyparrot/abc.gif',
      parrot: 'https://emoji.slack-edge.com/T0001/partyparrot/abc.gif',
    });

    fake.emoji = null;
    logs.length = 0;
    const stats = await sync();
    expect(stats.errors).toBe(0);
    expect(logs.some((l) => /emoji/i.test(l))).toBe(false);
  });

  it('downloads files when enabled; hidden_by_limit stubs stay unavailable', async () => {
    const url = 'https://files.slack.com/files-pri/T0001-F1/download/plan.pdf';
    fake.addMessage(
      'C1',
      msg(ts(10), 'see attached', {
        files: [
          {
            id: 'F1',
            name: 'plan.pdf',
            mimetype: 'application/pdf',
            filetype: 'pdf',
            mode: 'hosted',
            url_private: url,
            url_private_download: url,
          },
          { id: 'F2', mode: 'hidden_by_limit' },
        ],
      }),
    );
    fake.files.set(url, { body: '%PDF plan', contentType: 'application/pdf' });

    const stats = await sync({ attachmentPolicy: 'everything' });
    expect(stats).toMatchObject({ filesDownloaded: 1, filesFailed: 0, filesSkipped: 0 });
    expect(getFileRow(db, 'F1')).toMatchObject({ download_status: 'done', local_path: path.join('F1', 'plan.pdf') });
    expect(getFileRow(db, 'F2')!.download_status).toBe('unavailable');
    expect(fs.readFileSync(path.join(filesDir, 'F1', 'plan.pdf'), 'utf8')).toBe('%PDF plan');
    expect(progress.some((p) => p.phase === 'files' && p.current === 1 && p.total === 1)).toBe(true);
  });

  it('keeps the workspace logo from team.info, and drops it when Slack’s generated icon is back', async () => {
    const logo = 'https://avatars.slack-edge.com/2024-01-01/9h_132.png';
    fake.team.icon = { image_44: 'https://avatars.slack-edge.com/2024-01-01/9h_44.png', image_132: logo };
    await sync();
    expect(getWorkspaceMeta(db).teamIcon).toBe(logo);

    fake.team.icon = { image_132: 'https://a.slack-edge.com/default_132.png', image_default: true };
    await sync();
    expect(getWorkspaceMeta(db).teamIcon).toBeNull();
  });

  it('picks the sharpest https logo size', () => {
    expect(
      teamIconUrl({ image_34: 'https://x.slack-edge.com/34.png', image_88: 'https://x.slack-edge.com/88.png' }),
    ).toBe('https://x.slack-edge.com/88.png');
    expect(teamIconUrl({ image_132: 'javascript:alert(1)', image_68: 'http://x.slack-edge.com/68.png' })).toBeNull();
    expect(teamIconUrl({})).toBeNull();
  });

  it('parses the team domain from auth.test urls', () => {
    expect(teamDomainFromUrl('https://9hdigital.slack.com/')).toBe('9hdigital');
    expect(teamDomainFromUrl('https://acme.enterprise.slack.com/')).toBe('acme');
    expect(teamDomainFromUrl('https://example.com/')).toBeNull();
    expect(teamDomainFromUrl(undefined)).toBeNull();
  });
});
