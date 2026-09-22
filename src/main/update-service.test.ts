import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunKind, UpdateInfoDTO, UpdateInstallState } from '../shared/types';
import { AppError } from './errors';
import {
  DOWNLOAD_DAMAGED,
  INSTALL_FAILED,
  PREPARE_FAILED,
  UpdateInstallError,
  type ApplyOptions,
  type PreparedUpdate,
  type UpdateInstaller,
} from './update-install';
import { restartWhenIdle, UpdateService, type UpdateServiceOptions } from './update-service';
import type { GithubRelease, UpdatePackage } from './updates';

let dir: string;
let lines: string[];
const services: UpdateService[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-mem-updates-'));
  lines = [];
});

afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const zip = Buffer.from('Slamem 1.3.0 for Apple silicon '.repeat(5_000));

function release(overrides: Partial<GithubRelease> = {}): GithubRelease {
  const base = 'https://github.com/o/r/releases/download/v1.3.0';
  return {
    tag_name: 'v1.3.0',
    html_url: 'https://github.com/o/r/releases/tag/v1.3.0',
    body: 'Syncs are faster.',
    assets: [
      {
        name: 'Slamem-1.3.0-arm64-mac.zip',
        browser_download_url: `${base}/Slamem-1.3.0-arm64-mac.zip`,
        size: zip.length,
        digest: `sha256:${sha256(zip)}`,
      },
      { name: 'Slamem-1.3.0-arm64.dmg', browser_download_url: `${base}/Slamem-1.3.0-arm64.dmg`, size: 1 },
    ],
    ...overrides,
  };
}

/** GitHub: the latest release from the API, and the files from their download links. */
function github(opts: { release?: GithubRelease; files?: () => Buffer; hang?: boolean } = {}) {
  const downloads: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/')) return Response.json(opts.release ?? release());
    downloads.push(url);
    const body = (opts.files ?? (() => zip))();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.length; i += 16_384) controller.enqueue(body.subarray(i, i + 16_384));
        if (!opts.hang) controller.close();
      },
    });
    const res = new Response(stream);
    Object.defineProperty(res, 'url', { value: 'https://release-assets.githubusercontent.com/file' });
    return res;
  };
  return { fetch: fetchImpl as unknown as typeof fetch, downloads };
}

class FakeInstaller implements UpdateInstaller {
  reason: string | null = null;
  failPrepare = false;
  prepared: Array<{ file: string; pkg: UpdatePackage }> = [];
  applied: Array<{ update: PreparedUpdate; opts: ApplyOptions }> = [];
  unavailableReason() {
    return this.reason;
  }
  async prepare(file: string, pkg: UpdatePackage) {
    if (this.failPrepare) throw new UpdateInstallError(PREPARE_FAILED, 'the package holds 0 apps');
    this.prepared.push({ file, pkg });
    return { version: pkg.version, path: file };
  }
  apply(update: PreparedUpdate, opts: ApplyOptions) {
    this.applied.push({ update, opts });
  }
}

const workDir = () => path.join(dir, 'tmp', 'update');

function service(opts: Partial<UpdateServiceOptions> = {}): UpdateService {
  const s = new UpdateService({
    repo: 'o/r',
    currentVersion: '1.2.0',
    platform: 'darwin',
    arch: 'arm64',
    fetch: github().fetch,
    installer: new FakeInstaller(),
    workDir: workDir(),
    log: (line) => lines.push(line),
    ...opts,
  });
  services.push(s);
  return s;
}

function once<T>(s: UpdateService, event: 'ready'): Promise<T> {
  return new Promise((resolve) => s.once(event, resolve));
}

function reaches(s: UpdateService, state: UpdateInstallState): Promise<UpdateInfoDTO> {
  return new Promise((resolve) => {
    const listener = (info: UpdateInfoDTO) => {
      if (info.install.state !== state) return;
      s.off('changed', listener);
      resolve(info);
    };
    s.on('changed', listener);
  });
}

