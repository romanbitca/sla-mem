/**
 * Update and restart (PLAN §9.5): download the new version, check it, and replace the app with it
 * as the app quits, then open the new version.
 *
 * Electron's own updater (Squirrel.Mac) refuses unsigned builds, so on macOS this does what a
 * person would: once the app has quit, a small script moves the old Slamem.app aside, moves the
 * new one into its place and opens it. The download is checked against the SHA-256 GitHub lists for
 * the file, must be this app (bundle id) at the expected version, and its signature must be intact.
 * Downloaded this way the new app carries no quarantine flag, so macOS doesn't block it again.
 * On Windows the NSIS installer does the job silently (`--updated /S --force-run`), as it does for
 * electron-updater: it waits for the app to exit, installs over it and starts it.
 *
 * Nothing here runs unless the app can really replace itself (`unavailableReason`); otherwise the
 * update banner keeps its Download button.
 */
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { isGithubHost, type UpdatePackage } from './updates';

/** A failure with the words to show (`message`) and what to log (`detail`). */
export class UpdateInstallError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = 'UpdateInstallError';
  }
}

export const DOWNLOAD_FAILED = 'The download didn’t finish. Check your internet connection and try again.';
export const DOWNLOAD_DAMAGED = 'The download was damaged. Try again.';
export const PREPARE_FAILED = 'The new version couldn’t be prepared. Try again, or download it instead.';
export const INSTALL_FAILED = 'The new version couldn’t be installed. Download it instead.';

export interface DownloadOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** 0–1 as bytes arrive. */
  onProgress?: (fraction: number) => void;
  /** No data for this long ends the download (default 60 s). */
  stallMs?: number;
}

/**
 * Downloads the package into `dir` and returns the file. It must come from GitHub, be exactly the
 * size and SHA-256 the release lists, and is renamed into place only then: a file with the final
 * name is always complete.
 */
export async function downloadPackage(pkg: UpdatePackage, dir: string, opts: DownloadOptions = {}): Promise<string> {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const stallMs = opts.stallMs ?? 60_000;
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, /^[A-Za-z0-9][\w.-]*$/.test(pkg.name) ? pkg.name : 'update.bin');
  const part = `${file}.part`;
  const stalled = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stalled.signal]) : stalled.signal;
  let timer = setTimeout(() => stalled.abort(), stallMs);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stalled.abort(), stallMs);
  };
  const failed = (detail: string) => new UpdateInstallError(DOWNLOAD_FAILED, detail);
  try {
    let res: Response;
    try {
      res = await fetchImpl(pkg.url, {
        headers: { 'User-Agent': 'sla-mem-updater', Accept: 'application/octet-stream' },
        redirect: 'follow',
        signal,
      });
    } catch (err) {
      throw failed(`download of ${pkg.name} failed: ${String(err)}`);
    }
    if (!res.ok || !res.body) throw failed(`download of ${pkg.name} answered HTTP ${res.status}`);
    // GitHub redirects release files to its storage host; nowhere else.
    const from = hostOf(res.url || pkg.url);
    if (!from || !isGithubHost(from))
      throw failed(`download of ${pkg.name} was redirected to ${from ?? 'an invalid address'}`);

    const hash = createHash('sha256');
    let received = 0;
    let reported = -1;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        alive();
        hash.update(chunk);
        received += chunk.length;
        const percent = Math.min(100, Math.floor((received / pkg.size) * 100));
        if (percent !== reported) {
          reported = percent;
          opts.onProgress?.(percent / 100);
        }
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        count,
        fs.createWriteStream(part),
        { signal },
      );
    } catch (err) {
      await fs.promises.rm(part, { force: true });
      throw failed(
        stalled.signal.aborted
          ? `download of ${pkg.name} stalled after ${received} bytes`
          : `download of ${pkg.name} broke off after ${received} bytes: ${String(err)}`,
      );
    }
    const sha256 = hash.digest('hex');
    if (received !== pkg.size || sha256 !== pkg.sha256) {
      await fs.promises.rm(part, { force: true });
      throw new UpdateInstallError(
        DOWNLOAD_DAMAGED,
        `download of ${pkg.name} doesn't match the release: ${received} bytes (expected ${pkg.size}), sha256 ${sha256}`,
      );
    }
    await fs.promises.rename(part, file);
    return file;
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// ─── installers ─────────────────────────────────────────────────────────────────────────────────

