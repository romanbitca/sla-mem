import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema';
import type { DB } from './types';

/**
 * Opens (creating if needed) the archive database, applies connection pragmas and runs pending
 * migrations. Pass ':memory:' for an in-memory database (tests).
 */
export function openDb(file: string): DB {
  if (isOnDisk(file)) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  try {
    applyPragmas(db);
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function isOnDisk(file: string): boolean {
  return file !== '' && file !== ':memory:' && !file.startsWith('file:');
}

function applyPragmas(db: DB): void {
  // WAL lets the UI keep reading while a sync writes.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
}

export function getSchemaVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Applies every migration newer than the database's `user_version`. Idempotent. */
export function migrate(db: DB): void {
  const current = getSchemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this app supports (${LATEST_SCHEMA_VERSION}). ` +
        'Update the app instead of downgrading the archive.',
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    // IMMEDIATE takes the write lock up front so two processes can't both migrate.
    db.transaction(() => {
      if (getSchemaVersion(db) >= migration.version) return;
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    }).immediate();
  }
}
