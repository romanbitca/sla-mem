/**
 * A database Slamem didn't write itself, like the archive inside a backup someone hands over, is
 * untrusted: a crafted SQLite file can hold views and triggers that run SQL when it is read or
 * changed, virtual tables that reach less exercised code, or damaged pages. Before the archive's
 * own connection touches one, it gets SQLite's treatment for such files
 * (https://sqlite.org/security.html): opened read-only with `trusted_schema` off and cell size
 * checks on, it must pass `quick_check` and hold only what Slamem's schema creates, namely its
 * tables and indexes (in any version's shape) and exactly its triggers and virtual tables.
 */
import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema';

export type ForeignDatabaseProblem = 'newer' | 'damaged' | 'unexpected';

export class ForeignDatabaseError extends Error {
  constructor(
    readonly problem: ForeignDatabaseProblem,
    detail: string,
  ) {
    super(detail);
    this.name = 'ForeignDatabaseError';
  }
}

interface SchemaRow {
  type: string;
  name: string;
  sql: string | null;
}

/** Throws a ForeignDatabaseError when `file` isn't a Slamem archive this version can safely read. */
export function checkForeignDatabase(file: string): void {
  let db: Database.Database;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new ForeignDatabaseError('damaged', `can't open it: ${messageOf(err)}`);
  }
  try {
    db.pragma('trusted_schema = OFF');
    db.pragma('cell_size_check = ON');
    db.pragma('mmap_size = 0');
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > LATEST_SCHEMA_VERSION) {
      throw new ForeignDatabaseError('newer', `schema version ${version} is newer than ${LATEST_SCHEMA_VERSION}`);
    }
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new ForeignDatabaseError('damaged', `quick_check: ${String(check).slice(0, 200)}`);
    const rows = db.prepare('SELECT type, name, sql FROM sqlite_schema').all() as SchemaRow[];
    const unexpected = rows.filter((row) => !isSlamemObject(row)).map((row) => `${row.type} ${row.name}`);
    if (unexpected.length) {
      throw new ForeignDatabaseError('unexpected', `not Slamem's schema: ${unexpected.slice(0, 5).join(', ')}`);
    }
  } catch (err) {
    if (err instanceof ForeignDatabaseError) throw err;
    throw new ForeignDatabaseError('damaged', messageOf(err));
  } finally {
    db.close();
  }
}

/** What SQLite adds by itself: automatic indexes, AUTOINCREMENT counters, ANALYZE statistics. */
const SQLITE_OWN = /^sqlite_(autoindex_.+|sequence|stat[1-4])$/;

function isSlamemObject(row: SchemaRow): boolean {
  if (row.name.startsWith('sqlite_')) {
    return SQLITE_OWN.test(row.name) && (row.type === 'index' ? row.sql == null : row.type === 'table');
  }
  const known = knownSchema().get(`${row.type} ${row.name}`);
  if (!known || row.sql == null) return false;
  const sql = normalizeSql(row.sql);
  // Code that runs by itself (triggers, views) and virtual tables must be exactly Slamem's own.
  if (known.exact) return known.sql.has(sql);
  // Tables and indexes may have an older version's columns, as long as they are plain ones.
  return row.type === 'table' ? /^CREATE TABLE /i.test(sql) : /^CREATE (UNIQUE )?INDEX /i.test(sql);
}

interface KnownObject {
  /** Triggers, views and virtual tables: only these exact statements are accepted. */
  exact: boolean;
  /** The statement of every schema version that had the object, normalized. */
  sql: Set<string>;
}

let known: Map<string, KnownObject> | null = null;

/** Every object any schema version creates, keyed "type name", read from the migrations themselves. */
function knownSchema(): Map<string, KnownObject> {
  if (known) return known;
  const objects = new Map<string, KnownObject>();
  const db = new Database(':memory:');
  try {
    for (const migration of MIGRATIONS) {
      db.exec(migration.sql);
      for (const row of db.prepare('SELECT type, name, sql FROM sqlite_schema').all() as SchemaRow[]) {
        if (row.sql == null) continue;
        const sql = normalizeSql(row.sql);
        const key = `${row.type} ${row.name}`;
        const entry = objects.get(key) ?? { exact: false, sql: new Set<string>() };
        entry.sql.add(sql);
        entry.exact ||= row.type === 'trigger' || row.type === 'view' || /^CREATE VIRTUAL TABLE /i.test(sql);
        objects.set(key, entry);
      }
    }
  } finally {
    db.close();
  }
  known = objects;
  return objects;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
