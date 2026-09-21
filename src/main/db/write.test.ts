import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SlackFile } from '../slack/types';
import { getMessageRevisions, getThread, listConversations } from './read';
import { assertFtsIntegrity, ftsRowids, msg, seededDb, tsAt } from './test-helpers';
import type { DB, MessageRow } from './types';
import {
  getFileRow,
  getStoredThreadInfo,
  getSyncState,
  listActiveThreads,
  listDownloadCandidates,
  failureBackoffMs,
  markFileDownloaded,
  markFileFailed,
  markFileRemoved,
  markFileSkipped,
  markFileUnavailable,
  requeueFile,
  listDownloadedFilesBefore,
  reindexAll,
  setSyncState,
  upsertConversations,
  upsertCustomEmoji,
  upsertMessages,
  upsertUsers,
} from './write';
import { listCustomEmoji } from './read';

const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-archive-files-'));
afterAll(() => fs.rmSync(filesDir, { recursive: true, force: true }));

function row(db: DB, ts: string, conv = 'C1'): MessageRow {
  return db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND ts = ?').get(conv, ts) as MessageRow;
}

function upsert(db: DB, msgs: Parameters<typeof upsertMessages>[2], source: 'api' | 'import' = 'api', conv = 'C1') {
  return upsertMessages(db, conv, msgs, source, { filesDir });
}

