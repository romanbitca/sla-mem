/**
 * End-to-end import of test/fixtures/export-basic, a small slackdump-style export:
 *  - users.json: self (sam), alice, bob (deleted), carol, deploybot (bot)
 *  - channels.json: #general; groups.json: #leadership (private); dms.json: DMs with alice and
 *    carol (folders named by id); mpims.json: one group DM; canvases.json and
 *    integration_logs.json (ignored)
 *  - general: 3 day files with a thread whose replies span two days, a thread_broadcast, an
 *    edited message, reactions, mentions/links/code/emoji, an attachment-only and a blocks-only
 *    bot message, a tombstone thread parent, a hidden_by_limit file stub and an image whose
 *    copy sits in `__uploads/` (mattermost layout)
 *  - leadership: a PDF whose copy sits in `leadership/attachments/` (standard layout)
 *  - C0ORPHAN01/: unlisted folder named by id (imported); notes/: unlisted, not an id (skipped)
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getConversation,
  getFileRow,
  getMessageRevisions,
  getMessages,
  getMeta,
  getThread,
  listUsers,
  openDb,
  search,
  setMeta,
  upsertUsers,
  type DB,
} from '../db';
import type { SyncProgress } from '../../shared/types';
import type { SlackMessage } from '../slack/types';
import { importSlackExport } from './slack-export';
import { FIXTURE_DIR, buildZip, copyFixture, readJson, tempDir, writeJson, zipInputsFromDir } from './test-helpers';

const GENERAL = 'C0GENERAL1';
const THREAD_TS = '1709290800.000200';

const EXPECTED = {
  conversations: 6,
  users: 5,
  usersSynthesized: 0,
  dayFiles: 8,
  messagesInserted: 21,
  messagesUpdated: 0,
  revisions: 0,
  filesCopied: 2,
  skippedFolders: 1,
  errors: 0,
};

let db: DB;
let filesDir: string;
let cleanup: string[];

function scratch(): string {
  const dir = tempDir();
  cleanup.push(dir);
  return dir;
}

function importPath(p: string, extra: Partial<Parameters<typeof importSlackExport>[0]> = {}) {
  return importSlackExport({ db, path: p, filesDir, ...extra });
}

function count(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

beforeEach(() => {
  cleanup = [];
  db = openDb(':memory:');
  filesDir = scratch();
});

afterEach(() => {
  db.close();
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

describe('importSlackExport: directory', () => {
  it('imports the fixture with exact counts', async () => {
    const lines: string[] = [];
    const stats = await importPath(FIXTURE_DIR, { log: (l) => lines.push(l) });
    expect(stats).toMatchObject(EXPECTED);
    expect(count('SELECT count(*) AS n FROM messages')).toBe(21);
    expect(count('SELECT count(*) AS n FROM users')).toBe(5);
    expect(count("SELECT count(*) AS n FROM messages WHERE source = 'import'")).toBe(21);
    expect(lines.some((l) => l.includes('Skipping folder "notes"'))).toBe(true);
  });

  it('derives conversation types, DM partners and the exporting user', async () => {
    await importPath(FIXTURE_DIR);
    expect(getMeta(db, 'self_user_id')).toBe('U0SELF0001');
    expect(getConversation(db, GENERAL)).toMatchObject({
      type: 'channel',
      label: 'general',
      topic: 'Company-wide announcements',
      purpose: 'Everyone, everything',
      messageCount: 13,
    });
    expect(getConversation(db, 'C0LEADERS1')).toMatchObject({ type: 'private_channel', label: 'leadership' });
    expect(getConversation(db, 'D0ALICE001')).toMatchObject({ type: 'im', dmUserId: 'U0ALICE001', label: 'Alice' });
    expect(getConversation(db, 'D0CAROL001')).toMatchObject({ type: 'im', dmUserId: 'U0CAROL001' });
    expect(getConversation(db, 'G0MPDM0001')).toMatchObject({
      type: 'mpim',
      memberIds: ['U0SELF0001', 'U0ALICE001', 'U0CAROL001'],
      messageCount: 2,
    });
    expect(getConversation(db, 'C0ORPHAN01')).toMatchObject({ type: 'channel', messageCount: 1 });
    const users = new Map(listUsers(db).map((u) => [u.id, u]));
    expect(users.get('U0DEPLOY01')).toMatchObject({ isBot: true, label: 'Deploy Bot' });
    expect(users.get('U0BOB00001')).toMatchObject({ deleted: true, label: 'Bob Martins' });
  });

  it('keeps threads, broadcasts, edits, reactions, bot messages and tombstones', async () => {
    await importPath(FIXTURE_DIR);
    const page = getMessages(db, { conversationId: GENERAL, limit: 50 });
    expect(page.messages.map((m) => m.ts)).toEqual([
      '1709287200.000100',
      '1709289000.000150',
      THREAD_TS,
      '1709294400.000400',
      '1709370000.000100', // thread_broadcast reply, also shown in the channel
      '1709380800.000600',
      '1709384400.000700',
      '1709456400.000100',
      '1709460000.000200',
      '1709463600.000400',
    ]);
    const byTs = new Map(page.messages.map((m) => [m.ts, m]));

    expect(byTs.get(THREAD_TS)).toMatchObject({
      replyCount: 3,
      latestReply: '1709377200.000500',
      replyUsers: ['U0ALICE001', 'U0CAROL001'],
    });
    const thread = getThread(db, GENERAL, THREAD_TS);
    expect(thread.parent?.ts).toBe(THREAD_TS);
    expect(thread.replies.map((r) => [r.ts, r.subtype])).toEqual([
      ['1709291400.000300', null],
      ['1709370000.000100', 'thread_broadcast'],
      ['1709377200.000500', null],
    ]);

    expect(byTs.get('1709294400.000400')?.editedTs).toBe('1709294460.000000');
    expect(byTs.get('1709287200.000100')?.reactions).toEqual([
      { name: 'tada', count: 2, users: ['U0SELF0001', 'U0CAROL001'] },
    ]);

    const attachmentBot = byTs.get('1709380800.000600');
    expect(attachmentBot).toMatchObject({ username: 'deploybot', botId: 'B0DEPLOY01' });
    expect(attachmentBot?.botIconUrl).toBe('https://avatars.example.com/deploy_48.png');
    expect(attachmentBot?.text).toContain('Deploy succeeded');
    expect(attachmentBot?.attachments[0]).toMatchObject({
      title: 'Deploy succeeded',
      titleLink: 'https://ci.example.com/runs/42',
    });
    expect(byTs.get('1709456400.000100')?.text).toContain('Nightly build');

    const tombstone = byTs.get('1709460000.000200');
    expect(tombstone?.isDeleted).toBe(true);
    expect(getThread(db, GENERAL, '1709460000.000200').replies).toHaveLength(1);
  });

  it('indexes resolved mentions, link labels and block text for search', async () => {
    await importPath(FIXTURE_DIR);
    expect(search(db, { q: 'handbook' }).total).toBe(1);
    expect(search(db, { q: 'leadership welcome' }).total).toBe(1); // <#C…|leadership> resolved
    expect(search(db, { q: 'nightly' }).hits[0]?.message.ts).toBe('1709456400.000100');
    expect(search(db, { q: 'CrashLoopBackOff' }).hits[0]?.message.conversationId).toBe('D0ALICE001');
  });

  it('copies local attachments from both slackdump layouts and marks them done', async () => {
    await importPath(FIXTURE_DIR);
    const diagram = getFileRow(db, 'F0DIAGRAM1');
    expect(diagram).toMatchObject({ download_status: 'done', local_path: 'F0DIAGRAM1/diagram.png' });
    expect(fs.readFileSync(path.join(filesDir, 'F0DIAGRAM1/diagram.png'))).toEqual(
      fs.readFileSync(path.join(FIXTURE_DIR, '__uploads/F0DIAGRAM1/diagram.png')),
    );
    const budget = getFileRow(db, 'F0BUDGET01');
    expect(budget).toMatchObject({ download_status: 'done', local_path: 'F0BUDGET01/budget 2024.pdf' });
    expect(fs.readFileSync(path.join(filesDir, 'F0BUDGET01/budget 2024.pdf'))).toEqual(
      fs.readFileSync(path.join(FIXTURE_DIR, 'leadership/attachments/F0BUDGET01-budget 2024.pdf')),
    );
    expect(getFileRow(db, 'F0OLDFILE1')?.download_status).toBe('unavailable'); // hidden_by_limit stub
    expect(getFileRow(db, 'F0RUNBOOK1')?.download_status).toBe('pending'); // no local copy
    const fileMessage = getMessages(db, {
      conversationId: GENERAL,
      around: '1709384400.000700',
      limit: 3,
    }).messages.find((m) => m.ts === '1709384400.000700');
    expect(fileMessage?.files[0]).toMatchObject({
      id: 'F0DIAGRAM1',
      available: true,
      url: 'archive://file/F0DIAGRAM1',
      isImage: true,
    });
    // No stray temp files next to the copies.
    expect(fs.readdirSync(path.join(filesDir, 'F0DIAGRAM1'))).toEqual(['diagram.png']);
  });

  it('moves instead of copying when the export is disposable', async () => {
    const dir = copyFixture(path.join(scratch(), 'export'));
    const stats = await importPath(dir, { moveFiles: true });
    expect(stats.filesCopied).toBe(2);
    expect(fs.existsSync(path.join(dir, '__uploads/F0DIAGRAM1/diagram.png'))).toBe(false);
    expect(fs.existsSync(path.join(filesDir, 'F0DIAGRAM1/diagram.png'))).toBe(true);
    expect(getFileRow(db, 'F0BUDGET01')?.download_status).toBe('done');
  });

  it('leaves files pending when copyFiles is false', async () => {
    const stats = await importPath(FIXTURE_DIR, { copyFiles: false });
    expect(stats.filesCopied).toBe(0);
    expect(getFileRow(db, 'F0DIAGRAM1')?.download_status).toBe('pending');
    expect(fs.readdirSync(filesDir)).toEqual([]);
  });

  it('is idempotent: a second import changes nothing', async () => {
    await importPath(FIXTURE_DIR);
    const before = db.prepare('SELECT id, updated_at, raw FROM messages ORDER BY id').all();
    const again = await importPath(FIXTURE_DIR);
    expect(again).toMatchObject({ messagesInserted: 0, messagesUpdated: 0, revisions: 0, filesCopied: 0, errors: 0 });
    expect(db.prepare('SELECT id, updated_at, raw FROM messages ORDER BY id').all()).toEqual(before);
    expect(count('SELECT count(*) AS n FROM message_revisions')).toBe(0);
    expect(getFileRow(db, 'F0DIAGRAM1')?.download_attempts).toBe(1);
  });

  it('re-copies a file whose local copy went missing', async () => {
    await importPath(FIXTURE_DIR);
    fs.rmSync(path.join(filesDir, 'F0DIAGRAM1'), { recursive: true });
    const again = await importPath(FIXTURE_DIR);
    expect(again.filesCopied).toBe(1);
    expect(getFileRow(db, 'F0DIAGRAM1')?.download_status).toBe('done');
    expect(fs.existsSync(path.join(filesDir, 'F0DIAGRAM1/diagram.png'))).toBe(true);
  });
});

describe('importSlackExport: later exports', () => {
  function editedCopy(edit: (msgs: SlackMessage[]) => void): string {
    const dir = copyFixture(path.join(scratch(), 'export'));
    const file = path.join(dir, 'general/2024-03-01.json');
    const msgs = readJson<SlackMessage[]>(file);
    edit(msgs);
    writeJson(file, msgs);
    return dir;
  }

  it('records the previous text as a revision when a message was edited again', async () => {
    await importPath(FIXTURE_DIR);
    const newer = editedCopy((msgs) => {
      const m = msgs.find((x) => x.ts === '1709294400.000400')!;
      m.text = 'Standup moved to 11:00 tomorrow';
      m.edited = { user: 'U0CAROL001', ts: '1709294700.000000' };
    });
    const stats = await importPath(newer);
    expect(stats).toMatchObject({ messagesInserted: 0, messagesUpdated: 1, revisions: 1 });
    expect(getMessageRevisions(db, GENERAL, '1709294400.000400')).toEqual([
      expect.objectContaining({ text: 'Standup moved to 10:30 tomorrow', editedTs: '1709294460.000000' }),
    ]);
  });

  it('keeps archived text when a later export shows the message as deleted', async () => {
    await importPath(FIXTURE_DIR);
    const deleted = editedCopy((msgs) => {
      const i = msgs.findIndex((x) => x.ts === '1709289000.000150');
      msgs[i] = {
        type: 'message',
        subtype: 'tombstone',
        ts: msgs[i].ts,
        text: 'This message was deleted.',
        user: 'USLACKBOT',
      };
    });
    await importPath(deleted);
    const msg = getMessages(db, { conversationId: GENERAL, around: '1709289000.000150', limit: 1 }).messages[0];
    expect(msg).toMatchObject({ ts: '1709289000.000150', isDeleted: true, userId: 'U0BOB00001' });
    expect(msg.text).toContain('Last day today');
  });
});

describe('importSlackExport: exporting user and users', () => {
  it('leaves the exporting user unset when dms.json is ambiguous, but honours meta', async () => {
    const dir = copyFixture(path.join(scratch(), 'export'));
    writeJson(path.join(dir, 'dms.json'), [{ id: 'D0ALICE001', created: 1, members: ['U0ALICE001', 'U0SELF0001'] }]);

    await importPath(dir);
    expect(getMeta(db, 'self_user_id')).toBeNull();
    expect(getConversation(db, 'D0ALICE001')?.dmUserId).toBeNull();

    const db2 = openDb(':memory:');
    setMeta(db2, 'self_user_id', 'U0SELF0001');
    await importSlackExport({ db: db2, path: dir, filesDir: scratch() });
    expect(getConversation(db2, 'D0ALICE001')?.dmUserId).toBe('U0ALICE001');
    db2.close();
  });

  it('synthesizes users from message profiles when users.json is missing', async () => {
    const dir = copyFixture(path.join(scratch(), 'export'));
    fs.rmSync(path.join(dir, 'users.json'));
    // Already-known users are never overwritten by the sparser synthesized record.
    upsertUsers(db, [
      { id: 'U0ALICE001', name: 'alice', real_name: 'Alice From API', profile: { display_name: 'ali' } },
    ]);

    const stats = await importPath(dir);
    expect(stats).toMatchObject({ usersSynthesized: 3, users: 3, messagesInserted: 21 });
    const users = new Map(listUsers(db).map((u) => [u.id, u]));
    expect(users.get('U0ALICE001')?.realName).toBe('Alice From API');
    expect(users.get('U0CAROL001')).toMatchObject({ name: 'carol', realName: 'Carol Diaz', displayName: 'carol.d' });
    expect(users.get('U0BOB00001')?.realName).toBe('Bob Martins');
    // Mentions of synthesized users resolve in search text (self was only ever mentioned early on).
    const plain = db.prepare('SELECT plain_text FROM messages WHERE ts = ?').get('1709287200.000100') as {
      plain_text: string;
    };
    expect(plain.plain_text).toContain('@sam');
  });
});

describe('importSlackExport: zip archives', () => {
  function writeZip(name: string, buf: Buffer): string {
    const file = path.join(scratch(), name);
    fs.writeFileSync(file, buf);
    return file;
  }

  it.each([
    ['stored', false],
    ['deflated', true],
  ])('imports a %s zip with a wrapper folder and __MACOSX junk', async (_label, deflate) => {
    const inputs = [
      ...zipInputsFromDir(FIXTURE_DIR, 'export-basic/'),
      { name: '__MACOSX/export-basic/._users.json', data: 'junk' },
      { name: 'export-basic/.DS_Store', data: 'junk' },
    ];
    const zip = writeZip('export.zip', buildZip(inputs, { deflate }));
    const stats = await importPath(zip);
    expect(stats).toMatchObject(EXPECTED);
    expect(fs.readFileSync(path.join(filesDir, 'F0BUDGET01/budget 2024.pdf'))).toEqual(
      fs.readFileSync(path.join(FIXTURE_DIR, 'leadership/attachments/F0BUDGET01-budget 2024.pdf')),
    );
  });

  it('imports a zip without a wrapper and one with nested wrappers', async () => {
    const flat = await importPath(writeZip('flat.zip', buildZip(zipInputsFromDir(FIXTURE_DIR))));
    expect(flat).toMatchObject(EXPECTED);
    const nested = await importPath(
      writeZip('nested.zip', buildZip(zipInputsFromDir(FIXTURE_DIR, 'outer/export-basic/'))),
    );
    expect(nested).toMatchObject({ messagesInserted: 0, dayFiles: 8, errors: 0 });
  });

  it('refuses zip-slip entries and writes nothing outside the target', async () => {
    const dir = scratch();
    const zip = path.join(dir, 'inner', 'evil.zip');
    fs.mkdirSync(path.dirname(zip));
    fs.writeFileSync(
      zip,
      buildZip([
        { name: 'users.json', data: '[]' },
        { name: '../evil.txt', data: 'pwned' },
      ]),
    );
    await expect(importPath(zip)).rejects.toThrow(/invalid relative path|unsafe/);
    expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false);
    expect(count('SELECT count(*) AS n FROM users')).toBe(0);
  });
});

describe('importSlackExport: malformed input', () => {
  it('rejects a directory that is not an export', async () => {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'hello');
    fs.mkdirSync(path.join(dir, 'photos'));
    fs.writeFileSync(path.join(dir, 'photos', 'a.jpg'), 'x');
    await expect(importPath(dir)).rejects.toThrow(/^Not a Slack export/);
  });

  it('rejects missing paths and files that are not zips', async () => {
    await expect(importPath(path.join(scratch(), 'nope'))).rejects.toThrow(/Not a Slack export: .* does not exist/);
    const fake = path.join(scratch(), 'export.zip');
    fs.writeFileSync(fake, 'this is not a zip file at all');
    await expect(importPath(fake)).rejects.toThrow(/Not a Slack export: .* not a readable zip/);
  });

  it('validates listing files before writing anything', async () => {
    const dir = copyFixture(path.join(scratch(), 'export'));
    fs.writeFileSync(path.join(dir, 'mpims.json'), '[{"id": "G0MPDM0001", ');
    await expect(importPath(dir)).rejects.toThrow(/mpims\.json is not valid JSON/);
    expect(count('SELECT count(*) AS n FROM users')).toBe(0);
    expect(count('SELECT count(*) AS n FROM conversations')).toBe(0);
    expect(getMeta(db, 'self_user_id')).toBeNull();
  });

  it('skips and reports a corrupt day file but imports the rest', async () => {
    const dir = copyFixture(path.join(scratch(), 'export'));
    fs.writeFileSync(path.join(dir, 'general/2024-03-02.json'), '[{"ts": "1709370000.000100", "text": ');
    fs.writeFileSync(path.join(dir, 'general/2024-03-03.json'), '{"not": "an array"}');
    const lines: string[] = [];
    const stats = await importPath(dir, { log: (l) => lines.push(l) });
    expect(stats).toMatchObject({ errors: 2, dayFiles: 6, messagesInserted: 21 - 4 - 4 });
    expect(lines.filter((l) => l.startsWith('Skipping general/'))).toHaveLength(2);
  });
});

describe('importSlackExport: progress and cancellation', () => {
  it('reports import progress per day file', async () => {
    const events: SyncProgress[] = [];
    await importPath(FIXTURE_DIR, { onProgress: (p) => events.push(p) });
    expect(events.every((e) => e.phase === 'import' && e.total === 8)).toBe(true);
    expect(events.at(-1)).toMatchObject({ current: 8, total: 8 });
  });

  it('stops at the next day file when aborted and keeps what was committed', async () => {
    const ac = new AbortController();
    let calls = 0;
    const run = importPath(FIXTURE_DIR, {
      signal: ac.signal,
      onProgress: () => {
        if (++calls === 2) ac.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const stored = count('SELECT count(*) AS n FROM messages');
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThan(21);
  });

  it('does nothing when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(importPath(FIXTURE_DIR, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(count('SELECT count(*) AS n FROM users')).toBe(0);
  });
});
