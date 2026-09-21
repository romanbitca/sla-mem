import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPidAlive, readLock, refreshLock, releaseLock, tryAcquireLock } from './locks';
import { setMeta } from './meta';
import { openDb } from './open';
import { createRun, getRunLog, listRuns, markStaleRunsInterrupted, MAX_RUN_LOG_LINES, updateRun } from './runs';
import { memDb } from './test-helpers';
import type { DB } from './types';

/** A pid that certainly belonged to a process which has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid!;
}

function forgeLock(db: DB, name: string, lock: { owner: string; pid: number; at: number }) {
  setMeta(db, `lock:${name}`, JSON.stringify(lock));
}

describe('locks', () => {
  it('acquires a free lock, refuses other owners and is re-entrant', () => {
    const db = memDb();
    expect(tryAcquireLock(db, 'sync', 'server')).toBe(true);
    expect(readLock(db, 'sync')).toMatchObject({ owner: 'server', pid: process.pid });
    expect(tryAcquireLock(db, 'sync', 'cli')).toBe(false);
    expect(tryAcquireLock(db, 'sync', 'server')).toBe(true);
    expect(tryAcquireLock(db, 'other', 'cli')).toBe(true);
  });

  it('refreshes only for the owner', () => {
    const db = memDb();
    forgeLock(db, 'sync', { owner: 'server', pid: process.pid, at: 1000 });
    expect(refreshLock(db, 'sync', 'cli')).toBe(false);
    expect(readLock(db, 'sync')?.at).toBe(1000);
    expect(refreshLock(db, 'sync', 'server')).toBe(true);
    expect(readLock(db, 'sync')!.at).toBeGreaterThan(1000);
  });

  it('releases only for the owner', () => {
    const db = memDb();
    tryAcquireLock(db, 'sync', 'server');
    releaseLock(db, 'sync', 'cli');
    expect(readLock(db, 'sync')?.owner).toBe('server');
    releaseLock(db, 'sync', 'server');
    expect(readLock(db, 'sync')).toBeNull();
    expect(tryAcquireLock(db, 'sync', 'cli')).toBe(true);
  });

  it('takes over a stale lock (older than staleMs) even if its pid is alive', () => {
    const db = memDb();
    forgeLock(db, 'sync', { owner: 'server', pid: process.pid, at: Date.now() - 60_000 });
    expect(tryAcquireLock(db, 'sync', 'cli', 120_000)).toBe(false);
    expect(tryAcquireLock(db, 'sync', 'cli', 30_000)).toBe(true);
    expect(readLock(db, 'sync')?.owner).toBe('cli');
  });

  it('takes over a fresh lock whose process is dead', () => {
    const db = memDb();
    const pid = deadPid();
    expect(isPidAlive(pid)).toBe(false);
    forgeLock(db, 'sync', { owner: 'crashed', pid, at: Date.now() });
    expect(tryAcquireLock(db, 'sync', 'cli')).toBe(true);
  });

  it('treats a corrupt lock row as free', () => {
    const db = memDb();
    setMeta(db, 'lock:sync', 'not json');
    expect(tryAcquireLock(db, 'sync', 'cli')).toBe(true);
  });

  it('works across two connections to the same file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-mem-lock-'));
    const a = openDb(path.join(dir, 'a.db'));
    const b = openDb(path.join(dir, 'a.db'));
    try {
      expect(tryAcquireLock(a, 'sync', 'server')).toBe(true);
      expect(tryAcquireLock(b, 'sync', 'cli')).toBe(false);
      releaseLock(a, 'sync', 'server');
      expect(tryAcquireLock(b, 'sync', 'cli')).toBe(true);
    } finally {
      a.close();
      b.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runs', () => {
  let db: DB;
  afterEach(() => db?.close());

  it('creates, updates and lists runs', () => {
    db = memDb();
    const id = createRun(db, 'sync');
    expect(listRuns(db)).toEqual([
      { id, kind: 'sync', status: 'running', startedAt: expect.any(Number), finishedAt: null, stats: {}, error: null },
    ]);
    updateRun(db, id, { stats: { messagesInserted: 5, apiCalls: 3 }, log: ['a', 'b'] });
    updateRun(db, id, { status: 'error', error: 'boom', finishedAt: 123 });
    expect(listRuns(db)[0]).toMatchObject({
      status: 'error',
      error: 'boom',
      finishedAt: 123,
      stats: { messagesInserted: 5, apiCalls: 3 },
    });
    expect(getRunLog(db, id)).toEqual(['a', 'b']);
    updateRun(db, id, { error: null });
    expect(listRuns(db)[0].error).toBeNull();
    expect(getRunLog(db, 999)).toEqual([]);
  });

  it('keeps only the tail of the log and lists newest first with a limit', () => {
    db = memDb();
    const first = createRun(db, 'import');
    const second = createRun(db, 'import');
    updateRun(db, first, { log: Array.from({ length: 700 }, (_, i) => `line ${i}`) });
    const log = getRunLog(db, first);
    expect(log).toHaveLength(MAX_RUN_LOG_LINES);
    expect(log[0]).toBe('line 200');
    expect(listRuns(db, 1).map((r) => r.id)).toEqual([second]);
  });

  it('marks only runs of dead (or this) processes as interrupted', () => {
    db = memDb();
    const mine = createRun(db, 'sync');
    const other = createRun(db, 'sync');
    const dead = createRun(db, 'sync');
    const legacy = createRun(db, 'sync');
    const done = createRun(db, 'sync');
    db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(process.ppid, other); // alive: our parent
    db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(deadPid(), dead);
    db.prepare('UPDATE runs SET pid = NULL WHERE id = ?').run(legacy);
    updateRun(db, done, { status: 'ok', finishedAt: 1 });

    expect(markStaleRunsInterrupted(db)).toBe(3);
    const byId = new Map(listRuns(db).map((r) => [r.id, r]));
    for (const id of [mine, dead, legacy]) {
      expect(byId.get(id)).toMatchObject({ status: 'error', error: 'interrupted', finishedAt: expect.any(Number) });
    }
    expect(byId.get(other)?.status).toBe('running');
    expect(byId.get(done)?.status).toBe('ok');
  });
});
