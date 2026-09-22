import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleRenameFor, renameOldBundle, REOPEN_SCRIPT } from './bundle-rename';

let dir: string;
const sleepers: ChildProcess[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slamem-rename-'));
});

afterEach(() => {
  for (const p of sleepers.splice(0)) p.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The app's paths are macOS ones wherever the tests run.
const exec = (bundle: string) => path.posix.join(bundle, 'Contents', 'MacOS', 'Slamem');
const nothingThere = () => false;

describe('bundleRenameFor', () => {
  it('renames a copy still called sla-mem.app to Slamem.app, where it is', () => {
    expect(bundleRenameFor(exec('/Applications/sla-mem.app'), nothingThere)).toEqual({
      from: '/Applications/sla-mem.app',
      to: '/Applications/Slamem.app',
    });
    expect(bundleRenameFor(exec('/Users/me/Applications/sla-mem.app'), nothingThere)?.to).toBe(
      '/Users/me/Applications/Slamem.app',
    );
  });

  it('leaves every other copy alone', () => {
    expect(bundleRenameFor(exec('/Applications/Slamem.app'), nothingThere)).toBeNull();
    expect(bundleRenameFor(exec('/Applications/My Slack copy.app'), nothingThere)).toBeNull();
    // Run from a download, macOS uses a temporary read-only copy.
    expect(
      bundleRenameFor(exec('/private/var/folders/x/T/AppTranslocation/1234/d/sla-mem.app'), nothingThere),
    ).toBeNull();
    // A Slamem.app is already there (installed from the disk image): never replace it.
    expect(bundleRenameFor(exec('/Applications/sla-mem.app'), (p) => p === '/Applications/Slamem.app')).toBeNull();
  });
});

describe('renameOldBundle', () => {
  const options = (overrides: Partial<Parameters<typeof renameOldBundle>[0]> = {}) => ({
    execPath: exec('/Applications/sla-mem.app'),
    pid: 4242,
    args: ['--data-dir=/Users/me/Other archive', '-psn_0_12345'],
    exists: nothingThere,
    rename: vi.fn(),
    spawn: vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof spawn,
    opener: '/usr/bin/open',
    ...overrides,
  });

  it('renames the bundle and hands over to a script that opens it again once this process is gone', () => {
    const opts = options();
    expect(renameOldBundle(opts)).toBe(true);
    expect(opts.rename).toHaveBeenCalledWith('/Applications/sla-mem.app', '/Applications/Slamem.app');
    expect(opts.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [
        '-c',
        REOPEN_SCRIPT,
        'reopen',
        '4242',
        '/Applications/Slamem.app',
        '/usr/bin/open',
        '--data-dir=/Users/me/Other archive',
      ],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('starts normally when there is nothing to rename or the folder can’t be changed', () => {
    const current = options({ execPath: exec('/Applications/Slamem.app') });
    expect(renameOldBundle(current)).toBe(false);
    expect(current.rename).not.toHaveBeenCalled();

    const locked = options({
      rename: vi.fn(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }),
    });
    expect(renameOldBundle(locked)).toBe(false);
    expect(locked.spawn).not.toHaveBeenCalled();
  });

  it('puts the old name back when nothing could open the app again', () => {
    const opts = options({
      spawn: vi.fn(() => {
        throw new Error('spawn failed');
      }) as unknown as typeof spawn,
    });
    expect(renameOldBundle(opts)).toBe(false);
    expect(opts.rename).toHaveBeenNthCalledWith(2, '/Applications/Slamem.app', '/Applications/sla-mem.app');
  });
});

describe.skipIf(process.platform === 'win32')('the reopen script', () => {
  const opened = () => path.join(dir, 'opened');

  function run(pid: number, args: string[] = []): Promise<number | null> {
    const opener = path.join(dir, 'open.sh');
    fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s\\n' "$@" > '${opened()}'\n`, { mode: 0o755 });
    const child = spawn(
      '/bin/sh',
      ['-c', REOPEN_SCRIPT, 'reopen', String(pid), '/Applications/Slamem.app', opener, ...args],
      {
        stdio: 'ignore',
      },
    );
    return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  }

  it('waits for the old process to exit, then opens the renamed app with the same arguments', async () => {
    const running = spawn('sleep', ['30'], { stdio: 'ignore' });
    sleepers.push(running);
    const done = run(running.pid!, ['--data-dir=/Users/me/Other archive']);
    await new Promise((r) => setTimeout(r, 400));
    expect(fs.existsSync(opened())).toBe(false);
    running.kill('SIGKILL');
    expect(await done).toBe(0);
    expect(fs.readFileSync(opened(), 'utf8')).toBe(
      '-n\n/Applications/Slamem.app\n--args\n--data-dir=/Users/me/Other archive\n',
    );
  });

  it('opens it straight away when the old process is already gone', async () => {
    expect(await run(999_999)).toBe(0);
    expect(fs.readFileSync(opened(), 'utf8')).toBe('-n\n/Applications/Slamem.app\n');
  });
});
