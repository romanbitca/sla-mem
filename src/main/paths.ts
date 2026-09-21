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
import path from 'node:path';

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
 * An explicit archive folder: `--data-dir=<path>` on the command line or SLACK_ARCHIVE_DATA_DIR
 * (demo data, tests, a second archive for another account). Null means the per-user default.
 */
export function explicitDataDir(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): string | null {
  const flag = argv.find((a) => a.startsWith('--data-dir='));
  const value = flag ? flag.slice('--data-dir='.length) : env.SLACK_ARCHIVE_DATA_DIR;
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
