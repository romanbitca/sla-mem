import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getSchemaVersion, migrate, openDb } from './open';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema';
import type { DB } from './types';

const tmpDirs: string[] = [];
function tmpFile(name = 'archive.db'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-mem-db-'));
  tmpDirs.push(dir);
  return path.join(dir, 'nested', 'deeper', name);
}

const opened: DB[] = [];
function open(file: string): DB {
  const db = openDb(file);
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function names(db: DB, type: 'table' | 'index' | 'trigger'): string[] {
  return (
    db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as { name: string }[]
  ).map((r) => r.name);
}

describe('openDb', () => {
  it('creates missing directories, applies pragmas and migrates to the latest version', () => {
    const file = tmpFile();
    const db = open(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
  });

  it('creates every contract table, the FTS table and sync triggers', () => {
    const db = open(':memory:');
    expect(names(db, 'table')).toEqual(
      expect.arrayContaining([
        'meta',
        'users',
        'conversations',
        'messages',
        'messages_fts',
        'message_revisions',
        'files',
        'message_files',
        'custom_emoji',
        'sync_state',
        'runs',
        'conversation_stats',
      ]),
    );
    expect(names(db, 'trigger')).toEqual(
      expect.arrayContaining(['messages_fts_ai', 'messages_fts_ad', 'messages_fts_au']),
    );
  });

  it('creates the required indexes', () => {
    const db = open(':memory:');
    const indexSql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { sql: string }[]
    ).map((r) => r.sql.replace(/\s+/g, ' '));
    for (const cols of [
      'messages (conversation_id, is_reply, ts)',
      'messages (conversation_id, thread_ts, ts)',
      'messages (user_id, time,',
      'messages (conversation_id, time,',
      'messages (bot_id, time) WHERE bot_id IS NOT NULL',
      'messages (time) WHERE thread_ts IS NOT NULL',
      'messages (time)',
      'message_files (file_id)',
      'message_revisions (conversation_id, ts)',
    ]) {
      expect(indexSql.some((sql) => sql.includes(`ON ${cols}`))).toBe(true);
    }
  });

  it('is idempotent: reopening and re-migrating keeps data and version', () => {
    const file = tmpFile();
    const db1 = open(file);
    db1.prepare("INSERT INTO meta (key, value) VALUES ('team_id', 'T1')").run();
    db1.close();
    const db2 = open(file);
    migrate(db2);
    migrate(db2);
    expect(getSchemaVersion(db2)).toBe(LATEST_SCHEMA_VERSION);
    expect(db2.prepare("SELECT value FROM meta WHERE key = 'team_id'").get()).toEqual({ value: 'T1' });
  });

  it('refuses a database written by a newer schema version', () => {
    const file = tmpFile();
    const db = open(file);
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDb(file)).toThrow(/newer than this app supports/);
  });

  it('upgrades a version 1 archive with the People index, keeping its messages', () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const v1 = new Database(file);
    v1.exec(MIGRATIONS[0].sql);
    v1.pragma('user_version = 1');
    v1.prepare(
      "INSERT INTO messages (id, conversation_id, ts, time, user_id, raw, source, first_seen_at, updated_at) VALUES (1, 'C1', '1.000000', 1, 'U1', '{}', 'api', 0, 0)",
    ).run();
    v1.close();
    const db = open(file);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_conv_user_time'").get() as {
      sql: string;
    };
    expect(index.sql).toContain('(conversation_id, user_id, time) WHERE user_id IS NOT NULL');
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 });
  });

  it('leaves older queries on their indexes; only one author in one conversation takes the People one', () => {
    const db = open(':memory:');
    const plan = (sql: string, ...params: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((p) => p.detail).join(' | ');
    // A conversation's newest messages come in index order, not sorted afterwards.
    const byConversation = plan(
      'SELECT id, time FROM messages WHERE conversation_id = ? ORDER BY time DESC LIMIT 8',
      'C1',
    );
    expect(byConversation).toContain('messages_conv_time');
    expect(byConversation).not.toContain('TEMP B-TREE');
    const byAuthor = plan('SELECT id FROM messages WHERE user_id = ? ORDER BY time DESC LIMIT 8', 'U1');
    expect(byAuthor).toContain('messages_user_time');
    expect(byAuthor).not.toContain('TEMP B-TREE');
    expect(plan('SELECT count(*) FROM messages WHERE conversation_id = ? AND user_id = ?', 'C1', 'U1')).toContain(
      'messages_conv_user_time',
    );
  });

  it('uses the partial top-level index for conversation paging', () => {
    const db = open(':memory:');
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE conversation_id = ? AND (is_reply = 0 OR subtype = 'thread_broadcast') AND ts < ? ORDER BY ts DESC LIMIT ?",
      )
      .all('C1', '1', 5) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' | ')).toContain('messages_conv_top_ts');
  });
});
