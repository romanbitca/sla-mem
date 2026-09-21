/**
 * Browser-session credentials (xoxc token + `d` cookie): the cookie travels with API calls and file
 * downloads to Slack hosts only, never across a redirect to another host, and never into logs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../db';
import { SlackClient, redactSlackSecrets, slackCookieHeader, type SlackClientOptions } from './client';
import { SlackApiError } from './errors';
import { FAKE_BASE_URL, FakeSlack, fakeClock } from './fake-slack';
import { runApiSync } from './sync';
import { redactSecrets } from './util';

const XOXC = 'xoxc-1111-2222-3333-session-token-do-not-log';
/** DevTools shows the `d` cookie URL-encoded. */
const COOKIE = 'xoxd-AbCd%2FeFgH%2BiJkL%3D%3D';
const RAW_COOKIE = decodeURIComponent(COOKIE);

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  cookie: string | null;
}

let tmp: string;
let logs: string[];
let seen: Seen[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-session-'));
  logs = [];
  seen = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  const all = logs.join('\n');
  for (const secret of [XOXC, COOKIE, RAW_COOKIE, 'AbCd']) expect(all).not.toContain(secret);
});

/** Records every request's credentials, then answers with `route(url)`. */
function recordingFetch(route: (url: URL, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({
      url: url.href,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      cookie: headers.get('cookie'),
    });
    return route(url, init);
  }) as typeof fetch;
}

const okJson = (body: object) =>
  new Response(JSON.stringify({ ok: true, ...body }), { headers: { 'content-type': 'application/json' } });
const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } });

function client(fetchImpl: typeof fetch, opts: Partial<SlackClientOptions> = {}): SlackClient {
  const clock = fakeClock();
  return new SlackClient({
    token: XOXC,
    cookie: COOKIE,
    baseUrl: 'https://slack.com/api',
    fetch: fetchImpl,
    log: (l) => logs.push(l),
    throttle: false,
    sleep: clock.sleep,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    ...opts,
  });
}

describe('slackCookieHeader', () => {
  it('sends an already URL-encoded value as is, plus d-s', () => {
    expect(slackCookieHeader(COOKIE, 1_700_000_000_000)).toBe(`d=${COOKIE}; d-s=1699999990`);
  });

  it('URL-encodes a raw (decoded) value like slackdump does', () => {
    expect(slackCookieHeader(RAW_COOKIE, 1_700_000_000_000)).toBe(`d=${COOKIE}; d-s=1699999990`);
  });
});