describe('upsertMessages: insert and update', () => {
  it('inserts with derived columns', () => {
    const db = seededDb();
    const ts = tsAt(1, 123);
    const res = upsert(db, [
      msg(ts, 'hi <@U2> see <https://x.io|docs>', {
        thread_ts: ts,
        reply_count: 2,
        latest_reply: tsAt(3),
        reply_users: ['U2', 'U3'],
        reactions: [{ name: 'tada', count: 2, users: ['U1', 'U2'] }],
        files: [{ id: 'F1', name: 'a.png', mimetype: 'image/png', url_private: 'https://files/a.png' }],
      }),
    ]);
    expect(res).toEqual({ inserted: 1, updated: 0, revisions: 0, skipped: 0 });
    const r = row(db, ts);
    expect(r).toMatchObject({
      time: Math.floor(Number(ts)),
      thread_ts: ts,
      is_reply: 0,
      user_id: 'U1',
      text: 'hi <@U2> see <https://x.io|docs>',
      plain_text: 'hi @Bob Brown see docs https://x.io\na.png', // empty display name → real name
      reply_count: 2,
      latest_reply: tsAt(3),
      has_files: 1,
      has_links: 1,
      has_images: 1,
      is_deleted: 0,
      source: 'api',
    });
    expect(JSON.parse(r.reply_users)).toEqual(['U2', 'U3']);
    expect(JSON.parse(r.reactions)).toEqual([{ name: 'tada', count: 2, users: ['U1', 'U2'] }]);
    expect(r.first_seen_at).toBe(r.updated_at);
  });

  it('marks replies and skips messages without a valid ts', () => {
    const db = seededDb();
    const parent = tsAt(1);
    const res = upsert(db, [
      msg(parent, 'p', { thread_ts: parent }),
      msg(tsAt(2), 'r', { thread_ts: parent }),
      msg('not-a-ts', 'bad'),
      { ts: undefined as unknown as string, text: 'bad' },
    ]);
    expect(res.inserted).toBe(2);
    expect(row(db, tsAt(2)).is_reply).toBe(1);
    expect(row(db, parent).is_reply).toBe(0);
  });

  it('derives row ids from ts (µs) and bumps cross-conversation collisions', () => {
    const db = seededDb();
    const ts = '1700000000.123456';
    upsert(db, [msg(ts, 'in C1')], 'api', 'C1');
    upsert(db, [msg(ts, 'same ts in C2')], 'api', 'C2');
    upsert(db, [msg('1700000000.123457', 'next µs in D1')], 'api', 'D1');
    expect(row(db, ts, 'C1').id).toBe(1700000000123456);
    expect(row(db, ts, 'C2').id).toBe(1700000000123457);
    expect(row(db, '1700000000.123457', 'D1').id).toBe(1700000000123458);
    upsert(db, [msg(ts, 'edited in C2', { edited: { ts: '1700000001.000000' } })], 'api', 'C2');
    expect(row(db, ts, 'C2')).toMatchObject({ id: 1700000000123457, text: 'edited in C2' });
  });

  it('processes a batch in ascending ts order regardless of input order', () => {
    const db = seededDb();
    const res = upsert(db, [msg(tsAt(3), 'c'), msg(tsAt(1), 'a'), msg(tsAt(2), 'b')]);
    expect(res.inserted).toBe(3);
    const ids = (db.prepare('SELECT id, ts FROM messages ORDER BY id').all() as { ts: string }[]).map((r) => r.ts);
    expect(ids).toEqual([tsAt(1), tsAt(2), tsAt(3)]);
    assertFtsIntegrity(db);
  });

  it('is idempotent: same input twice changes nothing', () => {
    const db = seededDb();
    const input = [msg(tsAt(1), 'hello', { reactions: [{ name: 'x', count: 1, users: ['U2'] }] })];
    upsert(db, input);
    const before = row(db, tsAt(1));
    expect(upsert(db, input)).toEqual({ inserted: 0, updated: 0, revisions: 0, skipped: 0 });
    expect(row(db, tsAt(1))).toEqual(before);
  });

  it('takes incoming text and records the previous version as a revision', () => {
    const db = seededDb();
    const ts = tsAt(1);
    upsert(db, [msg(ts, 'first draft')]);
    const firstSeen = row(db, ts).first_seen_at;
    const res = upsert(db, [msg(ts, 'final text', { edited: { user: 'U1', ts: tsAt(5) } })], 'import');
    expect(res).toEqual({ inserted: 0, updated: 1, revisions: 1, skipped: 0 });
    const r = row(db, ts);
    expect(r).toMatchObject({ text: 'final text', edited_ts: tsAt(5), source: 'import', first_seen_at: firstSeen });
    expect(getMessageRevisions(db, 'C1', ts)).toEqual([
      { text: 'first draft', editedTs: null, seenAt: expect.any(Number) },
    ]);
  });

  it('takes incoming reactions (including removals)', () => {
    const db = seededDb();
    upsert(db, [msg(tsAt(1), 'x', { reactions: [{ name: 'a', count: 1, users: ['U1'] }] })]);
    expect(upsert(db, [msg(tsAt(1), 'x', { reactions: [] })]).updated).toBe(1);
    expect(row(db, tsAt(1)).reactions).toBe('[]');
  });

  it('does not regress an edit when an older snapshot arrives later', () => {
    const db = seededDb();
    const ts = tsAt(1);
    upsert(db, [msg(ts, 'edited text', { edited: { user: 'U1', ts: tsAt(9) } })]);
    const res = upsert(db, [msg(ts, 'original text')], 'import');
    expect(res.revisions).toBe(0);
    expect(row(db, ts)).toMatchObject({ text: 'edited text', edited_ts: tsAt(9) });
  });

  it('never blanks out stored text with an empty or locked copy', () => {
    const db = seededDb();
    upsert(db, [msg(tsAt(1), 'keep me'), msg(tsAt(2), 'keep me too')]);
    upsert(db, [msg(tsAt(1), ''), msg(tsAt(2), 'locked', { is_locked: true })]);
    expect(row(db, tsAt(1)).text).toBe('keep me');
    expect(row(db, tsAt(2)).text).toBe('keep me too');
  });
});

