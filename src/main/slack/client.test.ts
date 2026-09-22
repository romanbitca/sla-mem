import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SlackClient, methodIntervalMs, type SlackClientOptions } from './client';
import { DownloadError, SlackApiError, SlackHttpError } from './errors';
import { FAKE_BASE_URL, FAKE_TOKEN, FakeSlack, fakeClock } from './fake-slack';
import { redactSecrets, stripQuery } from './util';

let fake: FakeSlack;
let logs: string[];
let clock: ReturnType<typeof fakeClock>;
let tmp: string;

beforeEach(() => {
  fake = new FakeSlack();
  fake.users = [
    { id: 'U1', name: 'alice' },
    { id: 'U2', name: 'bob' },
    { id: 'U3', name: 'carol' },
  ];
  logs = [];
  clock = fakeClock();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-client-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  expect(logs.join('\n')).not.toContain(FAKE_TOKEN);
});

function client(opts: Partial<SlackClientOptions> = {}): SlackClient {
  return new SlackClient({
    token: FAKE_TOKEN,
    baseUrl: FAKE_BASE_URL,
    fetch: fake.fetch,
    log: (l) => logs.push(l),
    throttle: false,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
    ...opts,
  });
}

describe('SlackClient.call', () => {
  it('POSTs form-encoded params with a bearer token', async () => {
    const seen: { init?: RequestInit; url: string }[] = [];
    const spy: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), init });
      return fake.fetch(input, init);
    };
    await client({ fetch: spy }).call('users.list', { limit: 2, presence: false, cursor: undefined });
    const { url, init } = seen[0];
    expect(url).toBe(`${FAKE_BASE_URL}/users.list`);
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded');
    expect(init?.body).toBe('limit=2&presence=false');
  });

  it('calls only methods that read, refusing anything else without a request', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      seen.push(String(input));
      return fake.fetch(input, init);
    };
    for (const method of [
      'chat.postMessage',
      'chat.delete',
      'auth.revoke',
      'files.sharedPublicURL',
      'users.list/../x',
    ]) {
      await expect(client({ fetch: spy }).call(method, { channel: 'C1', text: 'hi' })).rejects.toThrow(
        /only reads from Slack/,
      );
    }
    expect(seen).toEqual([]);
  });

  it('throws SlackApiError with the Slack error code and missing scope', async () => {
    fake.emoji = null;
    const err = await client()
      .call('emoji.list')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).code).toBe('missing_scope');
    expect((err as SlackApiError).message).toContain('emoji:read');
  });

  it('waits out Retry-After on HTTP 429, then succeeds', async () => {
    fake.inject('users.list', { status: 429, retryAfter: 7 });
    const c = client();
    const res = await c.call<{ members: unknown[] }>('users.list', { limit: 10 });
    expect(res.members).toHaveLength(3);
    expect(clock.sleeps).toEqual([7000]);
    expect(c.apiCalls).toBe(2);
    expect(logs.some((l) => l.includes('rate limited') && l.includes('7.0s'))).toBe(true);
  });

  it('treats ok:false "ratelimited" like a 429', async () => {
    fake.inject('users.list', { error: 'ratelimited', retryAfter: 3 });
    await client().call('users.list');
    expect(clock.sleeps).toEqual([3000]);
  });

  it('makes other callers of the method wait out a 429 too', async () => {
    fake.inject('users.list', { status: 429, retryAfter: 5 });
    const sleeps: number[] = [];
    let second: Promise<unknown> | undefined;
    let started = false;
    // A second caller starts while the first is waiting out Retry-After (the clock stands still).
    const c = client({
      sleep: async (ms) => {
        sleeps.push(ms);
        if (started) return;
        started = true;
        second = c.call('users.list');
      },
    });
    await c.call('users.list');
    await second;
    expect(sleeps).toEqual([5000, 5000]);
    expect(fake.callsOf('users.list')).toHaveLength(3);
  });

  it('retries 5xx and network errors with backoff', async () => {
    fake.inject('users.list', { status: 500 });
    fake.inject('users.list', { network: 'ECONNRESET' });
    fake.inject('users.list', { error: 'internal_error' });
    const c = client();
    await c.call('users.list');
    // Equal jitter with random()=0.5: 1s → 750ms, 2s → 1500ms, 4s → 3000ms.
    expect(clock.sleeps).toEqual([750, 1500, 3000]);
    expect(c.apiCalls).toBe(4);
    expect(logs.join('\n')).toContain('ECONNRESET');
  });

  it('gives up after maxAttempts with SlackHttpError', async () => {
    fake.inject('users.list', { status: 503 }, 10);
    const err = await client({ maxAttempts: 3 })
      .call('users.list')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackHttpError);
    expect((err as SlackHttpError).status).toBe(503);
    expect(fake.callsOf('users.list')).toHaveLength(3);
  });

  it('gives up after too many 429s', async () => {
    fake.inject('users.list', { status: 429, retryAfter: 1 }, 10);
    const err = await client({ maxRateLimitRetries: 2 })
      .call('users.list')
      .catch((e: unknown) => e);
    expect((err as SlackApiError).code).toBe('ratelimited');
  });

  it('aborts a pending Retry-After wait promptly', async () => {
    fake.inject('users.list', { status: 429, retryAfter: 600 });
    const controller = new AbortController();
    // Real timers: the only thing that can end this wait early is the signal.
    const c = client({ signal: controller.signal, sleep: undefined });
    const pending = c.call('users.list');
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('passes the abort signal into fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(client({ signal: controller.signal }).call('auth.test')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('pacing', () => {
  it('spaces calls of one method by its rate-limit tier', async () => {
    fake.conversations = [{ id: 'C1', name: 'general', is_channel: true }];
    const c = client({ throttle: true });
    await c.call('conversations.history', { channel: 'C1' });
    await c.call('conversations.history', { channel: 'C1' });
    await c.call('users.list');
    await c.call('users.list');
    await c.call('auth.test');
    await c.call('auth.test');
    expect(clock.sleeps).toEqual([methodIntervalMs('conversations.history'), methodIntervalMs('users.list')]);
    expect(methodIntervalMs('conversations.history')).toBe(1200);
    expect(methodIntervalMs('users.list')).toBe(3000);
    expect(methodIntervalMs('users.info')).toBe(600);
  });
});

describe('pagination', () => {
  it('follows next_cursor until it is empty', async () => {
    fake.pageSize = 2;
    const pages: string[][] = [];
    for await (const members of client().paginate<{ id: string }>('users.list', { limit: 200 }, 'members')) {
      pages.push(members.map((m) => m.id));
    }
    expect(pages).toEqual([['U1', 'U2'], ['U3']]);
    const cursors = fake.callsOf('users.list').map((c) => c.params.cursor);
    expect(cursors[0]).toBeUndefined();
    expect(cursors[1]).toBeTruthy();
  });

  it('stops if Slack repeats a cursor', async () => {
    const looping: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true, members: [{ id: 'U1' }], response_metadata: { next_cursor: 'same' } }));
    let pages = 0;
    for await (const _ of client({ fetch: looping }).paginate('users.list', {}, 'members')) pages++;
    expect(pages).toBe(2);
    expect(logs.some((l) => l.includes('cursor twice'))).toBe(true);
  });
});

