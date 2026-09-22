import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_INDEX_URL, isAppPageUrl, serveAppFile } from './app-protocol';

let root: string;
let renderer: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-app-protocol-'));
  renderer = path.join(root, 'renderer');
  fs.mkdirSync(path.join(renderer, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(renderer, 'index.html'), '<!doctype html><title>Slamem</title>');
  fs.writeFileSync(path.join(renderer, 'assets', 'index-abc.js'), 'console.log(1)');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'not part of the app');
  fs.writeFileSync(path.join(root, 'archive.html'), '<script>steal()</script>');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const get = (url: string, method = 'GET') => serveAppFile(new Request(url, { method }), renderer);

describe('slamem://app (the window’s own pages, instead of file://)', () => {
  it('serves the built renderer with its types', async () => {
    const page = await get(APP_INDEX_URL);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await page.text()).toContain('<title>Slamem</title>');
    const script = await get('slamem://app/assets/index-abc.js');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await get('slamem://app/')).toMatchObject({ status: 200 });
    expect((await get('slamem://app/assets/index-abc.js', 'HEAD')).status).toBe(200);
  });

  it('serves nothing outside the renderer folder, however the path is spelled', async () => {
    for (const url of [
      'slamem://app/../archive.html',
      'slamem://app/%2e%2e/archive.html',
      'slamem://app/assets/..%2f..%2farchive.html',
      'slamem://app/..%5c..%5carchive.html',
      'slamem://app/%2E%2E/secret.txt',
      'slamem://app/missing.js',
      'slamem://app/index.html%00.js',
      'slamem://other/index.html',
    ]) {
      expect((await get(url)).status, url).toBe(404);
    }
  });

  it('serves only the kinds of file a web page is made of, and only to GET', async () => {
    fs.writeFileSync(path.join(renderer, 'notes.txt'), 'x');
    expect((await get('slamem://app/notes.txt')).status).toBe(404);
    expect((await get(APP_INDEX_URL, 'POST')).status).toBe(405);
  });

  it('knows the app’s own address from anything else', () => {
    expect(isAppPageUrl('slamem://app/index.html#/search?q=x')).toBe(true);
    expect(isAppPageUrl('file:///Applications/Slamem.app/Contents/Resources/app.asar/out/renderer/index.html')).toBe(
      false,
    );
    expect(isAppPageUrl('slamem://evil/index.html')).toBe(false);
    expect(isAppPageUrl('https://app/index.html')).toBe(false);
    expect(isAppPageUrl('not a url')).toBe(false);
  });
});
