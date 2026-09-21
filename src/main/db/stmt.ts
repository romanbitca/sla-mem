import type Database from 'better-sqlite3';
import type { DB } from './types';

/**
 * Upper bound on cached statements per connection. Search builds SQL from a bounded set of
 * filter combinations, so this is only a guard against unexpected unbounded SQL variety.
 */
const MAX_CACHED_STATEMENTS = 256;

const caches = new WeakMap<DB, Map<string, Database.Statement>>();

/**
 * Returns a prepared statement for `sql`, compiling it once per connection. Keyed by the SQL
 * text; the WeakMap lets the cache die with the connection.
 *
 * Callers must not toggle `pluck()`/`raw()`/`expand()` on returned statements (they are shared)
 * and must not hold an `iterate()` cursor open while calling other code that may reuse them.
 */
export function stmt<R = unknown>(db: DB, sql: string): Database.Statement<unknown[], R> {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    if (cache.size >= MAX_CACHED_STATEMENTS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(sql, statement);
  }
  return statement as Database.Statement<unknown[], R>;
}

/** SQL fragment + params for "column IN (ids)" that keeps the SQL text stable for any list size. */
export function inList(column: string, ids: readonly (string | number)[]): { sql: string; params: unknown[] } {
  if (ids.length === 1) return { sql: `${column} = ?`, params: [ids[0]] };
  return { sql: `${column} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(ids)] };
}