describe('downloadFile', () => {
  const FILE_URL = 'https://files.slack.com/files-pri/T0001-F1/report.pdf';

  it('sends the token to Slack hosts and writes the file atomically', async () => {
    fake.files.set(FILE_URL, { body: '%PDF-1.4 data', contentType: 'application/pdf' });
    const dest = path.join(tmp, 'F1', 'report.pdf');
    const res = await client().downloadFile(`${FILE_URL}?t=xoxe-secret`, dest);
    expect(res.bytes).toBe(13);
    expect(fs.readFileSync(dest, 'utf8')).toBe('%PDF-1.4 data');
    expect(fs.readdirSync(path.dirname(dest))).toEqual(['report.pdf']);
    expect(fake.downloads[0].authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('refuses non-Slack hosts without making a request', async () => {
    const err = await client()
      .downloadFile('https://evil.example.com/x.pdf', path.join(tmp, 'x'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect((err as DownloadError).kind).toBe('untrusted_url');
    expect(fake.downloads).toHaveLength(0);
  });

  it('refuses plain http even on Slack hosts', async () => {
    const err = await client()
      .downloadFile('http://files.slack.com/a.png', path.join(tmp, 'a'))
      .catch((e: unknown) => e);
    expect((err as DownloadError).kind).toBe('untrusted_url');
  });

  it('follows redirects but never forwards the token off slack.com', async () => {
    fake.files.set(
      FILE_URL,
      () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/blob?sig=1' } }),
    );
    fake.files.set('https://cdn.example.net/blob', { body: 'bytes', contentType: 'application/pdf' });
    const dest = path.join(tmp, 'F1', 'report.pdf');
    await client().downloadFile(FILE_URL, dest);
    expect(fake.downloads.map((d) => [d.url, d.authorization])).toEqual([
      [FILE_URL, `Bearer ${FAKE_TOKEN}`],
      ['https://cdn.example.net/blob?sig=1', null],
    ]);
    expect(fs.readFileSync(dest, 'utf8')).toBe('bytes');
  });

  it('sends the session only to Slack’s file addresses, never to the Web API or other Slack pages', async () => {
    for (const url of [
      'https://slack.com/api/chat.postMessage?channel=C1&text=hi',
      'https://acme.slack.com/api/auth.revoke',
      'https://files.slack.com/api/chat.delete',
      'https://acme.slack.com/signout',
      'https://files.slack.com/files-pri/T0001-F1/..%2F..%2Fapi%2Fauth.revoke',
      'https://files.slack.com/files-pri/T0001-F1/%2E%2E/%2e%2e/api/auth.revoke',
    ]) {
      const err = await client()
        .downloadFile(url, path.join(tmp, 'x'))
        .catch((e: unknown) => e);
      expect((err as DownloadError).kind, url).toBe('untrusted_url');
    }
    expect(fake.downloads).toHaveLength(0);
  });

  it('follows a redirect to a Slack page that isn’t a file without the session', async () => {
    fake.files.set(
      FILE_URL,
      () => new Response(null, { status: 302, headers: { location: 'https://slack.com/api/auth.revoke' } }),
    );
    fake.files.set('https://slack.com/api/auth.revoke', { body: '{"ok":false}', contentType: 'application/json' });
    await client().downloadFile(FILE_URL, path.join(tmp, 'F1', 'report.pdf'));
    expect(fake.downloads.map((d) => [d.url, d.authorization])).toEqual([
      [FILE_URL, `Bearer ${FAKE_TOKEN}`],
      ['https://slack.com/api/auth.revoke', null],
    ]);
  });

  it('turns an expired session’s redirect to the sign-in page into the HTML failure', async () => {
    const signIn = 'https://acme.slack.com/?redir=%2Ffiles-pri%2FT0001-F1%2Freport.pdf';
    fake.files.set(FILE_URL, () => new Response(null, { status: 302, headers: { location: signIn } }));
    fake.files.set('https://acme.slack.com/', { body: '<html>Sign in</html>', contentType: 'text/html' });
    const err = await client()
      .downloadFile(FILE_URL, path.join(tmp, 'F1', 'report.pdf'))
      .catch((e: unknown) => e);
    expect((err as DownloadError).kind).toBe('html');
    expect(fake.downloads.map((d) => d.authorization)).toEqual([`Bearer ${FAKE_TOKEN}`, null]);
  });

  it('rejects an HTML login page unless HTML is expected', async () => {
    fake.files.set(FILE_URL, { body: '<html>Sign in to Slack</html>', contentType: 'text/html; charset=utf-8' });
    const dest = path.join(tmp, 'F1', 'report.pdf');
    const err = await client()
      .downloadFile(FILE_URL, dest)
      .catch((e: unknown) => e);
    expect((err as DownloadError).kind).toBe('html');
    expect(fs.existsSync(dest)).toBe(false);
    await client().downloadFile(FILE_URL, dest, { allowHtml: true });
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('enforces maxBytes from Content-Length and from the streamed body', async () => {
    fake.files.set(FILE_URL, { body: 'x'.repeat(100), contentType: 'application/pdf' });
    const dest = path.join(tmp, 'F1', 'report.pdf');
    const declared = await client()
      .downloadFile(FILE_URL, dest, { maxBytes: 10 })
      .catch((e: unknown) => e);
    expect((declared as DownloadError).kind).toBe('too_large');

    fake.files.set(FILE_URL, { body: 'x'.repeat(100), contentType: 'application/pdf', noLength: true });
    const streamed = await client()
      .downloadFile(FILE_URL, dest, { maxBytes: 60 })
      .catch((e: unknown) => e);
    expect((streamed as DownloadError).kind).toBe('too_large');
    expect(fs.readdirSync(path.join(tmp, 'F1'))).toEqual([]); // temp file cleaned up
  });

  it('retries 5xx downloads and logs URLs without their query string', async () => {
    let calls = 0;
    fake.files.set(FILE_URL, () =>
      ++calls === 1
        ? new Response('busy', { status: 503 })
        : new Response('ok', { headers: { 'content-type': 'application/pdf' } }),
    );
    await client().downloadFile(`${FILE_URL}?t=xoxe-1-abcdef`, path.join(tmp, 'F1', 'r.pdf'));
    expect(calls).toBe(2);
    expect(clock.sleeps).toEqual([750]);
    expect(logs.join('\n')).toContain('files-pri/T0001-F1/report.pdf');
    expect(logs.join('\n')).not.toContain('xoxe');
  });

  it('does not retry 4xx', async () => {
    fake.files.set(FILE_URL, { body: 'no', status: 403, contentType: 'text/plain' });
    const err = await client()
      .downloadFile(FILE_URL, path.join(tmp, 'x'))
      .catch((e: unknown) => e);
    expect((err as DownloadError).status).toBe(403);
    expect(fake.downloads).toHaveLength(1);
  });

  it('stops at once when cancelled as the answer arrives, before the file exists', async () => {
    const controller = new AbortController();
    fake.files.set(FILE_URL, () => {
      controller.abort(); // e.g. Cancel sync, between the answer and the reading of its body
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('never ends'));
        },
      });
      return new Response(body, { headers: { 'content-type': 'application/pdf' } });
    });
    const dest = path.join(tmp, 'F1', 'report.pdf');
    await expect(client({ signal: controller.signal }).downloadFile(FILE_URL, dest)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fs.readdirSync(path.join(tmp, 'F1'))).toEqual([]);
  });

  it('leaves no partial file when aborted mid-transfer', async () => {
    const controller = new AbortController();
    fake.files.set(FILE_URL, () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('first chunk'));
          setTimeout(() => controller.abort(), 10); // never closes: only the abort ends it
        },
      });
      return new Response(body, { headers: { 'content-type': 'application/pdf' } });
    });
    const dest = path.join(tmp, 'F1', 'report.pdf');
    await expect(client({ signal: controller.signal }).downloadFile(FILE_URL, dest)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fs.readdirSync(path.join(tmp, 'F1'))).toEqual([]);
  });
});

describe('log hygiene helpers', () => {
  it('redacts Slack tokens and explicit secrets', () => {
    expect(redactSecrets(`token xoxp-123-abc and xoxe.xoxp-1-Zz9`)).not.toMatch(/xox[a-z]-[A-Za-z0-9]/);
    expect(redactSecrets('value=hunter2', ['hunter2'])).toBe('value=[redacted]');
  });

  it('strips query strings and fragments from URLs', () => {
    expect(stripQuery('https://files.slack.com/a/b.png?t=xoxe-1#x')).toBe('https://files.slack.com/a/b.png');
  });
});
