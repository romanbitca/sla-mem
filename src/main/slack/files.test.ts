import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFileRow, openDb, upsertMessages, type DB } from '../db';
import { SlackClient } from './client';
import { FAKE_BASE_URL, FAKE_TOKEN, FakeSlack, fakeClock } from './fake-slack';
import type { AttachmentPolicy } from '../../shared/types';
import { downloadPendingFiles, fileTarget, sanitizeFileName } from './files';
import type { SlackFile } from './types';

const HOST = 'https://files.slack.com';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

let db: DB;
let fake: FakeSlack;
let filesDir: string;
let logs: string[];
let seq = 0;

beforeEach(() => {
  db = openDb(':memory:');
  fake = new FakeSlack();
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-files-'));
  logs = [];
});

afterEach(() => {
  db.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
  expect(logs.join('\n')).not.toContain(FAKE_TOKEN);
});

function client(signal?: AbortSignal): SlackClient {
  const clock = fakeClock();
  return new SlackClient({
    token: FAKE_TOKEN,
    baseUrl: FAKE_BASE_URL,
    fetch: fake.fetch,
    log: (l) => logs.push(l),
    throttle: false,
    sleep: clock.sleep,
    now: clock.now,
    signal,
  });
}

/** Stores a message carrying `file` (the way sync does), queueing the file for download. */
function queueFile(file: Partial<SlackFile> & { id: string }): void {
  seq++;
  upsertMessages(
    db,
    'C1',
    [
      {
        type: 'message',
        ts: `1700000000.${String(seq).padStart(6, '0')}`,
        user: 'U1',
        text: '',
        files: [file as SlackFile],
      },
    ],
    'api',
    {
      filesDir,
    },
  );
}

function slackFile(id: string, name: string, extra: Partial<SlackFile> = {}): SlackFile {
  return {
    id,
    name,
    title: name,
    mimetype: 'application/pdf',
    filetype: 'pdf',
    mode: 'hosted',
    url_private: `${HOST}/files-pri/T0001-${id}/${encodeURIComponent(name)}`,
    url_private_download: `${HOST}/files-pri/T0001-${id}/download/${encodeURIComponent(name)}`,
    ...extra,
  };
}

function serve(
  file: SlackFile,
  body: string | Uint8Array<ArrayBuffer>,
  contentType = file.mimetype ?? 'application/octet-stream',
): void {
  fake.files.set(file.url_private_download!, { body, contentType });
}

let nowMs = 1_700_000_100_000;

async function run(opts: { policy?: AttachmentPolicy; signal?: AbortSignal } = {}) {
  return downloadPendingFiles({
    db,
    client: client(opts.signal),
    filesDir,
    log: (l) => logs.push(l),
    policy: opts.policy ?? 'everything',
    signal: opts.signal,
    now: () => nowMs,
  });
}

/** Every file under filesDir, relative, excluding nothing (temp files would show up here). */
function listTree(dir = filesDir): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(filesDir, path.join(e.parentPath, e.name)))
    .sort();
}

