import { deleteMeta, getMeta, setMeta } from './meta';
import type { DB } from './types';

/**
 * Cross-process advisory locks stored in `meta` (`lock:<name>` → {owner, pid, at}). SQLite's own
 * locking makes acquire atomic; the pid/age checks recover from processes that died holding one.
 */

export interface LockInfo {
  owner: string;
  pid: number;
  /** Epoch ms of acquisition or last refresh. */
  at: number;
}

export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

const lockKey = (name: string) => `lock:${name}`;

export function readLock(db: DB, name: string): LockInfo | null {
  const value = getMeta(db, lockKey(name));
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LockInfo>;
    if (typeof parsed.owner !== 'string' || typeof parsed.at !== 'number') return null;
    return { owner: parsed.owner, pid: typeof parsed.pid === 'number' ? parsed.pid : 0, at: parsed.at };
  } catch {
    return null; // Corrupt lock rows are treated as free.
  }
}

/** Signal 0 probes existence without affecting the process; EPERM means it exists but isn't ours. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(lock: LockInfo, staleMs: number, now: number): boolean {
  return now - lock.at > staleMs || !isPidAlive(lock.pid);
}

/**
 * Takes the lock if it is free, stale (older than `staleMs` or held by a dead pid), or already
 * held by `owner` (re-entrant). Returns whether the caller now holds it.
 */
export function tryAcquireLock(db: DB, name: string, owner: string, staleMs: number = DEFAULT_LOCK_STALE_MS): boolean {
  // IMMEDIATE: take SQLite's write lock before reading so two processes can't both see "free".
  return db
    .transaction(() => {
      const now = Date.now();
      const current = readLock(db, name);
      if (current && current.owner !== owner && !isStale(current, staleMs, now)) return false;
      writeLock(db, name, owner, now);
      return true;
    })
    .immediate();
}

/** Bumps the lock's timestamp if `owner` still holds it. Returns false if it was lost. */
export function refreshLock(db: DB, name: string, owner: string): boolean {
  return db
    .transaction(() => {
      if (readLock(db, name)?.owner !== owner) return false;
      writeLock(db, name, owner, Date.now());
      return true;
    })
    .immediate();
}

/** Releases the lock only if `owner` holds it (a taken-over lock is left to its new owner). */
export function releaseLock(db: DB, name: string, owner: string): void {
  db.transaction(() => {
    if (readLock(db, name)?.owner === owner) deleteMeta(db, lockKey(name));
  }).immediate();
}

function writeLock(db: DB, name: string, owner: string, at: number): void {
  const info: LockInfo = { owner, pid: process.pid, at };
  setMeta(db, lockKey(name), JSON.stringify(info));
}