/** A checked download, ready to replace the app. */
export interface PreparedUpdate {
  version: string;
  /** macOS: the new Slamem.app; Windows: the installer. */
  path: string;
}

export interface ApplyOptions {
  /** This process: the macOS script waits for it to exit. */
  pid: number;
  /** Command-line arguments the new version opens with (an explicit --data-dir). */
  args: string[];
  /** The app log: the macOS script adds what it did. */
  logFile: string;
}

export interface UpdateInstaller {
  /** Why this copy can't replace itself (logged), or null when it can. */
  unavailableReason(): string | null;
  /** Turns a verified download into something `apply` can install; `workDir` holds it. */
  prepare(file: string, pkg: UpdatePackage, workDir: string): Promise<PreparedUpdate>;
  /** The last step before the app exits: starts replacing the app, which then opens again. */
  apply(update: PreparedUpdate, opts: ApplyOptions): void;
}

type Spawn = typeof nodeSpawn;
type ExecFile = (file: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync: ExecFile = (file, args) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)} failed: ${String(stderr).trim() || err.message}`));
      else resolve({ stdout: String(stdout) });
    });
  });

export interface InstallerOptions {
  platform: NodeJS.Platform;
  /** process.execPath */
  execPath: string;
  isPackaged: boolean;
  spawn?: Spawn;
  execFile?: ExecFile;
}

/** The installer for this computer, or null where the app can only be updated by hand. */
export function createInstaller(opts: InstallerOptions): UpdateInstaller | null {
  if (!opts.isPackaged) return null;
  if (opts.platform === 'darwin') return macInstaller({ ...opts, bundlePath: path.resolve(opts.execPath, '../../..') });
  if (opts.platform === 'win32') return windowsInstaller(opts);
  return null;
}

// ─── macOS ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs detached once the app has decided to quit:
 *   sh install.sh <pid> <app> <new app> <old app> <log> <seconds> <open command> [app args…]
 * Waits (up to <seconds>) for <pid> to exit, swaps the bundles, puts the old one back if the new
 * one can't be moved in, and always opens whichever is in place, so the user is never left
 * without the app. Paths arrive as arguments, never inside the script text.
 */
export const MAC_INSTALL_SCRIPT = `#!/bin/sh
# Slamem's updater, written by the app just before it quits for an update.
pid=$1 app=$2 new=$3 old=$4 log=$5 seconds=$6 opener=$7
shift 7
note() { printf '%s %-5s Updater: %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$1" "$2" >>"$log"; }

# Replacing an app that is still running would break it.
tries=$((seconds * 10))
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries - 1))
  if [ "$tries" -le 0 ]; then
    note ERROR "Slamem didn't quit, so the new version wasn't installed"
    exit 1
  fi
  sleep 0.1
done

rm -rf "$old"
if ! mv "$app" "$old"; then
  note ERROR "couldn't move the current version aside, so it stays"
elif mv "$new" "$app"; then
  touch "$app"
  rm -rf "$old"
  note INFO "installed the new version"
else
  rm -rf "$app"
  mv "$old" "$app"
  note ERROR "couldn't move the new version into place, so the current one stays"
