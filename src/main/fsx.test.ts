import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renameReplacing, renameReplacingSync, writeFileAtomicSync } from './fsx';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-fsx-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('renameReplacing (pitfall 22)', () => {
  it('replaces an existing file', async () => {
    const src = path.join(dir, 'new.tmp');
    const dest = path.join(dir, 'file.pdf');
    fs.writeFileSync(src, 'new');
    fs.writeFileSync(dest, 'old');
    await renameReplacing(src, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('new');
    expect(fs.existsSync(src)).toBe(false);
  });

  it('waits out a target that Windows reports as busy, then succeeds', async () => {
    const src = path.join(dir, 'new.tmp');
    const dest = path.join(dir, 'file.pdf');
    fs.writeFileSync(src, 'new');
    fs.writeFileSync(dest, 'old');
    const real = fs.promises.rename;
    const rename = vi
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(errno('EBUSY'))
      .mockRejectedValueOnce(errno('EPERM'))
      .mockImplementation(real);
    await renameReplacing(src, dest);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(dest, 'utf8')).toBe('new');
  });

  it('removes a target that stays locked before the last attempt', async () => {
    const src = path.join(dir, 'new.tmp');
    const dest = path.join(dir, 'file.pdf');
    fs.writeFileSync(src, 'new');
    fs.writeFileSync(dest, 'old');
    const real = fs.promises.rename;
    // Locked for as long as the old file exists (as when a viewer holds it open).
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (fs.existsSync(to)) throw errno('EPERM');
      return real(from, to);
    });
    await renameReplacing(src, dest, 3);
    expect(fs.readFileSync(dest, 'utf8')).toBe('new');
  });

  it('fails at once on errors that waiting cannot fix', async () => {
    const rename = vi.spyOn(fs.promises, 'rename');
    await expect(renameReplacing(path.join(dir, 'missing'), path.join(dir, 'x'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('has a synchronous variant for small files', () => {
    const src = path.join(dir, 'a.tmp');
    const dest = path.join(dir, 'a.json');
    fs.writeFileSync(src, '{"v":2}');
    fs.writeFileSync(dest, '{"v":1}');
    renameReplacingSync(src, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('{"v":2}');
  });
});

describe('writeFileAtomicSync', () => {
  it('creates folders, replaces the file and leaves no temp file behind', () => {
    const file = path.join(dir, 'nested', 'config.json');
    writeFileAtomicSync(file, 'one');
    writeFileAtomicSync(file, 'two', 0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['config.json']);
  });
});