function blockedError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('blocked');
    return err as AppError;
  }
  throw new Error('expected a blocked error');
}

describe('Update and restart', () => {
  it('downloads and checks the new version, then notes which version the restart brings', async () => {
    const installer = new FakeInstaller();
    const { fetch, downloads } = github();
    const s = service({ installer, fetch });
    expect((await s.check()).canInstall).toBe(true);
    const progress: number[] = [];
    s.on('changed', (info: UpdateInfoDTO) => {
      if (info.install.state === 'downloading') progress.push(info.install.progress ?? -1);
    });
    const ready = once<PreparedUpdate>(s, 'ready');
    expect(s.installUpdate().install).toEqual({ state: 'downloading', progress: 0, waitingFor: null, error: null });
    const prepared = await ready;

    expect(downloads).toEqual(['https://github.com/o/r/releases/download/v1.3.0/Slamem-1.3.0-arm64-mac.zip']);
    expect(installer.prepared).toHaveLength(1);
    expect(fs.readFileSync(installer.prepared[0].file).equals(zip)).toBe(true);
    expect(progress.at(-1)).toBe(1);
    expect(progress.length).toBeGreaterThan(3);

    s.markWaiting('sync');
    expect(s.info().install).toEqual({ state: 'waiting', progress: null, waitingFor: 'sync', error: null });
    s.markRestarting();
    const opts = { pid: 42, args: ['--data-dir=/x'], logFile: '/logs/main.log' };
    expect(s.applyPrepared(opts)).toBe(true);
    expect(installer.applied).toEqual([{ update: prepared, opts }]);
    expect(JSON.parse(fs.readFileSync(path.join(workDir(), 'pending.json'), 'utf8'))).toMatchObject({
      from: '1.2.0',
      to: '1.3.0',
    });
    expect(s.applyPrepared(opts)).toBe(false); // handed over once
    expect(lines).toContain('Update 1.3.0 downloaded and checked');
  });

  it('is only offered for a newer version this copy can install', async () => {
    blockedError(() => service().installUpdate()); // nothing checked yet

    const installer = new FakeInstaller();
    installer.reason = 'no permission to change /Applications';
    const readOnly = service({ installer });
    expect((await readOnly.check()).canInstall).toBe(false);
    blockedError(() => readOnly.installUpdate());
    expect(lines).toContain('Updates are downloaded by hand: no permission to change /Applications');

    const noDigest = release();
    delete noDigest.assets![0].digest;
    expect((await service({ fetch: github({ release: noDigest }).fetch }).check()).canInstall).toBe(false);
    expect((await service({ installer: null }).check()).canInstall).toBe(false);
    expect((await service({ currentVersion: '1.3.0' }).check()).canInstall).toBe(false);
  });

  it('asking again while it downloads changes nothing', async () => {
    const { fetch, downloads } = github();
    const s = service({ fetch });
    await s.check();
    const ready = once(s, 'ready');
    s.installUpdate();
    expect(s.installUpdate().install.state).toBe('downloading');
    await ready;
    expect(downloads).toHaveLength(1);
  });

  it('a damaged download fails with words to show, and Try again starts over', async () => {
    let attempt = 0;
    const damaged = Buffer.from(zip);
    damaged[0] ^= 1;
    const { fetch, downloads } = github({ files: () => (++attempt === 1 ? damaged : zip) });
    const s = service({ fetch });
    await s.check();
    const failed = reaches(s, 'failed');
    s.installUpdate();
    expect((await failed).install).toEqual({
      state: 'failed',
      progress: null,
      waitingFor: null,
      error: DOWNLOAD_DAMAGED,
    });
    expect(lines.some((l) => l.startsWith('Update 1.3.0 failed: download of Slamem-1.3.0-arm64-mac.zip doesn'))).toBe(
      true,
    );
    await vi.waitFor(() => expect(fs.existsSync(workDir())).toBe(false));

    const ready = once(s, 'ready');
    expect(s.installUpdate().install.state).toBe('downloading');
    await ready;
    expect(downloads).toHaveLength(2);
  });

  it('says why when the new version can’t be prepared', async () => {
    const installer = new FakeInstaller();
    installer.failPrepare = true;
    const s = service({ installer });
    await s.check();
    const failed = reaches(s, 'failed');
    s.installUpdate();
    expect((await failed).install.error).toBe(PREPARE_FAILED);
    expect(lines).toContain('Update 1.3.0 failed: the package holds 0 apps');
  });

  it('quitting during the download stops it without calling it a failure', async () => {
    const s = service({ fetch: github({ hang: true }).fetch });
    await s.check();
    const events: string[] = [];
    s.on('changed', (info: UpdateInfoDTO) => events.push(info.install.state));
    s.on('ready', () => events.push('ready'));
    s.installUpdate();
    await new Promise((r) => setTimeout(r, 50));
    s.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(events.every((e) => e === 'downloading')).toBe(true);
    expect(s.applyPrepared({ pid: 1, args: [], logFile: 'x' })).toBe(false);
  });

  it('after the restart, says in the log whether the update took, and shows it when it didn’t', async () => {
    const note = (from: string, to: string) => {
      fs.mkdirSync(path.join(workDir(), 'new', 'Slamem.app'), { recursive: true });
      fs.writeFileSync(path.join(workDir(), 'pending.json'), JSON.stringify({ from, to, at: 1 }));
    };

    note('1.2.0', '1.3.0');
    const updated = service({ currentVersion: '1.3.0' });
    updated.start();
    expect(updated.info().install.state).toBe('idle');
    expect(lines).toContain('Updated to 1.3.0 (from 1.2.0)');
    await vi.waitFor(() => expect(fs.existsSync(workDir())).toBe(false));

    note('1.2.0', '1.3.0');
    const stillOld = service({ currentVersion: '1.2.0' });
    stillOld.start();
    expect(stillOld.info().install).toEqual({
      state: 'failed',
      progress: null,
      waitingFor: null,
      error: INSTALL_FAILED,
    });
    expect(lines).toContain('The update to 1.3.0 didn’t install; still 1.2.0');
    await vi.waitFor(() => expect(fs.existsSync(workDir())).toBe(false));
  });
});

