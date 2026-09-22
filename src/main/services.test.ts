import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { getFileRow, markFileDownloaded, openDb, upsertMessages, type DB } from './db';
import { backupArchive } from './backup';
import { archivePaths, isInside } from './paths';
import { deleteAttachmentsOlderThan, storageInfo, storageWarning } from './storage';
import { checkForUpdate, compareVersions, describeRelease, parseVersion, pickAsset, pickPackage } from './updates';
import { redactSecrets, containsSlackSecret } from './redact';
import { createLogger } from './logger';
import { Preferences } from './preferences';
import { serveArchiveFile, parseRange } from './protocol';
import { isSafeExternalUrl } from './security-urls';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-services-'));
  db = openDb(path.join(dir, 'archive.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addFile(id: string, name: string, bytes: string | Buffer, opts: { created?: number; mimetype?: string } = {}) {
  upsertMessages(
    db,
    'C1',
    [
      {
        ts: `${1_700_000_000 + Number(id.replace(/\D/g, '') || 1)}.000100`,
        user: 'U1',
        text: 'file',
        files: [
          {
            id,
            name,
            mimetype: opts.mimetype ?? 'image/png',
            url_private: `https://files.slack.com/${id}`,
            created: opts.created ?? 1_700_000_000,
          },
        ],
      },
    ],
    'api',
  );
  const rel = path.join(id, name);
  fs.mkdirSync(path.join(dir, 'files', id), { recursive: true });
  fs.writeFileSync(path.join(dir, 'files', rel), bytes);
  markFileDownloaded(db, id, rel);
}

describe('storage', () => {
  it('reports the archive’s disk usage split into database and attachments', async () => {
    addFile('F1', 'a.png', Buffer.alloc(4096, 1));
    const info = await storageInfo(db, archivePaths(dir));
    expect(info.attachmentsBytes).toBe(4096);
    expect(info.databaseBytes).toBeGreaterThan(0);
    expect(info.filesDownloaded).toBe(1);
    expect(info.totalBytes).toBe(info.databaseBytes + info.attachmentsBytes + info.logsBytes);
    expect(info.diskFreeBytes === null || info.diskFreeBytes > 0).toBe(true);
  });

  it('warns about a nearly full disk before a large archive', () => {
    expect(storageWarning(1e9, 1e12)).toBeNull();
    expect(storageWarning(30 * 1024 ** 3, 1e12)).toMatch(/getting large/);
    expect(storageWarning(1e9, 1024 ** 3)).toMatch(/nearly full/);
  });

  it('deletes only old attachment copies, never messages, and keeps them from being re-downloaded', async () => {
    const now = new Date(2026, 8, 21);
    const old = Math.floor(new Date(2025, 0, 1).getTime() / 1000);
    const recent = Math.floor(new Date(2026, 7, 1).getTime() / 1000);
    addFile('F1', 'old.png', 'x'.repeat(100), { created: old });
    addFile('F2', 'new.png', 'y'.repeat(50), { created: recent });
    const result = await deleteAttachmentsOlderThan(db, path.join(dir, 'files'), 6, now);
    expect(result).toEqual({ filesRemoved: 1, bytesFreed: 100 });
    expect(fs.existsSync(path.join(dir, 'files', 'F1', 'old.png'))).toBe(false);
    expect(getFileRow(db, 'F1')).toMatchObject({
      download_status: 'skipped',
      skip_reason: 'removed',
      local_path: null,
    });
    expect(getFileRow(db, 'F2')!.download_status).toBe('done');
    expect((db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(2);
  });
});

describe('backup', () => {
  it('produces a zip that restores to a working archive', async () => {
    addFile('F1', 'photo.png', 'PNGDATA');
    fs.writeFileSync(path.join(dir, 'config.json'), '{"preferences":{}}');
    fs.writeFileSync(path.join(dir, 'credentials.bin'), 'secret-bytes');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-backup-'));
    try {
      const result = await backupArchive({
        db,
        paths: archivePaths(dir),
        destDir: dest,
        now: new Date(2026, 8, 21, 9, 5),
      });
      expect(path.basename(result.path)).toBe('Slamem backup 2026-09-21 0905.zip');
      const entries = await unzip(result.path, path.join(dest, 'restored'));
      expect(entries.sort()).toEqual(['README.txt', 'archive.db', 'config.json', 'files/F1/photo.png']);
      const restored = openDb(path.join(dest, 'restored', 'archive.db'));
      expect((restored.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
      restored.close();
      expect(fs.readFileSync(path.join(dest, 'restored', 'files', 'F1', 'photo.png'), 'utf8')).toBe('PNGDATA');
      // A second backup the same minute doesn't overwrite the first.
      const second = await backupArchive({
        db,
        paths: archivePaths(dir),
        destDir: dest,
        now: new Date(2026, 8, 21, 9, 5),
      });
      expect(path.basename(second.path)).toBe('Slamem backup 2026-09-21 0905 (2).zip');
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});

async function unzip(zipPath: string, into: string): Promise<string[]> {
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true });
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      names.push(entry.fileName);
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err);
        const out = path.join(into, entry.fileName);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        stream.pipe(fs.createWriteStream(out)).on('finish', () => zip.readEntry());
      });
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });
  zip.close();
  return names;
}

describe('updates', () => {
  const assets = [
    {
      name: 'Slamem-1.2.0-arm64.dmg',
      browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/Slamem-1.2.0-arm64.dmg',
    },
    {
      name: 'Slamem-1.2.0.dmg',
      browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/Slamem-1.2.0.dmg',
    },
    {
      name: 'Slamem-setup-1.2.0.exe',
      browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/Slamem-setup-1.2.0.exe',
    },
    {
      name: 'Slamem-setup-1.2.0.exe.blockmap',
      browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/x.blockmap',
    },
  ];

  it('compares semantic versions', () => {
    expect(parseVersion('v1.10.0')).toEqual([1, 10, 0]);
    expect(parseVersion('1.2.0-beta.1')).toBeNull();
    expect(compareVersions([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0);
  });

  it('picks the installer for this computer', () => {
    expect(pickAsset(assets, 'darwin', 'arm64')).toMatch(/arm64\.dmg$/);
    expect(pickAsset(assets, 'darwin', 'x64')).toMatch(/1\.2\.0\.dmg$/);
    expect(pickAsset(assets, 'win32', 'x64')).toMatch(/Slamem-setup-1\.2\.0\.exe$/);
    expect(pickAsset(assets, 'linux', 'x64')).toBeNull();
  });

  it('offers a newer release, ignores drafts, pre-releases and older ones', () => {
    const release = {
      tag_name: 'v1.2.0',
      body: 'Fixes search sometimes missing recent messages',
      html_url: 'https://github.com/o/r/releases/tag/v1.2.0',
      assets,
    };
    expect(
      describeRelease(release, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' }, 1).info,
    ).toMatchObject({
      available: true,
      latestVersion: '1.2.0',
      notes: 'Fixes search sometimes missing recent messages',
      downloadUrl: expect.stringMatching(/arm64\.dmg$/),
    });
    expect(
      describeRelease(release, { currentVersion: '1.2.0', platform: 'darwin', arch: 'arm64' }, 1).info.available,
    ).toBe(false);
    expect(
      describeRelease(
        { ...release, prerelease: true },
        { currentVersion: '1.0.0', platform: 'darwin', arch: 'arm64' },
        1,
      ).info.available,
    ).toBe(false);
  });

  it('installs by itself the zip for this Mac’s chip, or the Windows installer, with GitHub’s checksum', () => {
    const base = 'https://github.com/o/r/releases/download/v1.2.0';
    const digest = (c: string) => `sha256:${c.repeat(64)}`;
    const files = [
      { name: 'Slamem-1.2.0-arm64-mac.zip', browser_download_url: `${base}/a.zip`, size: 10, digest: digest('a') },
      { name: 'Slamem-1.2.0-x64-mac.zip', browser_download_url: `${base}/b.zip`, size: 11, digest: digest('b') },
      { name: 'Slamem-1.2.0-arm64-mac.zip.blockmap', browser_download_url: `${base}/c`, size: 1, digest: digest('c') },
      { name: 'Slamem-setup-1.2.0.exe', browser_download_url: `${base}/d.exe`, size: 12, digest: digest('D') },
      { name: 'Slamem-setup-1.2.0.exe.blockmap', browser_download_url: `${base}/e`, size: 1, digest: digest('e') },
    ];
    expect(pickPackage(files, 'darwin', 'arm64', '1.2.0')).toEqual({
      version: '1.2.0',
      name: 'Slamem-1.2.0-arm64-mac.zip',
      url: `${base}/a.zip`,
      size: 10,
      sha256: 'a'.repeat(64),
    });
    expect(pickPackage(files, 'darwin', 'x64', '1.2.0')?.name).toBe('Slamem-1.2.0-x64-mac.zip');
    expect(pickPackage(files, 'win32', 'x64', '1.2.0')).toMatchObject({
      name: 'Slamem-setup-1.2.0.exe',
      sha256: 'd'.repeat(64),
    });
    expect(pickPackage(files, 'linux', 'x64', '1.2.0')).toBeNull();
    // Never the other chip's build, never without the checksum, never from outside GitHub.
    expect(pickPackage(files.slice(1), 'darwin', 'arm64', '1.2.0')).toBeNull();
    expect(pickPackage([{ ...files[0], digest: null }], 'darwin', 'arm64', '1.2.0')).toBeNull();
    expect(pickPackage([{ ...files[0], size: undefined }], 'darwin', 'arm64', '1.2.0')).toBeNull();
    expect(
      pickPackage([{ ...files[0], browser_download_url: 'https://evil.example/a.zip' }], 'darwin', 'arm64', '1.2.0'),
    ).toBeNull();
    const release = { tag_name: 'v1.2.0', html_url: 'https://github.com/o/r/releases/tag/v1.2.0', assets: files };
    expect(describeRelease(release, { currentVersion: '1.1.0', platform: 'darwin', arch: 'arm64' }, 1).pkg?.url).toBe(
      `${base}/a.zip`,
    );
    expect(describeRelease(release, { currentVersion: '1.2.0', platform: 'darwin', arch: 'arm64' }, 1).pkg).toBeNull();
  });

  it('never opens links outside GitHub from release data', () => {
    const evil = [{ name: 'x.exe', browser_download_url: 'https://evil.example/x.exe' }];
    expect(pickAsset(evil, 'win32', 'x64')).toBeNull();
  });

  it('tells “nothing published (or not public)” apart from a failed check', async () => {
    const notFound = (async () => new Response('{}', { status: 404 })) as typeof fetch;
    expect(
      await checkForUpdate({
        repo: 'o/r',
        currentVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        fetch: notFound,
      }),
    ).toMatchObject({
      info: { available: false, error: null, noRelease: true },
      pkg: null,
    });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(
      await checkForUpdate({
        repo: 'o/r',
        currentVersion: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        fetch: offline,
      }),
    ).toMatchObject({ info: { available: false, noRelease: false, error: 'Couldn’t check for updates (offline?)' } });
  });
});

describe('redaction and logging (PLAN §3.5, pitfall 20)', () => {
  it('masks tokens, cookies, bearer headers and explicit secrets in every encoding', () => {
    const cookie = 'xoxd-AbC%2FdEf%2BgH%3D';
    const line = `Authorization: Bearer xoxc-123-456 Cookie: d=${cookie}; d-s=1 raw ${decodeURIComponent(cookie)} xapp-1-A0-abc`;
    const out = redactSecrets(line, [cookie]);
    expect(containsSlackSecret(out)).toBe(false);
    expect(out).not.toMatch(/AbC|dEf|gH|123-456|A0-abc/);
  });

  it('masks Anthropic API keys (Ask AI)', () => {
    const out = redactSecrets('401 for x-api-key sk-ant-api03-AbCdEf_123-xyz in request');
    expect(out).toBe('401 for x-api-key sk-ant-[redacted] in request');
  });

  it('never writes a secret to the log file and rotates at the size cap', () => {
    const log = createLogger({ dir: path.join(dir, 'logs'), maxBytes: 400 });
    for (let i = 0; i < 20; i++)
      log.error(`failed with token xoxc-9999-8888-${i} and d=xoxd-zz%2F${i}`, new Error('Cookie: d=xoxd-leak'));
    const files = fs.readdirSync(path.join(dir, 'logs'));
    expect(files.sort()).toEqual(['main.1.log', 'main.log']);
    const text = files.map((f) => fs.readFileSync(path.join(dir, 'logs', f), 'utf8')).join('\n');
    expect(text).not.toMatch(/xox[cd]-(?!\[redacted\])/);
    expect(fs.statSync(path.join(dir, 'logs', 'main.log')).size).toBeLessThan(2000);
  });
});

describe('preferences', () => {
  it('defaults, validates, persists and survives a corrupt file', () => {
    const file = path.join(dir, 'config.json');
    const prefs = new Preferences(file);
    expect(prefs.get()).toMatchObject({
      syncIntervalMinutes: 60,
      attachmentPolicy: 'standard',
      overlapDays: 7,
      launchAtLogin: true,
      onboardingComplete: false,
    });
    const changes: unknown[] = [];
    prefs.on('changed', (p) => changes.push(p));
    prefs.update({ syncIntervalMinutes: 15, attachmentPolicy: 'everything' });
    expect(changes).toHaveLength(1);
    prefs.update({ syncIntervalMinutes: 15 });
    expect(changes).toHaveLength(1); // no-op
    expect(() => prefs.update({ syncIntervalMinutes: 7 })).toThrow(/how often/);
    expect(() => prefs.update({ nonsense: true })).toThrow(/Unknown setting/);
    expect(prefs.get().aiModel).toBe('claude-opus-5');
    prefs.update({ aiModel: 'claude-haiku-4-5' });
    expect(() => prefs.update({ aiModel: 'gpt-5' })).toThrow(/model from the list/);
    expect(new Preferences(file).get()).toMatchObject({
      syncIntervalMinutes: 15,
      attachmentPolicy: 'everything',
      aiModel: 'claude-haiku-4-5',
    });
    fs.writeFileSync(file, '{broken');
    expect(new Preferences(file).get().syncIntervalMinutes).toBe(60);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('config.json.corrupt-'))).toBe(true);
  });
});

describe('archive:// file protocol (PLAN §3.6, pitfalls 19 and 23)', () => {
  const deps = () => ({ db, filesDir: path.join(dir, 'files') });

  it('serves downloaded images inline with a sandboxing CSP and nosniff', async () => {
    addFile('F1', 'photo.png', 'PNGDATA');
    const res = await serveArchiveFile(new Request('archive://file/F1'), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(await res.text()).toBe('PNGDATA');
  });

  it('never serves HTML or SVG attachments', async () => {
    addFile('F2', 'page.html', '<script>alert(1)</script>', { mimetype: 'text/html' });
    addFile('F3', 'icon.svg', '<svg onload="x()"/>', { mimetype: 'image/svg+xml' });
    expect((await serveArchiveFile(new Request('archive://file/F2'), deps())).status).toBe(404);
    expect((await serveArchiveFile(new Request('archive://file/F3'), deps())).status).toBe(404);
    expect((await serveArchiveFile(new Request('archive://thumb/F3'), deps())).status).toBe(404);
  });

  it('refuses ids and stored paths that point outside the files folder', async () => {
    addFile('F4', 'ok.png', 'x');
    db.prepare("UPDATE files SET local_path = '../archive.db' WHERE id = 'F4'").run();
    expect((await serveArchiveFile(new Request('archive://file/F4'), deps())).status).toBe(404);
    expect((await serveArchiveFile(new Request('archive://file/..%2Farchive.db'), deps())).status).toBe(404);
  });

  it('supports byte ranges for video seeking', async () => {
    addFile('F5', 'clip.mp4', '0123456789', { mimetype: 'video/mp4' });
    const res = await serveArchiveFile(new Request('archive://file/F5', { headers: { range: 'bytes=2-5' } }), deps());
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await res.text()).toBe('2345');
    expect(parseRange('bytes=-3', 10)).toEqual([7, 9]);
    expect(parseRange('bytes=20-', 10)).toBe('unsatisfiable');
  });

  it('compares paths case-insensitively on Windows and macOS (pitfall 23)', () => {
    expect(isInside('C:\\Data\\Files', 'c:\\data\\files\\F1\\a.png', 'win32')).toBe(true);
    expect(isInside('/data/files', '/data/files/../archive.db', 'linux')).toBe(false);
    expect(isInside('/data/files', '/data/files', 'linux')).toBe(false);
  });
});

describe('external links (PLAN §3.6)', () => {
  it('only lets http(s) and mailto leave the app', () => {
    expect(isSafeExternalUrl('https://slack.com/x')).toBe(true);
    expect(isSafeExternalUrl('mailto:a@b.c')).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'slack://open',
      'archive://file/F1',
      'data:text/html,x',
      'http://',
    ]) {
      expect(isSafeExternalUrl(bad), bad).toBe(false);
    }
  });
});