describe('upsertMessages: tombstones', () => {
  it('keeps stored text/raw/files and flags is_deleted', () => {
    const db = seededDb();
    const ts = tsAt(1);
    upsert(db, [msg(ts, 'secret plan', { files: [{ id: 'F1', name: 'plan.txt', url_private: 'https://f/1' }] })]);
    const before = row(db, ts);
    const res = upsert(db, [
      {
        type: 'message',
        subtype: 'tombstone',
        ts,
        text: 'This message was deleted.',
        user: 'USLACKBOT',
        hidden: true,
        files: [{ id: 'F1', mode: 'tombstone' }],
      },
    ]);
    expect(res).toEqual({ inserted: 0, updated: 1, revisions: 0, skipped: 0 });
    const after = row(db, ts);
    expect(after).toMatchObject({ text: 'secret plan', raw: before.raw, user_id: 'U1', is_deleted: 1, subtype: null });
    expect(getFileRow(db, 'F1')).toMatchObject({ name: 'plan.txt', url_private: 'https://f/1' });
    expect(ftsRowids(db, '"secret"')).toEqual([after.id]);
  });

  it('recognizes hidden "This message was deleted." as a tombstone and keeps thread metadata growing', () => {
    const db = seededDb();
    const ts = tsAt(1);
    upsert(db, [msg(ts, 'parent', { thread_ts: ts, reply_count: 1, latest_reply: tsAt(2) })]);
    upsert(db, [
      {
        ts,
        subtype: 'hidden',
        text: 'This message was deleted.',
        thread_ts: ts,
        reply_count: 3,
        latest_reply: tsAt(4),
      },
    ]);
    expect(row(db, ts)).toMatchObject({ text: 'parent', is_deleted: 1, reply_count: 3, latest_reply: tsAt(4) });
  });

  it('inserts an unseen tombstone as deleted with no searchable text; later real content fills it in', () => {
    const db = seededDb();
    const ts = tsAt(1);
    upsert(db, [{ ts, subtype: 'tombstone', text: 'This message was deleted.', user: 'USLACKBOT' }]);
    expect(row(db, ts)).toMatchObject({ is_deleted: 1, plain_text: '' });
    const res = upsert(db, [msg(ts, 'recovered from export')], 'import');
    expect(res.revisions).toBe(0);
    expect(row(db, ts)).toMatchObject({ text: 'recovered from export', is_deleted: 1, user_id: 'U1' });
  });
});

describe('upsertMessages: reply metadata', () => {
  it('never decreases reply_count and keeps the later latest_reply', () => {
    const db = seededDb();
    const ts = tsAt(1);
    upsert(db, [msg(ts, 'p', { thread_ts: ts, reply_count: 5, latest_reply: tsAt(10), reply_users: ['U2'] })]);
    upsert(db, [msg(ts, 'p', { thread_ts: ts, reply_count: 2, latest_reply: tsAt(3), reply_users: ['U3'] })], 'import');
    const r = row(db, ts);
    expect(r.reply_count).toBe(5);
    expect(r.latest_reply).toBe(tsAt(10));
    expect(JSON.parse(r.reply_users)).toEqual(['U2', 'U3']);
    upsert(db, [msg(ts, 'p', { thread_ts: ts, reply_count: 6, latest_reply: tsAt(12) })]);
    expect(row(db, ts)).toMatchObject({ reply_count: 6, latest_reply: tsAt(12) });
  });

  it('keeps thread_ts when a sparser source omits it', () => {
    const db = seededDb();
    upsert(db, [msg(tsAt(2), 'reply', { thread_ts: tsAt(1) })]);
    upsert(db, [msg(tsAt(2), 'reply')], 'import');
    expect(row(db, tsAt(2))).toMatchObject({ thread_ts: tsAt(1), is_reply: 1 });
  });
});

