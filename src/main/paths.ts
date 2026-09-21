/**
 * Where the archive lives (PLAN §3.4). Everything is under one folder, so backing it up is a
 * folder copy (or Settings → Back up now):
 *
 *   <dataDir>/archive.db (+ -wal/-shm)   the database
 *   <dataDir>/files/<fileId>/<name>      downloaded attachments and thumbnails
 *   <dataDir>/logs/main.log              rotating log (never contains credentials)
 *   <dataDir>/config.json                non-secret preferences
 *   <dataDir>/credentials.bin            the Slack session, encrypted with the OS keychain
 */
import fs from 'node:fs';
import path from 'node:path';

/** The data folder's name, and the names it had before the app was renamed (PLAN §0.3). */
export const DATA_DIR_NAME = { production: 'sla-mem', development: 'sla-mem (dev)' } as const;
export const LEGACY_DATA_DIR_NAME = { production: 'Slack Archive', development: 'Slack Archive (dev)' } as const;

export type LegacyMove = 'none' | 'moved' | 'in-use' | 'failed';

/**
 * An archive kept under the app's old name moves to the new folder once, on first start, so the
 * rename never strands anyone's history. Nothing happens when the new folder already exists or
 * the old one holds no archive. While the old app still runs, its folder stays put ('in-use'):
 * moving it out from under a running copy would split the archive.
 */
export function moveLegacyDataDir(
  legacyDir: string,
  targetDir: string,
  pidAlive: (pid: number) => boolean = isProcessAlive,
): LegacyMove {
  if (fs.existsSync(targetDir) || !fs.existsSync(path.join(legacyDir, 'archive.db'))) return 'none';
  if (folderInUse(legacyDir, pidAlive)) return 'in-use';
  try {
    fs.renameSync(legacyDir, targetDir);
    return 'moved';
  } catch {
    return 'failed';
  }
}

/** Chromium links `SingletonLock` to "<host>-<pid>" for as long as an app uses the folder. */
function folderInUse(dir: string, pidAlive: (pid: number) => boolean): boolean {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ArchivePaths {
  dataDir: string;
  dbPath: string;
  filesDir: string;
  logsDir: string;
  tmpDir: string;
  configPath: string;
  credentialsPath: string;
}

export function archivePaths(dataDir: string): ArchivePaths {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    dbPath: path.join(root, 'archive.db'),
    filesDir: path.join(root, 'files'),
    logsDir: path.join(root, 'logs'),
    tmpDir: path.join(root, 'tmp'),
    configPath: path.join(root, 'config.json'),
    credentialsPath: path.join(root, 'credentials.bin'),
  };
}

/**
 * An explicit archive folder: `--data-dir=<path>` on the command line or SLA_MEM_DATA_DIR
 * (demo data, tests, a second archive for another account). Null means the per-user default.
 */
export function explicitDataDir(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): string | null {
  const flag = argv.find((a) => a.startsWith('--data-dir='));
  const value = flag ? flag.slice('--data-dir='.length) : env.SLA_MEM_DATA_DIR;
  return value && value.trim() ? path.resolve(cwd, value.trim()) : null;
}

/**
 * Case-insensitive on Windows (and macOS's default filesystem): is `child` inside `parent`?
 * Used for every path derived from data the archive didn't create itself (pitfall 23).
 */
export function isInside(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (value: string) => {
    const resolved = p.resolve(value);
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
  };
  const rel = p.relative(norm(parent), norm(child));
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
}