describe('restarting for the update', () => {
  function fakeRuns(kinds: Array<RunKind | null>) {
    const finish: Array<() => void> = [];
    return {
      finish,
      runs: {
        activeKind: () => kinds[0] ?? null,
        wait: () =>
          new Promise<null>((resolve) =>
            finish.push(() => {
              kinds.shift();
              resolve(null);
            }),
          ),
      },
    };
  }

  it('lets a sync or import that is under way finish first, and starts no new one meanwhile', async () => {
    const { runs, finish } = fakeRuns(['import', 'sync', null]);
    const calls: string[] = [];
    const done = restartWhenIdle({
      runs,
      scheduler: { stop: () => calls.push('scheduler stopped') },
      updates: {
        markWaiting: (kind) => calls.push(`waiting for ${kind}`),
        markRestarting: () => calls.push('restarting'),
      },
      quit: () => calls.push('quit'),
    });
    expect(calls).toEqual(['scheduler stopped', 'waiting for import']);
    finish.shift()!();
    await vi.waitFor(() => expect(calls).toContain('waiting for sync'));
    expect(calls).not.toContain('quit');
    finish.shift()!();
    await done;
    expect(calls).toEqual(['scheduler stopped', 'waiting for import', 'waiting for sync', 'restarting', 'quit']);
  });

  it('restarts at once when nothing is running', async () => {
    const calls: string[] = [];
    await restartWhenIdle({
      runs: fakeRuns([null]).runs,
      scheduler: { stop: () => calls.push('scheduler stopped') },
      updates: { markWaiting: () => calls.push('waiting'), markRestarting: () => calls.push('restarting') },
      quit: () => calls.push('quit'),
    });
    expect(calls).toEqual(['scheduler stopped', 'restarting', 'quit']);
  });
});
