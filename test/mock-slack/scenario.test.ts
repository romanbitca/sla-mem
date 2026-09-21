/**
 * The PLAN §13 scenario, against the mock Slack over real HTTP (never real Slack):
 * first sync → incremental (no dupes, few calls) → edit (revision) → deletion (tombstone keeps the
 * text) → late thread reply → a file that first fails, then succeeds. Plus the §11 Stage 3
 * acceptance checks that can be automated: Free-plan window, 429 waited out, invalid session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFileRow, getMessageRevisions, getThread, openDb, type DB } from '../../src/main/db';
import { runApiSync, type ApiSyncOptions } from '../../src/main/slack/sync';
import { startMockSlack, type MockSlack } from './server';

let mock: MockSlack;
let dir: string;
let db: DB;

beforeAll(async () => {
  mock = await startMockSlack({ messages: 1_500, seed: 11 });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-scenario-'));
  db = openDb(path.join(dir, 'archive.db'));
});

afterAll(async () => {
  db.close();
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function sync(extra: Partial<ApiSyncOptions> = {}) {
  return runApiSync({
    db,
    token: mock.session.token,
    cookie: mock.session.cookie,
    baseUrl: mock.apiBaseUrl,
    filesDir: path.join(dir, 'files'),
    attachmentPolicy: 'standard',
    clientOptions: { throttle: false },
    ...extra,
  });
}

const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
const NOW_S = Math.floor(Date.now() / 1000);

describe('mock Slack scenario (PLAN §13)', () => {
  it('first sync: archives the 90-day window, threads and files', async () => {
    const stats = await sync();
    expect(stats.conversations).toBeGreaterThan(10);
    expect(stats.messagesInserted).toBeGreaterThan(200);
    expect(stats.errors).toBe(0);
    // Slack Free: nothing older than 90 days comes back.
    expect(count('SELECT count(*) AS n FROM messages WHERE time < ?', NOW_S - 91 * 86_400)).toBe(0);
    // Threads are complete: every parent has as many stored replies as Slack says.
    const incomplete = count(
      `SELECT count(*) AS n FROM messages p WHERE p.reply_count > 0 AND p.thread_ts = p.ts
         AND p.reply_count > (SELECT count(*) FROM messages r WHERE r.conversation_id = p.conversation_id AND r.thread_ts = p.ts AND r.ts <> p.ts)`,
    );
    expect(incomplete).toBe(0);
    expect(stats.filesDownloaded).toBeGreaterThan(0);
  });

  it('second sync right after: 0 new, 0 duplicates, few API calls', async () => {
    const before = count('SELECT count(*) AS n FROM messages');
    const stats = await sync();
    expect(stats).toMatchObject({ messagesInserted: 0, revisions: 0, errors: 0 });
    expect(count('SELECT count(*) AS n FROM messages')).toBe(before);
    // One history page per conversation plus the fixed calls (auth, users, list, emoji…).
    expect(stats.apiCalls).toBeLessThan(stats.conversations * 2 + 20);
  });

  it('an edit becomes a revision, a late reply to an old thread is picked up', async () => {
    const changes = (await (await fetch(`${mock.url}/_mock/mutate`, { method: 'POST' })).json()) as Record<
      string,
      string
    >;
    const stats = await sync();
    expect(stats.revisions).toBeGreaterThanOrEqual(1);
    expect(getMessageRevisions(db, 'C0DEMOGENL', changes.edited)).toHaveLength(1);
    if (changes.repliedTo) {
      expect(getThread(db, 'C0DEMOENGR', changes.repliedTo).replies.map((r) => r.text)).toContain(
        'Late reply from the mock',
      );
    }
    expect(count("SELECT count(*) AS n FROM messages WHERE text LIKE 'New DM from the mock%'")).toBe(1);
  });

  it('a deletion keeps the archived text and flags it', async () => {
    const msgs = mock.fake.history.get('C0DEMORAND') ?? [];
    const victim = [...msgs].reverse().find((m) => m.user && !m.subtype && !m.files && (m.text ?? '').length > 10)!;
    const original = victim.text;
    Object.assign(victim, {
      subtype: 'tombstone',
      text: 'This message was deleted.',
      user: 'USLACKBOT',
      files: undefined,
    });
    await sync();
    const row = db
      .prepare("SELECT text, is_deleted FROM messages WHERE conversation_id = 'C0DEMORAND' AND ts = ?")
      .get(victim.ts);
    expect(row).toEqual({ text: original, is_deleted: 1 });
  });

  it('a file that fails is retried later and then archived', async () => {
    const file = [...mock.fake.files.keys()].find((k) => k.includes('/files-pri/') && k.includes('/download/'))!;
    const row = db.prepare('SELECT id FROM files WHERE url_private_download = ?').get(file) as
      { id: string } | undefined;
    expect(row).toBeDefined();
    const saved = mock.fake.files.get(file)!;
    db.prepare("UPDATE files SET download_status = 'pending', local_path = NULL WHERE id = ?").run(row!.id);
    mock.fake.files.set(file, { body: 'upstream error', status: 500 });
    await sync({ clientOptions: { throttle: false, maxAttempts: 1 } });
    expect(getFileRow(db, row!.id)).toMatchObject({ download_status: 'failed' });
    mock.fake.files.set(file, saved);
    db.prepare('UPDATE files SET next_attempt_at = 0 WHERE id = ?').run(row!.id); // backoff elapsed
    await sync();
    expect(getFileRow(db, row!.id)).toMatchObject({ download_status: 'done' });
  });

  it('waits out a 429 with Retry-After', async () => {
    await fetch(`${mock.url}/_mock/fail`, {
      method: 'POST',
      body: JSON.stringify({ method: 'users.list', status: 429, retryAfter: 1 }),
    });
    const started = Date.now();
    const stats = await sync();
    expect(stats.errors).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('a signed-out session aborts cleanly with Slack’s code', async () => {
    const err = await sync({ cookie: 'xoxd-not-the-session' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid_auth' });
    expect(String((err as Error).message)).not.toContain(mock.session.token);
  });
});
