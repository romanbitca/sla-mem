import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInstaller,
  DOWNLOAD_DAMAGED,
  DOWNLOAD_FAILED,
  downloadPackage,
  MAC_INSTALL_SCRIPT,
  macInstaller,
  PREPARE_FAILED,
  UpdateInstallError,
  windowsInstaller,
} from './update-install';
import type { UpdatePackage } from './updates';

let dir: string;
const sleepers: ChildProcess[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-mem-update-'));
});

afterEach(() => {
  for (const p of sleepers.splice(0)) p.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const bytes = Buffer.from('the new version of sla-mem '.repeat(8_000));

function pkg(overrides: Partial<UpdatePackage> = {}): UpdatePackage {
  return {
    version: '1.3.0',
    name: 'sla-mem-1.3.0-arm64-mac.zip',
    url: 'https://github.com/o/r/releases/download/v1.3.0/sla-mem-1.3.0-arm64-mac.zip',
    size: bytes.length,
    sha256: sha256(bytes),
    ...overrides,
  };
}

/** A fetch that answers with `body` in chunks, as GitHub does after redirecting to its file host. */
function serve(
  body: Buffer,
  opts: { status?: number; finalUrl?: string; hang?: boolean } = {},
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request) => {
    calls.push(String(input));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += 16_384) controller.enqueue(body.subarray(i, i + 16_384));
        if (!opts.hang) controller.close();
      },
    });
    const res = new Response(stream, { status: opts.status ?? 200 });
    Object.defineProperty(res, 'url', { value: opts.finalUrl ?? 'https://release-assets.githubusercontent.com/a/b' });
    return res;
  };
  return Object.assign(impl, { calls }) as unknown as typeof fetch & { calls: string[] };
}

async function failure(promise: Promise<unknown>): Promise<UpdateInstallError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UpdateInstallError);
  return err as UpdateInstallError;
}

