import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupArchive } from './backup';
import {
  getFileRow,
  getMessageRevisions,
  getMeta,
  getSyncState,
  markFileDownloaded,
  openDb,
  search,
  setMeta,
  setSyncState,
  upsertConversations,
  upsertMessages,
  upsertUsers,
  type DB,
} from './db';
import { CONVERSATIONS, msg, tsAt, USERS } from './db/test-helpers';
import { archivePaths, type ArchivePaths } from './paths';
import { isArchiveBackup, restoreBackup } from './restore';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-restore-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** An archive folder like a computer's: database, attachments, preferences. */
function computer(name: string, owner = { team: 'T1', self: 'USELF' }): { db: DB; paths: ArchivePaths } {
  const paths = archivePaths(path.join(root, name));
  fs.mkdirSync(paths.filesDir, { recursive: true });
  const db = openDb(paths.dbPath);
  setMeta(db, 'team_id', owner.team);
  setMeta(db, 'team_name', 'Brightwave');
  setMeta(db, 'self_user_id', owner.self);
  upsertUsers(db, USERS);
  upsertConversations(db, CONVERSATIONS, { selfUserId: owner.self });
  return { db, paths };
}

function attach(c: { db: DB; paths: ArchivePaths }, id: string, name: string, body: string): void {
  fs.mkdirSync(path.join(c.paths.filesDir, id), { recursive: true });
  fs.writeFileSync(path.join(c.paths.filesDir, id, name), body);
  markFileDownloaded(c.db, id, path.join(id, name), null);
}

