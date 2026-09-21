/**
 * Sync-completeness findings of the previous implementation (PLAN §12, items 6 and 8) and the
 * defaults PLAN §5.2 asks for.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMessageRevisions, getSyncState, openDb, type DB } from '../db';
import { SlackHttpError } from './errors';
import { FAKE_BASE_URL, FAKE_TOKEN, FakeSlack, fakeClock } from './fake-slack';
import { DEFAULT_OVERLAP_SECONDS, runApiSync, type ApiSyncOptions } from './sync';
import type { SlackMessage } from './types';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const HOUR = 3600;
const DAY = 86_400;

const ts = (secondsAgo: number, micros = 100) => `${NOW_S - secondsAgo}.${String(micros).padStart(6, '0')}`;
const msg = (t: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage => ({
  type: 'message',
  ts: t,
  user: 'U1',
  text,
  ...extra,
});

let db: DB;
let fake: FakeSlack;
let filesDir: string;
let logs: string[];
let now = NOW;

beforeEach(() => {
  db = openDb(':memory:');
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-sync-pitfalls-'));
  logs = [];
  now = NOW;
  fake = new FakeSlack();
  fake.now = () => now;
  fake.users = [
    { id: 'USELF', name: 'me' },
    { id: 'U1', name: 'alice' },
  ];
  fake.conversations = [
    { id: 'C1', name: 'general', is_channel: true },
    { id: 'C2', name: 'broken', is_channel: true },
    { id: 'C3', name: 'random', is_channel: true },
    { id: 'C4', name: 'design', is_channel: true },
  ];
});

afterEach(() => {
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
  expect(logs.join('\n')).not.toContain(FAKE_TOKEN);
});

function sync(extra: Partial<ApiSyncOptions> = {}) {
  const clock = fakeClock();
  return runApiSync({
    db,
    token: FAKE_TOKEN,
    baseUrl: FAKE_BASE_URL,
    fetch: fake.fetch,
    filesDir,
    attachmentPolicy: 'none',
    now: () => now,
    log: (l) => logs.push(l),
    clientOptions: { throttle: false, sleep: clock.sleep, now: clock.now, random: () => 0.5, maxAttempts: 2 },
    ...extra,
  });
}

describe('defaults (PLAN §5.2)', () => {
  it('re-reads 7 days of history on incremental syncs', () => {
    expect(DEFAULT_OVERLAP_SECONDS).toBe(7 * DAY);
  });

  it('catches an edit to a 5-day-old message with the default overlap', async () => {
    fake.addMessage('C1', msg(ts(5 * DAY), 'draft plan'));
    fake.addMessage('C1', msg(ts(HOUR), 'latest'));
    await sync();
    fake.editMessage('C1', ts(5 * DAY), 'final plan', ts(10));
    const stats = await sync();
    expect(stats.revisions).toBe(1);
    expect(getMessageRevisions(db, 'C1', ts(5 * DAY)).map((r) => r.text)).toEqual(['draft plan']);
  });
});

describe('thread reply edits (6)', () => {
  it('are picked up when the parent is older than the overlap but the thread is still active', async () => {
    const parent = ts(20 * DAY);
    fake.addMessage('C1', msg(parent, 'old question', { thread_ts: parent }));
    const reply = fake.addReply('C1', parent, msg(ts(2 * DAY), 'first answer'));
    fake.addMessage('C1', msg(ts(HOUR), 'recent chatter'));
    await sync();
    fake.editMessage('C1', reply.ts, 'corrected answer', ts(60));
    const stats = await sync();
    expect(stats.revisions).toBe(1);
    expect(getMessageRevisions(db, 'C1', reply.ts).map((r) => r.text)).toEqual(['first answer']);
  });
});

describe('one broken conversation (8)', () => {
  it('never aborts the run, and goes last on the next run', async () => {
    fake.addMessage('C1', msg(ts(HOUR), 'general news'));
    fake.addMessage('C3', msg(ts(HOUR), 'random news'));
    fake.addMessage('C4', msg(ts(HOUR), 'design news'));
    fake.inject('conversations.history', { status: 500 }, 1000, (p) => p.channel === 'C2');
    const stats = await sync();
    expect(stats).toMatchObject({ conversations: 3, errors: 1, messagesInserted: 3 });
    expect(getSyncState(db, 'C2')!.last_error).toMatch(/HTTP 500/);

    const before = fake.calls.length;
    await sync();
    const order = fake.calls
      .slice(before)
      .filter((c) => c.method === 'conversations.history')
      .map((c) => c.params.channel);
    expect(order.at(-1)).toBe('C2');
  });

  it('aborts as "Slack unreachable" only when several conversations in a row get no answer', async () => {
    fake.inject('conversations.history', { network: 'ECONNRESET' }, 1000);
    const err = await sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackHttpError);
    expect(fake.callsOf('conversations.history').map((c) => c.params.channel)).toEqual([
      'C1',
      'C1',
      'C2',
      'C2',
      'C3',
      'C3',
    ]);
  });
});