describe('upsertMessages: files', () => {
  const good: SlackFile = {
    id: 'F1',
    name: 'photo.jpg',
    title: 'Photo',
    mimetype: 'image/jpeg',
    filetype: 'jpg',
    size: 1234,
    url_private: 'https://files/photo.jpg',
    url_private_download: 'https://files/photo.jpg?dl=1',
    thumb_360: 'https://files/t360.jpg',
    thumb_720: 'https://files/t720.jpg',
    original_w: 800,
    original_h: 600,
    permalink: 'https://slack/p/F1',
    created: 1700000000,
    user: 'U1',
  };

  it('stores metadata and links files to the message in order', () => {
    const db = seededDb();
    upsert(db, [msg(tsAt(1), 'files', { files: [good, { id: 'F2', name: 'b.txt', url_private: 'https://f/b' }] })]);
    expect(getFileRow(db, 'F1')).toMatchObject({
      name: 'photo.jpg',
      mimetype: 'image/jpeg',
      size: 1234,
      thumb_url: 'https://files/t720.jpg',
      width: 800,
      height: 600,
      created: 1700000000,
      user_id: 'U1',
      download_status: 'pending',
    });
    expect(db.prepare('SELECT file_id, position FROM message_files ORDER BY position').all()).toEqual([
      { file_id: 'F1', position: 0 },
      { file_id: 'F2', position: 1 },
    ]);
  });

  it('a hidden_by_limit stub never overwrites a good file row', () => {
    const db = seededDb();
    upsert(db, [msg(tsAt(1), 'f', { files: [good] })]);
    upsert(db, [msg(tsAt(1), 'f', { files: [{ id: 'F1', mode: 'hidden_by_limit' }] })], 'import');
    expect(getFileRow(db, 'F1')).toMatchObject({
      name: 'photo.jpg',
      url_private: good.url_private,
      download_status: 'pending',
    });
    expect(row(db, tsAt(1))).toMatchObject({ has_files: 1, has_images: 1 });
  });

  it('inserts stubs and nameless/urlless files as unavailable only when absent', () => {
    const db = seededDb();
    upsert(db, [
      msg(tsAt(1), 'f', {
        files: [
          { id: 'F7', mode: 'hidden_by_limit', created: 1690000000 },
          { id: 'F8', mode: 'tombstone' },
          { id: 'F9', title: 'no name or url' },
          { id: 'F10', name: 'gdoc', mode: 'external', url_private: 'https://docs.google.com/x' },
          { id: 'F11', name: 'ext', is_external: true, url_private: 'https://dropbox/x' },
        ],
      }),
    ]);
    for (const id of ['F7', 'F8', 'F9', 'F10', 'F11']) expect(getFileRow(db, id)?.download_status).toBe('unavailable');
  });

  it('a stub row upgrades to pending when a usable copy arrives', () => {
    const db = seededDb();
    upsert(db, [msg(tsAt(1), 'f', { files: [{ id: 'F1', mode: 'hidden_by_limit' }] })]);
    upsert(db, [msg(tsAt(1), 'f', { files: [good] })]);
    expect(getFileRow(db, 'F1')).toMatchObject({ download_status: 'pending', name: 'photo.jpg' });
  });

  it('never resets a done download unless the local copy is missing', () => {
    const db = seededDb();
    upsert(db, [msg(tsAt(1), 'f', { files: [good, { ...good, id: 'F2', name: 'gone.jpg' }] })]);
    fs.mkdirSync(path.join(filesDir, 'F1'), { recursive: true });
    fs.writeFileSync(path.join(filesDir, 'F1', 'photo.jpg'), 'x');
    markFileDownloaded(db, 'F1', 'F1/photo.jpg', 'F1/thumb.jpg');
    markFileDownloaded(db, 'F2', 'F2/gone.jpg'); // never written to disk
    upsert(db, [
      msg(tsAt(1), 'f', {
        files: [
          { ...good, title: 'Renamed' },
          { ...good, id: 'F2', name: 'gone.jpg', title: 'x' },
        ],
      }),
    ]);
    expect(getFileRow(db, 'F1')).toMatchObject({
      download_status: 'done',
      local_path: 'F1/photo.jpg',
      title: 'Renamed',
    });
    expect(getFileRow(db, 'F2')).toMatchObject({ download_status: 'pending' });
  });

  it('lists downloadable files oldest first and tracks status changes', () => {
    const db = seededDb();
    upsert(db, [
      msg(tsAt(1), 'f', {
        files: [
          { ...good, id: 'FNEW', created: 1700000500 },
          { ...good, id: 'FOLD', created: 1600000000 },
          { id: 'FSTUB', mode: 'hidden_by_limit' },
          { id: 'FNOURL', name: 'local-only.txt' },
        ],
      }),
    ]);
    const now = 1_700_000_000_000;
    expect(listDownloadCandidates(db, { now }).map((f) => f.id)).toEqual(['FOLD', 'FNEW']);
    expect(listDownloadCandidates(db, { now, limit: 1 }).map((f) => f.id)).toEqual(['FOLD']);
    markFileFailed(db, 'FOLD', 'HTTP 500', now);
    expect(getFileRow(db, 'FOLD')).toMatchObject({
      download_status: 'failed',
      download_error: 'HTTP 500',
      download_attempts: 1,
      next_attempt_at: now + failureBackoffMs(1),
    });
    // Backing off: not eligible until next_attempt_at, then eligible again.
    expect(listDownloadCandidates(db, { now: now + 1000 }).map((f) => f.id)).toEqual(['FNEW']);
    expect(listDownloadCandidates(db, { now: now + failureBackoffMs(1) }).map((f) => f.id)).toEqual(['FOLD', 'FNEW']);
    markFileDownloaded(db, 'FOLD', 'FOLD/photo.jpg');
    expect(getFileRow(db, 'FOLD')).toMatchObject({
      download_status: 'done',
      download_error: null,
      download_attempts: 2,
      next_attempt_at: null,
      thumb_local_path: null,
    });
    markFileDownloaded(db, 'FOLD', 'FOLD/photo.jpg', 'FOLD/thumb.jpg');
    markFileDownloaded(db, 'FOLD', 'FOLD/photo.jpg');
    expect(getFileRow(db, 'FOLD')?.thumb_local_path).toBe('FOLD/thumb.jpg');
    markFileDownloaded(db, 'FOLD', 'FOLD/photo.jpg', null);
    expect(getFileRow(db, 'FOLD')?.thumb_local_path).toBeNull();
  });

  it('never strands failed files: backoff grows but is capped at a week (pitfall 7)', () => {
    expect(failureBackoffMs(1)).toBe(3_600_000);
    expect(failureBackoffMs(2)).toBe(7_200_000);
    expect(failureBackoffMs(50)).toBe(7 * 86_400_000);
    const db = seededDb();
    upsert(db, [msg(tsAt(1), 'f', { files: [{ ...good, id: 'FX', created: 1 }] })]);
    let now = 1_700_000_000_000;
    for (let i = 0; i < 12; i++) {
      markFileFailed(db, 'FX', 'HTTP 500', now);
      now = getFileRow(db, 'FX')!.next_attempt_at!;
      expect(listDownloadCandidates(db, { now }).map((f) => f.id)).toEqual(['FX']);
    }
  });

  it('keeps policy/size skips eligible for re-evaluation, but not files the user removed', () => {
    const db = seededDb();
    upsert(db, [
      msg(tsAt(1), 'f', {
        files: [
          { ...good, id: 'FPOL', created: 1 },
          { ...good, id: 'FBIG', created: 2 },
          { ...good, id: 'FREM', created: 3 },
          { ...good, id: 'FGONE', created: 4 },
        ],
      }),
    ]);
    markFileSkipped(db, 'FPOL', 'policy', 'Videos aren’t downloaded');
    markFileSkipped(db, 'FBIG', 'too_large', 'Larger than 25 MB');
    markFileDownloaded(db, 'FREM', 'FREM/photo.jpg');
    markFileRemoved(db, 'FREM');
    markFileUnavailable(db, 'FGONE', 'Deleted in Slack');
    expect(listDownloadCandidates(db).map((f) => f.id)).toEqual(['FPOL', 'FBIG']);
    expect(getFileRow(db, 'FREM')).toMatchObject({
      download_status: 'skipped',
      skip_reason: 'removed',
      local_path: null,
    });
    // "Retry" from the UI requeues anything not done.
    expect(requeueFile(db, 'FGONE')).toBe(true);
    expect(requeueFile(db, 'FREM')).toBe(true);
    expect(listDownloadCandidates(db).map((f) => f.id)).toEqual(['FPOL', 'FBIG', 'FREM', 'FGONE']);
  });

  it('lists downloaded files created before a cutoff (cleanup)', () => {
    const db = seededDb();
    upsert(db, [
      msg(tsAt(1), 'f', {
        files: [
          { ...good, id: 'FA', created: 100 },
          { ...good, id: 'FB', created: 300 },
        ],
      }),
    ]);
    markFileDownloaded(db, 'FA', 'FA/a.jpg');
    markFileDownloaded(db, 'FB', 'FB/b.jpg');
    expect(listDownloadedFilesBefore(db, 200).map((f) => f.id)).toEqual(['FA']);
  });
});

