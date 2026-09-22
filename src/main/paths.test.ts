import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveLegacyDataDir, oldAppName } from './paths';

let root: string;
let oldest: string;
let legacy: string;
let target: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-paths-'));
  oldest = path.join(root, 'Slack Archive');
  legacy = path.join(root, 'sla-mem');
  target = path.join(root, 'Slamem');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function archiveIn(dir: string, file = 'a.png'): void {
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'archive.db'), 'db');
  fs.writeFileSync(path.join(dir, 'files', file), 'png');
}

describe('moveLegacyDataDir (the renames to sla-mem, then Slamem)', () => {
  it('moves an archive from the old folder name to the new one, once', () => {
    archiveIn(legacy);
    expect(moveLegacyDataDir([legacy, oldest], target, () => false)).toEqual({ outcome: 'moved', from: legacy });
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'files', 'a.png'), 'utf8')).toBe('png');
    expect(moveLegacyDataDir([legacy, oldest], target, () => false)).toEqual({ outcome: 'none', from: null });
  });

  it('moves an archive kept under the first name too, and prefers the newer name when both exist', () => {
    archiveIn(oldest);
    expect(moveLegacyDataDir([legacy, oldest], target, () => false)).toEqual({ outcome: 'moved', from: oldest });
    fs.renameSync(target, oldest);

    archiveIn(legacy, 'b.png');
    expect(moveLegacyDataDir([legacy, oldest], target, () => false)).toEqual({ outcome: 'moved', from: legacy });
    expect(fs.existsSync(path.join(target, 'files', 'b.png'))).toBe(true);
    expect(fs.existsSync(path.join(oldest, 'archive.db'))).toBe(true);
  });

  it('never touches a new folder that already holds an archive, or an old folder without one', () => {
    archiveIn(legacy);
    archiveIn(target, 'new.png');
    expect(moveLegacyDataDir([legacy], target, () => false).outcome).toBe('none');
    expect(fs.existsSync(path.join(legacy, 'archive.db'))).toBe(true);

    fs.rmSync(target, { recursive: true });
    fs.rmSync(path.join(legacy, 'archive.db'));
    expect(moveLegacyDataDir([legacy], target, () => false).outcome).toBe('none');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('never leaves an empty archive in place of the old one when the new folder appeared early', () => {
    archiveIn(legacy);
    // Something wrote into the new folder before the move (no archive in it).
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'Local State'), '{}');
    expect(moveLegacyDataDir([legacy], target, () => false)).toEqual({ outcome: 'failed', from: legacy });
    expect(fs.existsSync(path.join(legacy, 'archive.db'))).toBe(true); // used where it is

    // An empty one is simply replaced where the system allows it (not on Windows).
    fs.rmSync(path.join(target, 'Local State'));
    const move = moveLegacyDataDir([legacy], target, () => false);
    expect(move.outcome).toBe(process.platform === 'win32' ? 'failed' : 'moved');
    expect(fs.existsSync(path.join(move.outcome === 'moved' ? target : legacy, 'archive.db'))).toBe(true);
  });

  it('leaves the folder of a copy of the old app that is still running', () => {
    archiveIn(legacy);
    fs.symlinkSync('my-mac.local-4242', path.join(legacy, 'SingletonLock'));
    expect(moveLegacyDataDir([legacy], target, (pid) => pid === 4242)).toEqual({ outcome: 'in-use', from: legacy });
    expect(fs.existsSync(target)).toBe(false);
    // A lock left behind by a crash (its process is gone) doesn't count.
    expect(moveLegacyDataDir([legacy], target, () => false).outcome).toBe('moved');
  });

  it('names the old app from its folder', () => {
    expect(oldAppName('/Users/me/Library/Application Support/sla-mem')).toBe('sla-mem');
    expect(oldAppName('C:\\Users\\me\\AppData\\Roaming\\Slack Archive (dev)'.replace(/\\/g, '/'))).toBe(
      'Slack Archive',
    );
  });
});