describe('SlackClient with a session cookie', () => {
  it('sends Authorization and Cookie on Web API calls', async () => {
    await client(recordingFetch(() => okJson({ members: [] }))).call('users.list');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: 'https://slack.com/api/users.list',
      method: 'POST',
      authorization: `Bearer ${XOXC}`,
    });
    expect(seen[0].cookie).toBe(`d=${COOKIE}; d-s=1699999990`);
  });

  it('keeps credentials on redirects within Slack and drops them for any other host', async () => {
    const fetchImpl = recordingFetch((url) => {
      if (url.hostname === 'slack.com') return redirectTo('https://edgeapi.slack.com/api/users.list', 307);
      if (url.hostname === 'edgeapi.slack.com') return redirectTo('https://evil.example.com/collect');
      return okJson({ members: [] });
    });
    await client(fetchImpl).call('users.list');
    expect(seen.map((s) => s.url)).toEqual([
      'https://slack.com/api/users.list',
      'https://edgeapi.slack.com/api/users.list',
      'https://evil.example.com/collect',
    ]);
    expect(seen[1]).toMatchObject({ authorization: `Bearer ${XOXC}`, method: 'POST' });
    expect(seen[1].cookie).toContain(COOKIE);
    expect(seen[2]).toMatchObject({ authorization: null, cookie: null, method: 'GET' });
  });

  it('sends the cookie with file downloads from files.slack.com, but not to a CDN it redirects to', async () => {
    const fileUrl = 'https://files.slack.com/files-pri/T1-F1/report.pdf';
    const fetchImpl = recordingFetch((url) => {
      if (url.hostname === 'files.slack.com') return redirectTo('https://cdn.example.net/signed/report.pdf');
      return new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf', 'content-length': '8' } });
    });
    const dest = path.join(tmp, 'F1', 'report.pdf');
    await client(fetchImpl).downloadFile(fileUrl, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('%PDF-1.4');
    expect(seen[0]).toMatchObject({ url: fileUrl, authorization: `Bearer ${XOXC}` });
    expect(seen[0].cookie).toContain(`d=${COOKIE}`);
    expect(seen[1]).toMatchObject({
      url: 'https://cdn.example.net/signed/report.pdf',
      authorization: null,
      cookie: null,
    });
  });

  it('never sends the cookie to a non-Slack starting host', async () => {
    const fetchImpl = recordingFetch(() => new Response('x'));
    await expect(
      client(fetchImpl).downloadFile('https://evil.example.com/a.png', path.join(tmp, 'a.png')),
    ).rejects.toThrow();
    expect(seen.every((s) => s.cookie === null && s.authorization === null)).toBe(true);
  });

  it('redacts the token and every form of the cookie from its log lines', async () => {
    const fetchImpl = recordingFetch(() => {
      throw new TypeError(`fetch failed: Cookie d=${COOKIE} token=${XOXC} raw=${RAW_COOKIE}`);
    });
    const c = client(fetchImpl, { maxAttempts: 2 });
    await expect(c.call('users.list')).rejects.toThrow();
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('redaction helpers', () => {
  it('redactSlackSecrets masks explicit secrets in raw, encoded and decoded form', () => {
    const line = `a ${COOKIE} b ${RAW_COOKIE} c ${encodeURIComponent(RAW_COOKIE)} d ${XOXC}`;
    const out = redactSlackSecrets(line, [XOXC, COOKIE]);
    for (const s of [XOXC, COOKIE, RAW_COOKIE, 'AbCd', 'eFgH']) expect(out).not.toContain(s);
  });

  it('util.redactSecrets masks whole xoxc/xoxd/xoxp values, including URL-encoded and base64 parts', () => {
    const out = redactSecrets(`t=xoxc-1-2-abc c=xoxd-AbC%2FdEf%2BgH%3D r=xoxd-AbC/dEf+gH== p=xoxp-9-8-zz`);
    expect(out).not.toMatch(/AbC|dEf|gH|abc|zz/);
    expect(out).toContain('t=xoxc-[redacted]');
  });
});

describe('runApiSync with a browser session', () => {
  let db: DB;
  let fake: FakeSlack;

  beforeEach(() => {
    db = openDb(':memory:');
    fake = new FakeSlack();
    fake.token = XOXC;
    fake.users = [{ id: 'USELF', name: 'me' }];
    fake.conversations = [];
  });

  afterEach(() => db.close());

  function sync(fetchImpl: typeof fetch) {
    const clock = fakeClock();
    return runApiSync({
      db,
      token: XOXC,
      cookie: COOKIE,
      baseUrl: FAKE_BASE_URL,
      fetch: fetchImpl,
      filesDir: tmp,
      log: (l) => logs.push(l),
      attachmentPolicy: 'none',
      clientOptions: { throttle: false, sleep: clock.sleep, now: clock.now, random: () => 0.5 },
    });
  }

  it('passes the cookie on every call and does not warn about a non-user token', async () => {
    const cookies: (string | null)[] = [];
    await sync((async (input, init) => {
      cookies.push(new Headers(init?.headers).get('cookie'));
      return fake.fetch(input, init);
    }) as typeof fetch);
    expect(cookies.length).toBeGreaterThan(1);
    expect(cookies.every((c) => c?.startsWith(`d=${COOKIE}`))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/not a user token/);
    expect(logs.join('\n')).toMatch(/Connected to/);
  });

  it('turns invalid_auth into "Slack signed you out — reconnect"', async () => {
    fake.token = 'xoxc-some-other-token';
    const err = await sync(fake.fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).code).toBe('invalid_auth');
    expect((err as Error).message).toMatch(/Slack signed you out \(invalid_auth\)\. Reconnect/);
  });
});