fi
# -n: a new instance even if macOS still counts the old one as running.
if [ $# -gt 0 ]; then "$opener" -n "$app" --args "$@"; else "$opener" -n "$app"; fi || note ERROR "couldn't open Slamem again"
`;

export interface MacInstallerOptions {
  /** The running Slamem.app. */
  bundlePath: string;
  spawn?: Spawn;
  execFile?: ExecFile;
  /** How long the script waits for the app to quit (default 60 s). */
  quitTimeoutSeconds?: number;
  /** Opens the app afterwards (default /usr/bin/open; tests record instead). */
  opener?: string;
}

export function macInstaller(opts: MacInstallerOptions): UpdateInstaller {
  const spawn = opts.spawn ?? nodeSpawn;
  const run = opts.execFile ?? execFileAsync;
  const bundle = opts.bundlePath;
  return {
    unavailableReason() {
      if (!bundle.endsWith('.app')) return `not running from an app bundle (${bundle})`;
      // Opened straight from a download, macOS runs the app from a read-only copy.
      if (bundle.includes('/AppTranslocation/')) return 'macOS runs this copy from a temporary read-only location';
      for (const p of [path.dirname(bundle), bundle]) {
        try {
          fs.accessSync(p, fs.constants.W_OK);
        } catch {
          return `no permission to change ${p}`;
        }
      }
      return null;
    },

    async prepare(file, pkg, workDir) {
      const dest = path.join(workDir, 'new');
      try {
        await fs.promises.rm(dest, { recursive: true, force: true });
        await fs.promises.mkdir(dest, { recursive: true });
        // ditto keeps the symlinks, permissions and signatures inside the bundle.
        await run('/usr/bin/ditto', ['-x', '-k', file, dest]);
        const apps = (await fs.promises.readdir(dest)).filter((name) => name.endsWith('.app'));
        if (apps.length !== 1) throw new Error(`the package holds ${apps.length} apps`);
        const app = path.join(dest, apps[0]);
        const [next, current] = await Promise.all([bundleInfo(run, app), bundleInfo(run, bundle)]);
        if (!next.id || next.id !== current.id) throw new Error(`the package is another app (${next.id})`);
        if (next.version !== pkg.version) throw new Error(`the package is version ${next.version}, not ${pkg.version}`);
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
        await fs.promises.rm(file, { force: true });
        return { version: pkg.version, path: app };
      } catch (err) {
        await fs.promises.rm(dest, { recursive: true, force: true }).catch(() => undefined);
        throw new UpdateInstallError(PREPARE_FAILED, `preparing ${pkg.name} failed: ${String(err)}`);
      }
    },

    apply(update, applyOpts) {
      const workDir = path.dirname(path.dirname(update.path));
      const script = path.join(workDir, 'install.sh');
      fs.writeFileSync(script, MAC_INSTALL_SCRIPT, { mode: 0o755 });
      const child = spawn(
        '/bin/sh',
        [
          script,
          String(applyOpts.pid),
          bundle,
          update.path,
          path.join(workDir, 'old.app'),
          applyOpts.logFile,
          String(opts.quitTimeoutSeconds ?? 60),
          opts.opener ?? '/usr/bin/open',
          ...applyOpts.args,
        ],
        { detached: true, stdio: 'ignore' },
      );
      child.unref();
    },
  };
}

async function bundleInfo(run: ExecFile, app: string): Promise<{ id: string | null; version: string | null }> {
  const { stdout } = await run('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    path.join(app, 'Contents', 'Info.plist'),
  ]);
  const plist = JSON.parse(stdout) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  return { id: text(plist.CFBundleIdentifier), version: text(plist.CFBundleShortVersionString) };
}

// ─── Windows ────────────────────────────────────────────────────────────────────────────────────

export interface WindowsInstallerOptions {
  execPath: string;
  spawn?: Spawn;
}

export function windowsInstaller(opts: WindowsInstallerOptions): UpdateInstaller {
  const spawn = opts.spawn ?? nodeSpawn;
  return {
    unavailableReason() {
      // The NSIS installer leaves its uninstaller next to the app; a copy that wasn't installed
      // that way (a zip, a portable build) would be installed over by nothing.
      const dir = path.dirname(opts.execPath);
      const uninstaller = `Uninstall ${path.basename(opts.execPath, path.extname(opts.execPath))}.exe`;
      return fs.existsSync(path.join(dir, uninstaller)) ? null : `not installed by the installer (no ${uninstaller})`;
    },

    async prepare(file, pkg) {
      return { version: pkg.version, path: file };
    },

    apply(update) {
      // electron-builder's NSIS installer: --updated waits for the app to exit instead of asking,
      // /S installs silently, --force-run starts the app when done.
      const child = spawn(update.path, ['--updated', '/S', '--force-run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    },
  };
}
