import type { RunKind, RunStatus, SyncRunDTO } from '../../shared/types';
import { isPidAlive } from './locks';
import { stmt } from './stmt';
import type { DB } from './types';

/** Runs keep only the tail of their log; the UI shows recent lines, not full history. */
export const MAX_RUN_LOG_LINES = 500;

interface RunRow {
  id: number;
  kind: RunKind;
  status: RunStatus;
  started_at: number;
  finished_at: number | null;
  stats: string;
  error: string | null;
  problem: string | null;
  log: string;
  pid: number | null;
}

export function createRun(db: DB, kind: RunKind): number {
  const info = stmt(db, "INSERT INTO runs (kind, status, started_at, pid) VALUES (?, 'running', ?, ?)").run(
    kind,
    Date.now(),
    process.pid,
  );
  return Number(info.lastInsertRowid);
}

export interface RunPatch {
  status?: RunStatus;
  stats?: Record<string, number>;
  error?: string | null;
  /** Failure category for the UI (see ProblemDTO.kind). */
  problem?: string | null;
  finishedAt?: number;
  log?: string[];
}

export function updateRun(db: DB, id: number, patch: RunPatch): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    sets.push(`${column} = ?`);
    values.push(value);
  };
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.stats !== undefined) set('stats', JSON.stringify(patch.stats));
  if (patch.error !== undefined) set('error', patch.error);
  if (patch.problem !== undefined) set('problem', patch.problem);
  if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt);
  if (patch.log !== undefined) set('log', JSON.stringify(patch.log.slice(-MAX_RUN_LOG_LINES)));
  if (!sets.length) return;
  stmt(db, `UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

export function listRuns(db: DB, limit = 20): SyncRunDTO[] {
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  return stmt<RunRow>(db, 'SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(n).map(runToDTO);
}

export function getRun(db: DB, id: number): SyncRunDTO | null {
  const row = stmt<RunRow>(db, 'SELECT * FROM runs WHERE id = ?').get(id);
  return row ? runToDTO(row) : null;
}

export function getRunLog(db: DB, id: number): string[] {
  const row = stmt<{ log: string }>(db, 'SELECT log FROM runs WHERE id = ?').get(id);
  const lines = row ? parseJson<unknown>(row.log, []) : [];
  return Array.isArray(lines) ? lines.filter((l): l is string => typeof l === 'string') : [];
}

/** The most recent finished run of the given kinds, with its failure category. */
export function lastFinishedRun(db: DB, kinds: readonly RunKind[]): (SyncRunDTO & { problem: string | null }) | null {
  const row = stmt<RunRow>(
    db,
    "SELECT * FROM runs WHERE status <> 'running' AND kind IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 1",
  ).get(JSON.stringify(kinds));
  return row ? { ...runToDTO(row), problem: row.problem } : null;
}

/** finished_at of the most recent successful run of the given kinds (epoch ms), or null. */
export function lastSuccessfulRunAt(db: DB, kinds: readonly RunKind[]): number | null {
  return lastSuccessfulRun(db, kinds)?.finishedAt ?? null;
}

/** The most recent successful run of the given kinds: when it finished and what it counted. */
export function lastSuccessfulRun(
  db: DB,
  kinds: readonly RunKind[],
): { finishedAt: number | null; stats: Record<string, number> } | null {
  const row = stmt<{ finished_at: number | null; stats: string }>(
    db,
    "SELECT finished_at, stats FROM runs WHERE status = 'ok' AND kind IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 1",
  ).get(JSON.stringify(kinds));
  return row ? { finishedAt: row.finished_at, stats: numericRecord(parseJson(row.stats, {})) } : null;
}

/**
 * Called on boot: runs still marked `running` whose process is gone (or was this pid in a previous
 * life) were interrupted. A run owned by another live process is left alone.
 */
export function markStaleRunsInterrupted(db: DB): number {
  const running = stmt<{ id: number; pid: number | null }>(
    db,
    "SELECT id, pid FROM runs WHERE status = 'running'",
  ).all();
  const stale = running.filter((r) => r.pid == null || r.pid === process.pid || !isPidAlive(r.pid));
  const now = Date.now();
  db.transaction(() => {
    for (const r of stale) {
      stmt(
        db,
        "UPDATE runs SET status = 'error', error = 'interrupted', finished_at = COALESCE(finished_at, ?) WHERE id = ?",
      ).run(now, r.id);
    }
  })();
  return stale.length;
}

function runToDTO(row: RunRow): SyncRunDTO {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stats: numericRecord(parseJson(row.stats, {})),
    error: row.error,
  };
}

function numericRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [k, v] of Object.entries(value)) if (typeof v === 'number') out[k] = v;
  return out;
}

function parseJson<T>(json: string, fallback: T): T {
  try {
    return (JSON.parse(json) as T) ?? fallback;
  } catch {
    return fallback;
  }
}