const count = (db: DB, sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const text = (db: DB, conv: string, ts: string) =>
  (db.prepare('SELECT text, is_deleted FROM messages WHERE conversation_id = ? AND ts = ?').get(conv, ts) as
    { text: string; is_deleted: number } | undefined) ?? null;

/** The old computer's archive, backed up with "Back up now". */
async function oldComputerBackup(): Promise<string> {
  const old = computer('old');
  upsertMessages(
    old.db,
    'C1',
    [
      msg(tsAt(1), 'deploy is done', {
        files: [{ id: 'F1', name: 'log.txt', mimetype: 'text/plain', url_private: 'https://files.slack.com/F1' }],
      }),
      msg(tsAt(2), 'first draft'),
      msg(tsAt(3), 'this will be deleted'),
    ],
    'api',
  );
  upsertMessages(old.db, 'C1', [msg(tsAt(2), 'final text', { edited: { user: 'U1', ts: tsAt(4) } })], 'api');
  upsertMessages(old.db, 'C1', [{ type: 'message', subtype: 'tombstone', ts: tsAt(3), text: '' }], 'api');
  upsertMessages(old.db, 'D1', [msg(tsAt(5), 'a private note')], 'api');
  attach(old, 'F1', 'log.txt', 'LOG');
  setSyncState(old.db, 'C1', { latest_ts: tsAt(3), oldest_ts: tsAt(1), backfill_complete: true });
  fs.writeFileSync(old.paths.configPath, JSON.stringify({ preferences: { excludedConversationIds: ['G1'] } }));
  const dest = path.join(root, 'usb-stick');
  fs.mkdirSync(dest);
  const { path: zip } = await backupArchive({ db: old.db, paths: old.paths, destDir: dest });
  old.db.close();
  return zip;
}

function restore(c: { db: DB; paths: ArchivePaths }, zip: string, onExcluded?: (ids: string[]) => void) {
  return restoreBackup({
    db: c.db,
    path: zip,
    filesDir: c.paths.filesDir,
    tmpDir: c.paths.tmpDir,
    onExcludedConversations: onExcluded,
  });
}

describe('restoreBackup (moving to another computer)', () => {
  it('brings everything to a new computer: messages, edits, deletions, attachments, sync position', async () => {
    const zip = await oldComputerBackup();
    expect(await isArchiveBackup(zip)).toBe(true);

    const fresh = computer('new');
    fresh.db.exec("DELETE FROM meta WHERE key IN ('team_id', 'self_user_id')"); // nothing synced here yet
    const excluded: string[][] = [];
    const stats = await restore(fresh, zip, (ids) => excluded.push(ids));

    expect(stats).toMatchObject({ messagesInserted: 4, messagesUpdated: 0, filesDownloaded: 1 });
    expect(count(fresh.db, 'SELECT count(*) AS n FROM messages')).toBe(4);
    expect(text(fresh.db, 'C1', tsAt(2))).toEqual({ text: 'final text', is_deleted: 0 });
    expect(getMessageRevisions(fresh.db, 'C1', tsAt(2)).map((r) => r.text)).toEqual(['first draft']);
    expect(text(fresh.db, 'C1', tsAt(3))).toEqual({ text: 'this will be deleted', is_deleted: 1 });
    expect(getFileRow(fresh.db, 'F1')).toMatchObject({
      download_status: 'done',
      local_path: path.join('F1', 'log.txt'),
    });
    expect(fs.readFileSync(path.join(fresh.paths.filesDir, 'F1', 'log.txt'), 'utf8')).toBe('LOG');
    // Syncing carries on from where the old computer stopped.
    expect(getSyncState(fresh.db, 'C1')).toMatchObject({ latest_ts: tsAt(3), backfill_complete: true });
    expect(getMeta(fresh.db, 'team_id')).toBe('T1');
    expect(excluded).toEqual([['G1']]);
    expect(search(fresh.db, { q: 'deploy' }).total).toBe(1);

    // Importing the same backup again changes nothing.
    expect(await restore(fresh, zip)).toMatchObject({ messagesInserted: 0, messagesUpdated: 0, filesDownloaded: 0 });
    expect(count(fresh.db, 'SELECT count(*) AS n FROM messages')).toBe(4);
    fresh.db.close();
  });

  it('merges into an archive that already has newer messages, losing nothing from either', async () => {
    const zip = await oldComputerBackup();
    const now = computer('new');
    // This computer already synced: a later edit of one message, and a message the backup lacks.
    upsertMessages(
      now.db,
      'C1',
      [msg(tsAt(2), 'final text, edited again', { edited: { user: 'U1', ts: tsAt(9) } })],
      'api',
    );
    upsertMessages(now.db, 'C1', [msg(tsAt(10), 'written after the backup')], 'api');
    setSyncState(now.db, 'C1', { latest_ts: tsAt(10), oldest_ts: tsAt(2) });

    const stats = await restore(now, zip);
    expect(stats.messagesInserted).toBe(3);
    expect(count(now.db, 'SELECT count(*) AS n FROM messages')).toBe(5);
    expect(text(now.db, 'C1', tsAt(2))?.text).toBe('final text, edited again');
    expect(getMessageRevisions(now.db, 'C1', tsAt(2)).map((r) => r.text)).toContain('first draft');
    expect(text(now.db, 'C1', tsAt(10))?.text).toBe('written after the backup');
    expect(getSyncState(now.db, 'C1')).toMatchObject({ latest_ts: tsAt(10), oldest_ts: tsAt(1) });
    now.db.close();
  });

  it('refuses a backup of another Slack account, and changes nothing', async () => {
    const zip = await oldComputerBackup();
    const someoneElse = computer('other', { team: 'T2', self: 'U2' });
    await expect(restore(someoneElse, zip)).rejects.toMatchObject({
      code: 'wrong_account',
      message: expect.stringContaining('Import it into an archive of the same Slack account'),
    });
    expect(count(someoneElse.db, 'SELECT count(*) AS n FROM messages')).toBe(0);
    someoneElse.db.close();
  });

  it('tells a Slack export from a backup', async () => {
    const exportDir = path.join(root, 'export');
    fs.mkdirSync(exportDir);
    fs.writeFileSync(path.join(exportDir, 'users.json'), '[]');
    expect(await isArchiveBackup(exportDir)).toBe(false);
    expect(await isArchiveBackup(path.join(root, 'missing.zip'))).toBe(false);
  });
});
