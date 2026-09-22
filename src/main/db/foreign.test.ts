import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkForeignDatabase, ForeignDatabaseError } from './foreign';
import { openDb } from './open';
import { MIGRATIONS } from './schema';
import { msg, tsAt } from './test-helpers';
import { upsertMessages } from './write';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-foreign-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A Slamem archive with a message in it, as a backup would carry it. */
function archive(name = 'archive.db', tamper?: (db: Database.Database) => void): string {
  const file = path.join(dir, name);
  const db = openDb(file);
  upsertMessages(db, 'C1', [msg(tsAt(1), 'hello')], 'api');
  tamper?.(db);
  db.close();
  return file;
}

function problemOf(file: string): string | null {
  try {
    checkForeignDatabase(file);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(ForeignDatabaseError);
    return (err as ForeignDatabaseError).problem;
  }
}

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('checkForeignDatabase (a backup is someone else’s file)', () => {
  it('accepts an archive Slamem wrote, without changing the file', () => {
    const file = archive();
    const before = sha(file);
    expect(problemOf(file)).toBeNull();
    expect(sha(file)).toBe(before);
  });

  it('accepts an archive from an older schema version', () => {
    const file = path.join(dir, 'old.db');
    const db = new Database(file);
    db.exec(MIGRATIONS[0].sql);
    db.pragma(`user_version = ${MIGRATIONS[0].version}`);
    db.close();
    expect(problemOf(file)).toBeNull();
  });

  it('refuses code Slamem never writes: extra triggers and views', () => {
    const trigger = archive('trigger.db', (db) =>
      db.exec("CREATE TRIGGER planted AFTER INSERT ON users BEGIN UPDATE meta SET value = 'x'; END"),
    );
    const view = archive('view.db', (db) => db.exec('CREATE VIEW peek AS SELECT * FROM messages'));
    expect(problemOf(trigger)).toBe('unexpected');
    expect(problemOf(view)).toBe('unexpected');
  });

  it('refuses one of Slamem’s triggers with a different body', () => {
    const file = archive('changed.db', (db) => {
      db.exec('DROP TRIGGER messages_fts_ai');
      db.exec('CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN DELETE FROM users; END');
    });
    expect(problemOf(file)).toBe('unexpected');
  });

  it('refuses a table swapped for a view or a virtual table, and unknown tables', () => {
    const swapped = archive('swapped.db', (db) => {
      db.exec('DROP TABLE message_files');
      db.exec('CREATE VIEW message_files AS SELECT 1 AS message_id, 2 AS file_id');
    });
    const virtual = archive('virtual.db', (db) => {
      db.exec('DROP TABLE custom_emoji');
      db.exec('CREATE VIRTUAL TABLE custom_emoji USING fts4(name, url)');
    });
    const extra = archive('extra.db', (db) => db.exec('CREATE TABLE notes (x TEXT)'));
    expect(problemOf(swapped)).toBe('unexpected');
    expect(problemOf(virtual)).toBe('unexpected');
    expect(problemOf(extra)).toBe('unexpected');
  });

  it('refuses damaged files and files that aren’t databases', () => {
    const garbage = path.join(dir, 'garbage.db');
    fs.writeFileSync(garbage, crypto.randomBytes(8192));
    const file = archive('damaged.db');
    const probe = new Database(file, { readonly: true });
    const { rootpage } = probe.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'messages'").get() as {
      rootpage: number;
    };
    const pageSize = probe.pragma('page_size', { simple: true }) as number;
    probe.close();
    const bytes = fs.readFileSync(file);
    bytes[(rootpage - 1) * pageSize] = 0x07; // not a b-tree page type
    fs.writeFileSync(file, bytes);
    expect(problemOf(garbage)).toBe('damaged');
    expect(problemOf(file)).toBe('damaged');
    expect(problemOf(path.join(dir, 'missing.db'))).toBe('damaged');
  });

  it('refuses an archive from a newer version', () => {
    const file = archive('newer.db', (db) => db.pragma('user_version = 999'));
    expect(problemOf(file)).toBe('newer');
  });
});
