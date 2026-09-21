import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConnectError } from './errors';
import {
  SLACKAUTH_USER_AGENT,
  deriveTokenFromCookie,
  extractApiToken,
  normalizeCookie,
  normalizeWorkspace,
} from './session-token';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT_HTML = fs.readFileSync(path.join(here, 'fixtures/ssb-redirect.html'), 'utf8');
const SIGNIN_HTML = fs.readFileSync(path.join(here, 'fixtures/signin.html'), 'utf8');
const FIXTURE_TOKEN =
  'xoxc-000000000300-604451271345-8802919159412-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const COOKIE = 'xoxd-AbC%2FdEf%2BgHi%3D%3D';

interface Seen {
  url: string;
  headers: Record<string, string>;
  redirect?: RequestInit['redirect'];
}

/** A fake fetch serving `routes[url]`; records every request. */
function fakeFetch(routes: Record<string, () => Response>, seen: Seen[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), redirect: init?.redirect });
    const route = routes[url];
    return route ? route() : new Response('not found', { status: 404 });
  }) as typeof fetch;
}

const html =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status, headers: { 'content-type': 'text/html' } });
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });

describe('normalizeWorkspace', () => {
  it.each([
    ['9h', '9h.slack.com'],
    ['9H', '9h.slack.com'],
    ['  9h.slack.com ', '9h.slack.com'],
    ['https://9h.slack.com', '9h.slack.com'],
    ['https://9h.slack.com/archives/C123/p1700000000', '9h.slack.com'],
    ['9h.slack.com/messages', '9h.slack.com'],
    ['acme-corp', 'acme-corp.slack.com'],
    ['acme.enterprise.slack.com', 'acme.enterprise.slack.com'],
  ])('%s → %s', (input, domain) => {
    expect(normalizeWorkspace(input)).toEqual({ domain, url: `https://${domain}/` });
  });

  it('refuses the app URL with a hint to use the workspace subdomain', () => {
    expect(() => normalizeWorkspace('https://app.slack.com/client/T0123/C0456')).toThrow(/workspace's own address/);
    expect(() => normalizeWorkspace('app.slack.com')).toThrow(ConnectError);
  });

  it.each([
    '',
    '   ',
    'example.com',
    'https://evil.com/9h.slack.com',
    'slack.com',
    'www.slack.com',
    'api.slack.com',
    '9h slack',
    '-bad-.slack.com',
  ])('rejects %j', (input) => {
    expect(() => normalizeWorkspace(input)).toThrow(ConnectError);
  });
});

describe('normalizeCookie', () => {
  it('keeps a DevTools-copied (URL-encoded) value as is', () => {
    expect(normalizeCookie(COOKIE)).toBe(COOKIE);
  });

  it('URL-encodes a decoded value the way slackdump does', () => {
    expect(normalizeCookie('xoxd-AbC/dEf+gHi==')).toBe(COOKIE);
  });

  it('strips a d= prefix, quotes and trailing attributes', () => {
    expect(normalizeCookie(` d=${COOKIE}; Path=/; Secure`)).toBe(COOKIE);
    expect(normalizeCookie(`"${COOKIE}"`)).toBe(COOKIE);
  });

  it('rejects values that are not a d cookie', () => {
    expect(() => normalizeCookie('')).toThrow(ConnectError);
    expect(() => normalizeCookie('xoxc-123-456')).toThrow(/xoxd-/);
  });
});

describe('extractApiToken', () => {
  it('finds the token and the team id next to it in Slack boot HTML', () => {
    expect(extractApiToken(BOOT_HTML)).toEqual({ token: FIXTURE_TOKEN, teamId: 'T0FAKETEAM' });
  });

  it('handles boot data embedded as an escaped JSON string', () => {
    const escaped = `<script>var x = "{\\"team_id\\":\\"T9\\",\\"api_token\\":\\"xoxc-1-2-3\\"}";</script>`;
    expect(extractApiToken(escaped)).toEqual({ token: 'xoxc-1-2-3', teamId: 'T9' });
  });

  it('returns null when there is no token (signed-out page)', () => {
    expect(extractApiToken(SIGNIN_HTML)).toBeNull();
    expect(extractApiToken('"api_token":""')).toBeNull();
  });
});

describe('deriveTokenFromCookie', () => {
  it('GETs /ssb/redirect with the cookie and slackauth user agent, and extracts the token', async () => {
    const seen: Seen[] = [];
    const fetch = fakeFetch({ 'https://9h.slack.com/ssb/redirect': html(BOOT_HTML) }, seen);
    const out = await deriveTokenFromCookie({ workspace: '9h', cookie: COOKIE, fetch });
    expect(out).toEqual({ token: FIXTURE_TOKEN, teamId: 'T0FAKETEAM' });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.cookie).toBe(`d=${COOKIE}`);
    expect(seen[0].headers['user-agent']).toBe(SLACKAUTH_USER_AGENT);
    expect(seen[0].redirect).toBe('manual');
  });

  it('encodes a decoded cookie before sending it', async () => {
    const seen: Seen[] = [];
    const fetch = fakeFetch({ 'https://9h.slack.com/ssb/redirect': html(BOOT_HTML) }, seen);
    await deriveTokenFromCookie({ workspace: '9h.slack.com', cookie: 'xoxd-AbC/dEf+gHi==', fetch });
    expect(seen[0].headers.cookie).toBe(`d=${COOKIE}`);
  });

  it('follows redirects within Slack', async () => {
    const fetch = fakeFetch({
      'https://9h.slack.com/ssb/redirect': redirect('https://9h.slack.com/ssb/redirect?next=1'),
      'https://9h.slack.com/ssb/redirect?next=1': html(BOOT_HTML),
    });
    await expect(deriveTokenFromCookie({ workspace: '9h', cookie: COOKIE, fetch })).resolves.toMatchObject({
      token: FIXTURE_TOKEN,
    });
  });

  it('reports a logged-out cookie (redirect to sign-in) without trying further', async () => {
    const seen: Seen[] = [];
    const fetch = fakeFetch(
      {
        'https://9h.slack.com/ssb/redirect': redirect('/?redir=%2Fssb%2Fredirect'),
        'https://9h.slack.com/?redir=%2Fssb%2Fredirect': html(SIGNIN_HTML),
      },
      seen,
    );
    const err = await deriveTokenFromCookie({ workspace: '9h', cookie: COOKIE, fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.message).toMatch(/didn't accept this cookie/);
    expect(err.slackCode).toBe('invalid_auth');
    expect(err.message).not.toContain('xoxd-AbC');
    expect(seen).toHaveLength(1);
  });

  it('never sends the cookie to a non-Slack host', async () => {
    const seen: Seen[] = [];
    const fetch = fakeFetch(
      { 'https://9h.slack.com/ssb/redirect': redirect('https://sso.example.com/saml?x=1') },
      seen,
    );
    await expect(deriveTokenFromCookie({ workspace: '9h', cookie: COOKIE, fetch })).rejects.toThrow(/didn't accept/);
    expect(seen.map((s) => s.url)).toEqual(['https://9h.slack.com/ssb/redirect']);
  });

  it('falls back to the workspace root, then reports a page without a token', async () => {
    const seen: Seen[] = [];
    const fetch = fakeFetch(
      {
        'https://9h.slack.com/ssb/redirect': html(SIGNIN_HTML),
        'https://9h.slack.com/': html('<html>no boot data</html>'),
      },
      seen,
    );
    await expect(deriveTokenFromCookie({ workspace: '9h', cookie: COOKIE, fetch })).rejects.toThrow(
      /didn't accept this cookie/,
    );
    expect(seen.map((s) => s.url)).toEqual(['https://9h.slack.com/ssb/redirect', 'https://9h.slack.com/']);
  });

  it('uses the root page token when /ssb/redirect has none', async () => {
    const fetch = fakeFetch({
      'https://9h.slack.com/ssb/redirect': html('<html></html>'),
      'https://9h.slack.com/': html(BOOT_HTML),
    });
    await expect(deriveTokenFromCookie({ workspace: '9h', cookie: COOKIE, fetch })).resolves.toMatchObject({
      token: FIXTURE_TOKEN,
    });
  });

  it('reports an unknown workspace', async () => {
    const fetch = fakeFetch({});
    await expect(deriveTokenFromCookie({ workspace: 'nope', cookie: COOKIE, fetch })).rejects.toThrow(
      /nope\.slack\.com wasn't found/,
    );
  });

  it('reports network failures with secrets redacted', async () => {
    const failing = (async () => {
      throw new Error(`connect ECONNREFUSED while sending d=${COOKIE}`);
    }) as unknown as typeof globalThis.fetch;
    const err = await deriveTokenFromCookie({ workspace: '9h', cookie: COOKIE, fetch: failing }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.message).toMatch(/Couldn't reach 9h\.slack\.com/);
    expect(err.message).not.toContain('AbC');
  });

  it('talks to SLACK_WEB_ORIGIN instead of the workspace host when overridden (tests)', async () => {
    const seen: Seen[] = [];
    const fetch = fakeFetch({ 'http://127.0.0.1:4999/ssb/redirect': html(BOOT_HTML) }, seen);
    await deriveTokenFromCookie({ workspace: '9h', cookie: COOKIE, fetch, webOrigin: 'http://127.0.0.1:4999' });
    expect(seen[0].url).toBe('http://127.0.0.1:4999/ssb/redirect');
  });
});
