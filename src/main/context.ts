/**
 * The service graph of the main process, built once at startup. Kept free of window/tray code so
 * it can be constructed in tests with a temporary data folder.
 */
import fs from 'node:fs';
import { openDb, type DB } from './db';
import { createLogger, type Logger } from './logger';
import { archivePaths, type ArchivePaths } from './paths';
import { Preferences } from './preferences';

export interface AppContext {
  paths: ArchivePaths;
  log: Logger;
  prefs: Preferences;
  db: DB;
}

export interface ContextOptions {
  dataDir: string;
  echoLogs?: boolean;
}

export function createContext(opts: ContextOptions): AppContext {
  const paths = archivePaths(opts.dataDir);
  for (const dir of [paths.dataDir, paths.filesDir, paths.logsDir, paths.tmpDir])
    fs.mkdirSync(dir, { recursive: true });
  const log = createLogger({ dir: paths.logsDir, echo: opts.echoLogs });
  const prefs = new Preferences(paths.configPath);
  const db = openDb(paths.dbPath);
  return { paths, log, prefs, db };
}

export function closeContext(ctx: AppContext): void {
  try {
    ctx.db.pragma('optimize');
  } catch {
    // best effort
  }
  ctx.db.close();
}
