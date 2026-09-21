import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveLegacyDataDir } from './paths';

let root: string;
let legacy: string;
let target: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-paths-'));
  legacy = path.join(root, 'Slack Archive');
  target = path.join(root, 'sla-mem');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function legacyArchive(): void {
  fs.mkdirSync(path.join(legacy, 'files'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'archive.db'), 'db');
  fs.writeFileSync(path.join(legacy, 'files', 'a.png'), 'png');
}

describe('moveLegacyDataDir (the rename to sla-mem)', () => {
  it('moves an archive from the old folder name to the new one, once', () => {
    legacyArchive();
    expect(moveLegacyDataDir(legacy, target, () => false)).toBe('moved');
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'files', 'a.png'), 'utf8')).toBe('png');
    expect(moveLegacyDataDir(legacy, target, () => false)).toBe('none');
  });

  it('never touches a new folder that already exists, or an old folder without an archive', () => {
    legacyArchive();
    fs.mkdirSync(target);
    expect(moveLegacyDataDir(legacy, target, () => false)).toBe('none');
    expect(fs.existsSync(path.join(legacy, 'archive.db'))).toBe(true);

    fs.rmSync(target, { recursive: true });
    fs.rmSync(path.join(legacy, 'archive.db'));
    expect(moveLegacyDataDir(legacy, target, () => false)).toBe('none');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('leaves the folder of a copy of the old app that is still running', () => {
    legacyArchive();
    fs.symlinkSync('my-mac.local-4242', path.join(legacy, 'SingletonLock'));
    expect(moveLegacyDataDir(legacy, target, (pid) => pid === 4242)).toBe('in-use');
    expect(fs.existsSync(target)).toBe(false);
    // A lock left behind by a crash (its process is gone) doesn't count.
    expect(moveLegacyDataDir(legacy, target, () => false)).toBe('moved');
  });
});