describe('FTS sync', () => {
  it('stays in sync through inserts, edits and reindexAll', () => {
    const db = seededDb();
    upsert(db, [msg(tsAt(1), 'alpha bravo'), msg(tsAt(2), 'mention <@U9>')]);
    const id1 = row(db, tsAt(1)).id;
    const id2 = row(db, tsAt(2)).id;
    expect(ftsRowids(db, '"alpha"')).toEqual([id1]);

    upsert(db, [msg(tsAt(1), 'charlie delta', { edited: { ts: tsAt(3) } })]);
    expect(ftsRowids(db, '"alpha"')).toEqual([]);
    expect(ftsRowids(db, '"charlie"')).toEqual([id1]);
    assertFtsIntegrity(db);

    // U9 only becomes known later; plain_text is stale until reindexAll.
    expect(ftsRowids(db, '"zed"')).toEqual([]);
    upsertUsers(db, [{ id: 'U9', name: 'zed', profile: { display_name: 'Zed' } }]);
    expect(reindexAll(db)).toBe(1);
    expect(ftsRowids(db, '"zed"')).toEqual([id2]);
    expect(reindexAll(db)).toBe(0);
    assertFtsIntegrity(db);
  });

  it('reindexes across multiple batches', () => {
    const db = seededDb();
    const msgs = Array.from({ length: 4500 }, (_, i) => msg(tsAt(i), `n${i} <@U9>`));
    upsert(db, msgs);
    upsertUsers(db, [{ id: 'U9', name: 'zed' }]);
    expect(reindexAll(db)).toBe(4500);
    expect(ftsRowids(db, '"zed"')).toHaveLength(4500);
    assertFtsIntegrity(db);
  });
});