describe('downloadPendingFiles', () => {
  it('downloads a file and its thumbnail into files/<id>/', async () => {
    const f = slackFile('F1', 'Q3 report.pdf', { thumb_pdf: `${HOST}/files-tmb/T0001-F1/q3_thumb_pdf.png` });
    queueFile(f);
    serve(f, '%PDF-1.7 hello');
    fake.files.set(f.thumb_pdf!, { body: PNG, contentType: 'image/png' });

    const stats = await run();
    expect(stats).toEqual({ filesDownloaded: 1, filesFailed: 0, filesSkipped: 0, filesUnavailable: 0 });
    const row = getFileRow(db, 'F1')!;
    expect(row.download_status).toBe('done');
    expect(row.local_path).toBe(path.join('F1', 'Q3 report.pdf'));
    expect(row.thumb_local_path).toBe(path.join('F1', 'thumb.png'));
    expect(fs.readFileSync(path.join(filesDir, row.local_path!), 'utf8')).toBe('%PDF-1.7 hello');
    expect(listTree()).toEqual([path.join('F1', 'Q3 report.pdf'), path.join('F1', 'thumb.png')]); // no temp files left
    expect(fake.downloads.every((d) => d.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
  });

  it('skips files over the policy size limit without requesting them', async () => {
    queueFile(slackFile('F2', 'huge.zip', { size: 30 * 1024 * 1024, mimetype: 'application/zip' }));
    const stats = await run({ policy: 'standard' });
    expect(stats.filesSkipped).toBe(1);
    expect(getFileRow(db, 'F2')).toMatchObject({
      download_status: 'skipped',
      skip_reason: 'too_large',
      download_error: 'Larger than 25 MB',
    });
    expect(fake.downloads).toHaveLength(0);
  });

  it('skips files whose body turns out larger than the limit', async () => {
    const f = slackFile('F3', 'unknown-size.bin');
    queueFile(f);
    serve(f, 'x'.repeat(25 * 1024 * 1024 + 10));
    const stats = await run({ policy: 'standard' });
    expect(stats.filesSkipped).toBe(1);
    expect(getFileRow(db, 'F3')!.download_error).toMatch(/limit/);
    expect(listTree()).toEqual([]);
  });

  it('never downloads Free-plan hidden_by_limit stubs (stored as unavailable)', async () => {
    queueFile({ id: 'F4', mode: 'hidden_by_limit' });
    const stats = await run();
    expect(stats.filesDownloaded + stats.filesFailed).toBe(0);
    expect(getFileRow(db, 'F4')!.download_status).toBe('unavailable');
    expect(fake.downloads).toHaveLength(0);
  });

  it('marks a queued file unavailable when its stored mode is hidden_by_limit/external', async () => {
    queueFile(slackFile('F5', 'a.pdf'));
    // Simulate a row that got queued and whose raw object is an external file.
    db.prepare("UPDATE files SET raw = json_set(raw, '$.is_external', json('true')) WHERE id = 'F5'").run();
    const stats = await run();
    expect(stats.filesUnavailable).toBe(1);
    expect(getFileRow(db, 'F5')!.download_status).toBe('unavailable');
    expect(fake.downloads).toHaveLength(0);
  });

  it('fails a file when Slack answers with an HTML login page', async () => {
    const f = slackFile('F6', 'notes.pdf');
    queueFile(f);
    serve(f, '<!DOCTYPE html><html><title>Slack</title>', 'text/html; charset=utf-8');
    const stats = await run();
    expect(stats.filesFailed).toBe(1);
    const row = getFileRow(db, 'F6')!;
    expect(row.download_status).toBe('failed');
    expect(row.download_error).toMatch(/HTML/);
    expect(row.download_attempts).toBe(1);
    expect(listTree()).toEqual([]);
  });

  it('accepts HTML bodies for files that really are HTML', async () => {
    const f = slackFile('F7', 'page.html', { mimetype: 'text/html', filetype: 'html' });
    queueFile(f);
    serve(f, '<html>saved page</html>', 'text/html');
    expect((await run()).filesDownloaded).toBe(1);
  });

  it('retries failed files on later runs, with backoff, and never gives up for good (pitfall 7)', async () => {
    const f = slackFile('F8', 'flaky.pdf');
    queueFile(f);
    fake.files.set(f.url_private_download!, { body: 'denied', status: 403, contentType: 'text/plain' });
    await run();
    const failed = getFileRow(db, 'F8')!;
    expect(failed).toMatchObject({ download_status: 'failed', download_attempts: 1 });
    await run(); // still backing off: not requested again
    expect(fake.downloads).toHaveLength(1);
    nowMs = failed.next_attempt_at!;
    serve(f, '%PDF ok');
    expect((await run()).filesDownloaded).toBe(1);
    expect(fake.downloads).toHaveLength(2);
  });

  it('marks files Slack no longer has (404) as unavailable', async () => {
    queueFile(slackFile('F9', 'gone.pdf'));
    const stats = await run();
    expect(stats.filesUnavailable).toBe(1);
    expect(getFileRow(db, 'F9')!.download_status).toBe('unavailable');
  });

  it('keeps hostile file names inside files/<id>/', async () => {
    const f = slackFile('F10', '../../../../etc/evil.sh');
    queueFile(f);
    serve(f, 'echo pwned', 'text/x-sh');
    await run();
    const row = getFileRow(db, 'F10')!;
    expect(row.download_status).toBe('done');
    expect(row.local_path!.startsWith(`F10${path.sep}`)).toBe(true);
    expect(row.local_path!.split(path.sep)).toHaveLength(2);
    expect(listTree()).toEqual([row.local_path]);
  });

  it('refuses to download from non-Slack hosts', async () => {
    queueFile(
      slackFile('F11', 'x.pdf', { url_private: 'https://attacker.example/x.pdf', url_private_download: undefined }),
    );
    const stats = await run();
    expect(stats.filesFailed).toBe(1);
    expect(getFileRow(db, 'F11')!.download_error).toMatch(/refusing/);
    expect(fake.downloads).toHaveLength(0);
  });

  it('keeps the file when only its thumbnail fails', async () => {
    const f = slackFile('F12', 'photo.jpg', {
      mimetype: 'image/jpeg',
      filetype: 'jpg',
      thumb_720: `${HOST}/files-tmb/T0001-F12/photo_720.jpg`,
    });
    queueFile(f);
    serve(f, PNG, 'image/jpeg');
    const stats = await run();
    expect(stats.filesDownloaded).toBe(1);
    const row = getFileRow(db, 'F12')!;
    expect(row.download_status).toBe('done');
    expect(row.thumb_local_path).toBeNull();
    expect(logs.some((l) => l.includes('thumbnail not saved'))).toBe(true);
  });

  it('does not let a thumbnail overwrite a file named like it', async () => {
    const f = slackFile('F13', 'thumb.png', {
      mimetype: 'image/png',
      filetype: 'png',
      thumb_360: `${HOST}/files-tmb/T0001-F13/t_360.png`,
    });
    queueFile(f);
    serve(f, 'ORIGINAL', 'image/png');
    fake.files.set(f.thumb_360!, { body: 'THUMB', contentType: 'image/png' });
    await run();
    const row = getFileRow(db, 'F13')!;
    expect(fs.readFileSync(path.join(filesDir, row.local_path!), 'utf8')).toBe('ORIGINAL');
    expect(fs.readFileSync(path.join(filesDir, row.thumb_local_path!), 'utf8')).toBe('THUMB');
  });

  it('stops on abort, keeping finished files and leaving no partial ones', async () => {
    const controller = new AbortController();
    for (const id of ['F20', 'F21', 'F22', 'F23']) {
      const f = slackFile(id, `${id}.pdf`);
      queueFile(f);
      serve(f, `content of ${id}`);
    }
    fake.files.set(slackFile('F22', 'F22.pdf').url_private_download!, () => {
      controller.abort();
      return new Response('late', { headers: { 'content-type': 'application/pdf' } });
    });
    await expect(
      downloadPendingFiles({
        db,
        client: client(controller.signal),
        filesDir,
        policy: 'everything',
        signal: controller.signal,
        concurrency: 1,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getFileRow(db, 'F20')!.download_status).toBe('done');
    expect(getFileRow(db, 'F21')!.download_status).toBe('done');
    expect(getFileRow(db, 'F22')!.download_status).toBe('pending');
    expect(getFileRow(db, 'F23')!.download_status).toBe('pending');
    expect(listTree()).toEqual([path.join('F20', 'F20.pdf'), path.join('F21', 'F21.pdf')]);
  });
});

describe('attachment policy', () => {
  it('none: downloads nothing and says why', async () => {
    const f = slackFile('P1', 'a.pdf');
    queueFile(f);
    serve(f, '%PDF');
    expect((await run({ policy: 'none' })).filesSkipped).toBe(1);
    expect(getFileRow(db, 'P1')).toMatchObject({
      download_status: 'skipped',
      skip_reason: 'policy',
      download_error: 'Attachment downloads are turned off',
    });
    expect(fake.downloads).toHaveLength(0);
  });

  it('standard: skips video but keeps its preview; raising the limit downloads it later', async () => {
    const video = slackFile('P2', 'demo.mp4', {
      mimetype: 'video/mp4',
      filetype: 'mp4',
      size: 'VIDEO BYTES'.length,
      thumb_video: `${HOST}/files-tmb/T0001-P2/demo_thumb_video.jpeg`,
    });
    const doc = slackFile('P3', 'spec.pdf');
    queueFile(video);
    queueFile(doc);
    serve(video, 'VIDEO BYTES');
    serve(doc, '%PDF');
    fake.files.set(video.thumb_video!, { body: PNG, contentType: 'image/jpeg' });
    const first = await run({ policy: 'standard' });
    expect(first).toMatchObject({ filesDownloaded: 1, filesSkipped: 1 });
    expect(getFileRow(db, 'P2')).toMatchObject({ download_status: 'skipped', skip_reason: 'policy', local_path: null });
    expect(getFileRow(db, 'P2')!.thumb_local_path).toBe(path.join('P2', 'thumb.jpg'));
    // Re-checking an unchanged skip isn't counted again.
    expect((await run({ policy: 'standard' })).filesSkipped).toBe(0);
    expect((await run({ policy: 'everything' })).filesDownloaded).toBe(1);
    expect(getFileRow(db, 'P2')).toMatchObject({ download_status: 'done', skip_reason: null });
  });
});

describe('download integrity (pitfall 5)', () => {
  it('never records an empty body as downloaded', async () => {
    const f = slackFile('I1', 'empty.pdf', { size: 1234 });
    queueFile(f);
    serve(f, '');
    expect((await run()).filesFailed).toBe(1);
    expect(getFileRow(db, 'I1')).toMatchObject({ download_status: 'failed', local_path: null });
    expect(listTree()).toEqual([]);
  });

  it('never records a body shorter than the size Slack reported', async () => {
    const f = slackFile('I2', 'cut.pdf', { size: 5000 });
    queueFile(f);
    fake.files.set(f.url_private_download!, { body: 'x'.repeat(100), contentType: 'application/pdf', noLength: true });
    expect((await run()).filesFailed).toBe(1);
    expect(getFileRow(db, 'I2')!.download_status).toBe('failed');
  });

  it('marks an old file that Slack refuses as no longer available instead of retrying forever', async () => {
    const created = Math.floor(nowMs / 1000) - 120 * 86_400;
    const f = slackFile('I3', 'old.pdf', { created });
    queueFile(f);
    fake.files.set(f.url_private_download!, { body: 'forbidden', status: 403, contentType: 'text/plain' });
    expect((await run()).filesUnavailable).toBe(1);
    expect(getFileRow(db, 'I3')).toMatchObject({
      download_status: 'unavailable',
      download_error: 'No longer available from Slack',
    });
  });
});

describe('sanitizeFileName', () => {
  it('avoids Windows reserved device names (pitfall 21)', () => {
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('aux.txt')).toBe('_aux.txt');
    expect(sanitizeFileName('nul.tar.gz')).toBe('_nul.tar.gz');
    expect(sanitizeFileName('COM1.log')).toBe('_COM1.log');
    expect(sanitizeFileName('lpt9')).toBe('_lpt9');
    expect(sanitizeFileName('console.log')).toBe('console.log');
    expect(sanitizeFileName('report. ')).toBe('report');
    expect(sanitizeFileName('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
  });

  it.each([
    ['../../etc/passwd', '_._etc_passwd'],
    ['..', 'fallback.bin'],
    ['.', 'fallback.bin'],
    ['', 'fallback.bin'],
    ['a/b\\c.txt', 'a_b_c.txt'],
    ['.bashrc', 'bashrc'],
    ['...hidden..txt', 'hidden.txt'],
    ['name\u0000with\nctrl\t.pdf', 'namewithctrl.pdf'],
    ['what?: "x" <y> |z*.png', 'what__ _x_ _y_ _z_.png'],
    ['trailing dots...', 'trailing dots'],
    ['  spaced.txt  ', 'spaced.txt'],
    ['résumé.pdf', 'résumé.pdf'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFileName(input, 'fallback.bin')).toBe(expected);
  });

  it('uses the fallback for null names and sanitizes the fallback too', () => {
    expect(sanitizeFileName(null, 'F123.pdf')).toBe('F123.pdf');
    expect(sanitizeFileName(undefined, '../x')).toBe('_x');
    expect(sanitizeFileName('', '')).toBe('file');
  });

  it('caps length at 150 characters, keeping the extension', () => {
    const name = sanitizeFileName(`${'a'.repeat(400)}.pdf`);
    expect(name).toHaveLength(150);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('caps multi-byte names at 200 UTF-8 bytes without splitting characters', () => {
    const name = sanitizeFileName(`${'😀'.repeat(120)}.png`);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.endsWith('.png')).toBe(true);
    expect(name).not.toContain('�');
    expect(Array.from(name.slice(0, -4)).every((c) => c === '😀')).toBe(true);
  });

  it('never yields a path separator, a leading dot or ".."', () => {
    const hostile = ['../../a', '..\\..\\b', '/abs/path', '....//....//c', 'a/../../d', '.', '..', '.../...'];
    for (const h of hostile) {
      const s = sanitizeFileName(h, 'x');
      expect(s).not.toMatch(/[/\\]/);
      expect(s).not.toContain('..');
      expect(s.startsWith('.')).toBe(false);
    }
  });
});

describe('fileTarget', () => {
  it('builds <filesDir>/<id>/<name>', () => {
    const t = fileTarget('/data/files', { id: 'F1', name: 'a.pdf', title: null, filetype: 'pdf' });
    expect(t.absPath).toBe(path.resolve('/data/files', 'F1', 'a.pdf'));
    expect(t.relPath).toBe(path.join('F1', 'a.pdf'));
  });

  it('falls back to title, then id + filetype', () => {
    expect(fileTarget('/d', { id: 'F1', name: null, title: 'Title', filetype: 'pdf' }).relPath).toBe(
      path.join('F1', 'Title'),
    );
    expect(fileTarget('/d', { id: 'F1', name: null, title: null, filetype: 'pdf' }).relPath).toBe(
      path.join('F1', 'F1.pdf'),
    );
  });

  it('rejects ids that are not a single safe path segment', () => {
    for (const id of ['../F1', 'F1/..', '..', '', 'F 1', 'F1\u0000']) {
      expect(() => fileTarget('/d', { id, name: 'a', title: null, filetype: null })).toThrow(/unsafe/);
    }
  });
});