describe('downloading an update', () => {
  it('saves the package, reporting progress, once it matches the release', async () => {
    const progress: number[] = [];
    const file = await downloadPackage(pkg(), dir, { fetch: serve(bytes), onProgress: (p) => progress.push(p) });
    expect(file).toBe(path.join(dir, 'sla-mem-1.3.0-arm64-mac.zip'));
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['sla-mem-1.3.0-arm64-mac.zip']);
    expect(progress.length).toBeGreaterThan(3);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
  });

  it('never keeps a download that differs from the release (damaged, or not the file GitHub lists)', async () => {
    const tampered = Buffer.from(bytes);
    tampered[100] ^= 1;
    const damaged = await failure(downloadPackage(pkg(), dir, { fetch: serve(tampered) }));
    expect(damaged.message).toBe(DOWNLOAD_DAMAGED);
    expect(damaged.detail).toContain(`sha256 ${sha256(tampered)}`);
    const short = await failure(downloadPackage(pkg(), dir, { fetch: serve(bytes.subarray(0, 1_000)) }));
    expect(short.message).toBe(DOWNLOAD_DAMAGED);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('downloads only from GitHub', async () => {
    const err = await failure(
      downloadPackage(pkg(), dir, { fetch: serve(bytes, { finalUrl: 'https://evil.example/x.zip' }) }),
    );
    expect(err.message).toBe(DOWNLOAD_FAILED);
    expect(err.detail).toContain('redirected to evil.example');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('says so when the download fails or stalls, leaving nothing half-written', async () => {
    const http = await failure(downloadPackage(pkg(), dir, { fetch: serve(bytes, { status: 503 }) }));
    expect(http.message).toBe(DOWNLOAD_FAILED);
    const offline = await failure(
      downloadPackage(pkg(), dir, {
        fetch: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
      }),
    );
    expect(offline.message).toBe(DOWNLOAD_FAILED);
    const stalled = await failure(
      downloadPackage(pkg(), dir, { fetch: serve(bytes.subarray(0, 50_000), { hang: true }), stallMs: 150 }),
    );
    expect(stalled.message).toBe(DOWNLOAD_FAILED);
    expect(stalled.detail).toContain('stalled after 50000 bytes');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

// ─── macOS ──────────────────────────────────────────────────────────────────────────────────────

/** A stand-in for the running app: a process whose pid the script waits on. */
function runningApp(): ChildProcess {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  sleepers.push(child);
  return child;
}

function fakeBundle(where: string, version: string): void {
  fs.mkdirSync(path.join(where, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(where, 'Contents', 'version'), version);
}

const versionOf = (app: string) => fs.readFileSync(path.join(app, 'Contents', 'version'), 'utf8');

describe.skipIf(process.platform === 'win32')('the macOS install script', () => {
  const apps = () => path.join(dir, 'Applications');
  const app = () => path.join(apps(), 'sla-mem.app');
  const work = () => path.join(dir, 'update');
  const newApp = () => path.join(work(), 'new', 'sla-mem.app');
  const log = () => path.join(dir, 'main.log');
  const opened = () => path.join(dir, 'opened');

  beforeEach(() => {
    fakeBundle(app(), '1.2.0');
    fakeBundle(newApp(), '1.3.0');
  });

  /** Runs the script like the app does, with an opener that writes down what it was asked to open. */
  function run(pid: number, opts: { seconds?: number; args?: string[] } = {}): Promise<number | null> {
    const script = path.join(work(), 'install.sh');
    fs.writeFileSync(script, MAC_INSTALL_SCRIPT, { mode: 0o755 });
    const opener = path.join(dir, 'open.sh');
    fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$@" > '${opened()}'\n`, { mode: 0o755 });
    const child = spawn(
      '/bin/sh',
      [
        script,
        String(pid),
        app(),
        newApp(),
        path.join(work(), 'old.app'),
        log(),
        String(opts.seconds ?? 20),
        opener,
        ...(opts.args ?? []),
      ],
      { stdio: 'ignore' },
    );
    return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  }

  it('waits for the app to quit, replaces it, and opens the new version with the same archive folder', async () => {
    const running = runningApp();
    const done = run(running.pid!, { args: ['--data-dir=/Users/me/Other archive'] });
    await new Promise((r) => setTimeout(r, 400));
    expect(versionOf(app())).toBe('1.2.0'); // still running: untouched
    expect(fs.existsSync(opened())).toBe(false);
    running.kill('SIGKILL');
    expect(await done).toBe(0);
    expect(versionOf(app())).toBe('1.3.0');
    expect(fs.existsSync(newApp())).toBe(false);
    expect(fs.existsSync(path.join(work(), 'old.app'))).toBe(false);
    expect(fs.readFileSync(opened(), 'utf8')).toBe(`-n\n${app()}\n--args\n--data-dir=/Users/me/Other archive\n`);
    expect(fs.readFileSync(log(), 'utf8')).toMatch(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO {2}Updater: installed the new version\n$/,
    );
  });

  it('keeps the current version, and still opens it, when the new one can’t be moved in', async () => {
    fs.rmSync(newApp(), { recursive: true });
    expect(await run(999_999)).toBe(0);
    expect(versionOf(app())).toBe('1.2.0');
    expect(fs.readFileSync(opened(), 'utf8')).toBe(`-n\n${app()}\n`);
    expect(fs.readFileSync(log(), 'utf8')).toContain(
      "ERROR Updater: couldn't move the new version into place, so the current one stays",
    );
  });

  it('never replaces an app that is still running', async () => {
    const running = runningApp();
    expect(await run(running.pid!, { seconds: 1 })).toBe(1);
    expect(versionOf(app())).toBe('1.2.0');
    expect(versionOf(newApp())).toBe('1.3.0');
    expect(fs.existsSync(opened())).toBe(false);
    expect(fs.readFileSync(log(), 'utf8')).toContain("sla-mem didn't quit, so the new version wasn't installed");
  });
});

describe.skipIf(process.platform === 'win32')('whether this Mac copy can replace itself', () => {
  it('only from an app bundle it may change, and not from macOS’s read-only copy of a download', () => {
    const parent = path.join(dir, 'Applications');
    const bundle = path.join(parent, 'sla-mem.app');
    fs.mkdirSync(bundle, { recursive: true });
    expect(macInstaller({ bundlePath: bundle }).unavailableReason()).toBeNull();
    expect(macInstaller({ bundlePath: path.join(dir, 'sla-mem') }).unavailableReason()).toMatch(
      /not running from an app/,
    );
    expect(
      macInstaller({
        bundlePath: '/private/var/folders/x/AppTranslocation/1234/d/sla-mem.app',
      }).unavailableReason(),
    ).toMatch(/read-only/);
    if (process.getuid?.() !== 0) {
      fs.chmodSync(parent, 0o555);
      try {
        expect(macInstaller({ bundlePath: bundle }).unavailableReason()).toBe(`no permission to change ${parent}`);
      } finally {
        fs.chmodSync(parent, 0o755);
      }
    }
  });

  it('writes the script and starts it detached, so it outlives the app', () => {
    const child = { unref: vi.fn() };
    const spawnMock = vi.fn(() => child);
    const work = path.join(dir, 'update');
    fs.mkdirSync(path.join(work, 'new', 'sla-mem.app'), { recursive: true });
    const installer = macInstaller({
      bundlePath: '/Applications/sla-mem.app',
      spawn: spawnMock as unknown as typeof spawn,
    });
    installer.apply(
      { version: '1.3.0', path: path.join(work, 'new', 'sla-mem.app') },
      { pid: 4242, args: ['--data-dir=/x'], logFile: '/logs/main.log' },
    );
    const script = path.join(work, 'install.sh');
    expect(fs.readFileSync(script, 'utf8')).toBe(MAC_INSTALL_SCRIPT);
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/sh',
      [
        script,
        '4242',
        '/Applications/sla-mem.app',
        path.join(work, 'new', 'sla-mem.app'),
        path.join(work, 'old.app'),
        '/logs/main.log',
        '60',
        '/usr/bin/open',
        '--data-dir=/x',
      ],
      { detached: true, stdio: 'ignore' },
    );
    expect(child.unref).toHaveBeenCalled();
  });
});

describe.runIf(process.platform === 'darwin')('preparing a macOS update', () => {
  const plist = (id: string, version: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>sla-mem</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;

  /** A tiny app bundle, signed ad hoc like the release builds. */
  function bundle(root: string, version: string, id = 'com.9h.sla-mem'): string {
    const app = path.join(root, 'sla-mem.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
    fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents', 'MacOS', 'sla-mem'));
    fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'), `app ${version}`);
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(id, version));
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
    return app;
  }

  function zipOf(app: string, name: string): string {
    const zip = path.join(dir, name);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    return zip;
  }

  const current = () => bundle(path.join(dir, 'Applications'), '1.2.0');

  it('unpacks the new version and checks it is this app, at that version, intact', async () => {
    const installer = macInstaller({ bundlePath: current() });
    const zip = zipOf(bundle(path.join(dir, 'build'), '1.3.0'), 'new.zip');
    const work = path.join(dir, 'update');
    const prepared = await installer.prepare(zip, pkg(), work);
    expect(prepared).toEqual({ version: '1.3.0', path: path.join(work, 'new', 'sla-mem.app') });
    expect(fs.readFileSync(path.join(prepared.path, 'Contents', 'Resources', 'app.asar'), 'utf8')).toBe('app 1.3.0');
    expect(fs.existsSync(zip)).toBe(false); // not needed any more
  });

  it('refuses another app, another version, or a damaged one', async () => {
    const installer = macInstaller({ bundlePath: current() });
    const work = path.join(dir, 'update');
    const other = zipOf(bundle(path.join(dir, 'other'), '1.3.0', 'com.example.other'), 'other.zip');
    const wrongVersion = zipOf(bundle(path.join(dir, 'old'), '1.2.5'), 'old.zip');
    const damagedApp = bundle(path.join(dir, 'damaged'), '1.3.0');
    fs.writeFileSync(path.join(damagedApp, 'Contents', 'Resources', 'app.asar'), 'changed after signing');
    const damaged = zipOf(damagedApp, 'damaged.zip');
    for (const [zip, reason] of [
      [other, 'another app (com.example.other)'],
      [wrongVersion, 'version 1.2.5, not 1.3.0'],
      [damaged, 'codesign failed'],
    ]) {
      const err = await failure(installer.prepare(zip, pkg(), work));
      expect(err.message).toBe(PREPARE_FAILED);
      expect(err.detail).toContain(reason);
      expect(fs.existsSync(path.join(work, 'new'))).toBe(false);
    }
  });
});

// ─── Windows ────────────────────────────────────────────────────────────────────────────────────

describe('the Windows installer', () => {
  it('only where the installer put the app (its uninstaller is next to it)', () => {
    const exe = path.join(dir, 'sla-mem.exe');
    const installer = windowsInstaller({ execPath: exe });
    expect(installer.unavailableReason()).toBe('not installed by the installer (no Uninstall sla-mem.exe)');
    fs.writeFileSync(path.join(dir, 'Uninstall sla-mem.exe'), '');
    expect(installer.unavailableReason()).toBeNull();
  });

  it('installs silently once the app has exited, then starts it', async () => {
    const child = { unref: vi.fn() };
    const spawnMock = vi.fn(() => child);
    const installer = windowsInstaller({ execPath: 'C:\\sla-mem.exe', spawn: spawnMock as unknown as typeof spawn });
    const prepared = await installer.prepare('C:\\update\\sla-mem-setup-1.3.0.exe', pkg(), 'C:\\update');
    installer.apply(prepared, { pid: 1, args: [], logFile: 'x' });
    expect(spawnMock).toHaveBeenCalledWith('C:\\update\\sla-mem-setup-1.3.0.exe', ['--updated', '/S', '--force-run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(child.unref).toHaveBeenCalled();
  });
});

describe('which installer', () => {
  it('none for development builds or Linux', () => {
    expect(createInstaller({ platform: 'darwin', execPath: '/x/Electron', isPackaged: false })).toBeNull();
    expect(createInstaller({ platform: 'linux', execPath: '/opt/sla-mem/sla-mem', isPackaged: true })).toBeNull();
    expect(
      createInstaller({
        platform: 'darwin',
        execPath: '/Applications/sla-mem.app/Contents/MacOS/sla-mem',
        isPackaged: true,
      }),
    ).not.toBeNull();
    expect(
      createInstaller({ platform: 'win32', execPath: 'C:\\sla-mem\\sla-mem.exe', isPackaged: true }),
    ).not.toBeNull();
  });
});