describe('users and conversations', () => {
  it('does not blank names when a sparser user copy arrives', () => {
    const db = seededDb();
    upsertUsers(db, [{ id: 'U1', name: 'alice' }]);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get('U1') as Record<string, unknown>;
    expect(u).toMatchObject({
      name: 'alice',
      real_name: 'Alice Anderson',
      display_name: 'Ali',
      avatar_url: 'https://a/72.png',
    });
  });

  it('merges conversation copies without downgrading known fields', () => {
    const db = seededDb();
    upsertConversations(db, [
      { id: 'C1', name: 'general' },
      { id: 'G1', name: 'secret-plans' },
    ]);
    const c1 = db.prepare('SELECT * FROM conversations WHERE id = ?').get('C1') as Record<string, unknown>;
    expect(c1).toMatchObject({ type: 'channel', topic: 'Company-wide', purpose: 'All hands', is_member: 1 });
    const g1 = db.prepare('SELECT type, is_archived FROM conversations WHERE id = ?').get('G1');
    expect(g1).toEqual({ type: 'private_channel', is_archived: 1 });
    // Explicit flags do update the type.
    upsertConversations(db, [{ id: 'G1', is_mpim: true, members: ['USELF', 'U1'] }]);
    expect(db.prepare('SELECT type FROM conversations WHERE id = ?').get('G1')).toEqual({ type: 'mpim' });
  });

  it('derives the DM partner from members when `user` is absent, incl. self-DMs', () => {
    const db = seededDb();
    upsertConversations(db, [
      { id: 'D7', is_im: true, members: ['USELF', 'U2'] },
      { id: 'D8', is_im: true, members: ['USELF'] },
    ]);
    const dm = (id: string) =>
      (db.prepare('SELECT dm_user_id FROM conversations WHERE id = ?').get(id) as { dm_user_id: string }).dm_user_id;
    expect(dm('D7')).toBe('U2');
    expect(dm('D8')).toBe('USELF');
    expect(listConversations(db).find((c) => c.id === 'D8')?.label).toBe('You');
  });
});

describe('sync state and thread bookkeeping', () => {
  it('round-trips sync state patches', () => {
    const db = seededDb();
    expect(getSyncState(db, 'C1')).toBeNull();
    setSyncState(db, 'C1', { latest_ts: tsAt(5), backfill_complete: 1 });
    setSyncState(db, 'C1', { last_error: 'not_in_channel', last_synced_at: 42 });
    expect(getSyncState(db, 'C1')).toEqual({
      conversation_id: 'C1',
      latest_ts: tsAt(5),
      oldest_ts: null,
      backfill_complete: true,
      last_synced_at: 42,
      last_error: 'not_in_channel',
    });
    setSyncState(db, 'C1', { backfill_complete: false, last_error: null });
    expect(getSyncState(db, 'C1')).toMatchObject({ backfill_complete: false, last_error: null, latest_ts: tsAt(5) });
  });

  it('lists active threads and reports stored thread info', () => {
    const db = seededDb();
    upsert(db, [
      msg(tsAt(1), 'old thread', { thread_ts: tsAt(1), reply_count: 1, latest_reply: tsAt(2) }),
      msg(tsAt(2), 'old reply', { thread_ts: tsAt(1) }),
      msg(tsAt(10), 'active', { thread_ts: tsAt(10), reply_count: 3, latest_reply: tsAt(100) }),
      msg(tsAt(11), 'r1', { thread_ts: tsAt(10) }),
      msg(tsAt(12), 'no thread'),
    ]);
    expect(listActiveThreads(db, 'C1', tsAt(50))).toEqual([
      { thread_ts: tsAt(10), latest_reply: tsAt(100), reply_count: 3 },
    ]);
    expect(listActiveThreads(db, 'C1', String(Number(tsAt(0)) | 0)).map((t) => t.thread_ts)).toEqual([
      tsAt(10),
      tsAt(1),
    ]);
    expect(getStoredThreadInfo(db, 'C1', tsAt(10))).toEqual({
      reply_count: 3,
      latest_reply: tsAt(100),
      stored_replies: 1,
    });
    expect(getStoredThreadInfo(db, 'C1', tsAt(99))).toBeNull();
    expect(getThread(db, 'C1', tsAt(10)).replies.map((m) => m.ts)).toEqual([tsAt(11)]);
  });
});

describe('custom emoji', () => {
  it('stores urls and aliases and resolves alias chains', () => {
    const db = seededDb();
    expect(
      upsertCustomEmoji(db, {
        partyparrot: 'https://emoji/parrot.gif',
        parrot: 'alias:partyparrot',
        pp: 'alias:parrot',
        thumbsup_alias: 'alias:thumbsup',
        loop_a: 'alias:loop_b',
        loop_b: 'alias:loop_a',
      }),
    ).toBe(6);
    expect(listCustomEmoji(db)).toEqual({
      partyparrot: 'https://emoji/parrot.gif',
      parrot: 'https://emoji/parrot.gif',
      pp: 'https://emoji/parrot.gif',
    });
  });
});
