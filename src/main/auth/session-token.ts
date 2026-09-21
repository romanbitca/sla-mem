/**
 * Turning a Slack web session cookie (`d=xoxd-…`) into the matching `xoxc-` API token, plus the
 * input normalization shared by every connect method.
 *
 * Derivation matches slackdump (rusq/slackdump `auth/token.go`, `getTokenByCookie`):
 *   GET https://<workspace>.slack.com/ssb/redirect
 *   headers: User-Agent = slackauth.DefaultUserAgent, Cookie: d=<cookie>
 *   require HTTP 200, then `"api_token":"([^"]+)"` from the page's boot data.
 * and slackdump's cookie encoding (`auth/value.go` `makeCookie`): a value that isn't URL-safe
 * (`[-._~%a-zA-Z0-9]`) is query-escaped, so a DevTools-copied (already %-encoded) value is sent as
 * is and a decoded one (with `/`, `+`, `=`) is re-encoded the way the browser stores it.
 * Additions over slackdump: redirects are followed by hand (only within Slack hosts, so the cookie
 * never leaves Slack) to tell "logged out" (redirect to sign-in) apart from other failures, and the
 * workspace root page is tried as a fallback when /ssb/redirect has no token.
 */
import { ConnectError } from './errors';
import { isTrustedSessionHost, resolveWebOrigin, workspaceBaseUrl } from './origin';
import { safeErrorMessage } from '../redact';

/** slackauth `DefaultUserAgent` (Chrome 129 on macOS), which slackdump sends for this request. */
export const SLACKAUTH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Subdomains of slack.com that are Slack itself, not a workspace. */
const RESERVED_SUBDOMAINS = new Set([
  'app',
  'api',
  'www',
  'files',
  'status',
  'edgeapi',
  'slack-files',
  'downloads',
  'my',
]);
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const EXAMPLE = 'e.g. 9h.slack.com';

/**
 * Accepts `9h`, `9h.slack.com`, `https://9h.slack.com/…` (any path) and returns the workspace host
 * and root URL. `app.slack.com/client/T…` is refused with a hint: it doesn't name the workspace.
 */
export function normalizeWorkspace(input: string): { domain: string; url: string } {
  const s = (input ?? '').trim().toLowerCase();
  if (!s) throw new ConnectError(`Enter your Slack workspace address (${EXAMPLE})`);

  let host: string;
  if (/^[a-z0-9-]+$/.test(s)) {
    host = `${s}.slack.com`;
  } else {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`);
    } catch {
      throw new ConnectError(`“${input.trim()}” isn't a Slack workspace address (${EXAMPLE})`);
    }
    host = url.hostname.replace(/\.$/, '');
  }

  if (host === 'app.slack.com') {
    throw new ConnectError(
      `That's the Slack app address, which doesn't name your workspace. Enter the workspace's own address (${EXAMPLE}); ` +
        'Slack shows it in the workspace menu.',
    );
  }
  if (!host.endsWith('.slack.com')) {
    throw new ConnectError(`“${input.trim()}” isn't a Slack workspace address (${EXAMPLE})`);
  }
  const labels = host.slice(0, -'.slack.com'.length).split('.');
  if (!labels.length || !labels.every((l) => LABEL_RE.test(l)) || RESERVED_SUBDOMAINS.has(labels[0])) {
    throw new ConnectError(`“${input.trim()}” isn't a Slack workspace address (${EXAMPLE})`);
  }
  return { domain: host, url: `https://${host}/` };
}

const URL_SAFE_RE = /^[-._~%a-zA-Z0-9]*$/;

/**
 * Normalizes a pasted/captured `d` cookie value to the URL-encoded form browsers store and Slack
 * expects in `Cookie: d=…`. Tolerates a leading `d=`, quotes and a trailing `; Path=…`.
 */
export function normalizeCookie(input: string): string {
  let v = (input ?? '').trim();
  v = v
    .replace(/^d\s*=\s*/, '')
    .split(';')[0]
    .trim();
  v = v.replace(/^"(.*)"$/, '$1').trim();
  if (!v) throw new ConnectError('Paste the value of the `d` cookie (it starts with xoxd-)');
  if (!URL_SAFE_RE.test(v)) v = encodeURIComponent(v);
  let decoded: string;
  try {
    decoded = decodeURIComponent(v);
  } catch {
    decoded = v;
  }
  if (!decoded.startsWith('xoxd-')) {
    throw new ConnectError("That doesn't look like Slack's `d` cookie — its value starts with xoxd-");
  }
  return v;
}

// slackdump's regex, plus a tolerant variant for JSON embedded as an escaped string.
const API_TOKEN_RES = [/"api_token":"([^"]+)"/, /\\?"api_token\\?"\s*:\s*\\?"(xox[a-z]-[A-Za-z0-9-]+)/];
const TEAM_ID_RE = /\\?"team_id\\?"\s*:\s*\\?"([TE][A-Z0-9]+)/g;

/** Finds the session token (and the team id next to it) in a Slack boot page. */
export function extractApiToken(html: string): { token: string; teamId?: string } | null {
  for (const re of API_TOKEN_RES) {
    const m = re.exec(html);
    if (!m || !/^xox[a-z]-/.test(m[1])) continue;
    return { token: m[1], teamId: nearestTeamId(html, m.index) };
  }
  return null;
}

function nearestTeamId(html: string, at: number): string | undefined {
  const start = Math.max(0, at - 2000);
  const window = html.slice(start, at + 2000);
  let best: { id: string; dist: number } | undefined;
  for (const m of window.matchAll(TEAM_ID_RE)) {
    const dist = Math.abs(start + (m.index ?? 0) - at);
    if (!best || dist < best.dist) best = { id: m[1], dist };
  }
  return best?.id;
}

type PageOutcome =
  | { kind: 'token'; token: string; teamId?: string }
  | { kind: 'signed_out' }
  | { kind: 'no_token' }
  | { kind: 'not_found' }
  | { kind: 'http'; status: number };

/**
 * GETs the workspace's boot page with only the `d` cookie and extracts the `xoxc-` token.
 * Throws `ConnectError` with a user-facing, redacted message.
 */
export async function deriveTokenFromCookie(opts: {
  workspace: string;
  cookie: string;
  fetch?: typeof fetch;
  webOrigin?: string;
}): Promise<{ token: string; teamId?: string }> {
  const { domain, url } = normalizeWorkspace(opts.workspace);
  const cookie = normalizeCookie(opts.cookie);
  const webOrigin = resolveWebOrigin(opts.webOrigin);
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = workspaceBaseUrl(url, webOrigin);

  let last: PageOutcome = { kind: 'no_token' };
  for (const pageUrl of [new URL('ssb/redirect', base).href, base]) {
    try {
      last = await fetchBootPage(fetchImpl, pageUrl, cookie, webOrigin);
    } catch (err) {
      throw new ConnectError(`Couldn't reach ${domain}: ${safeErrorMessage(err, [cookie])}`);
    }
    if (last.kind === 'token') return { token: last.token, teamId: last.teamId };
    // A sign-in redirect or unknown workspace is definitive; only "page without a token" gets a retry.
    if (last.kind === 'signed_out' || last.kind === 'not_found') break;
  }

  switch (last.kind) {
    case 'not_found':
      throw new ConnectError(`Slack workspace ${domain} wasn't found — check the address`);
    case 'http':
      throw new ConnectError(`Slack answered HTTP ${last.status} for ${domain} — try again in a minute`);
    default:
      throw new ConnectError(
        `Slack didn't accept this cookie for ${domain} — it may have expired or belong to another workspace. ` +
          'Open Slack in your browser, sign in, and copy the `d` cookie again.',
        'invalid_auth',
      );
  }
}

async function fetchBootPage(
  fetchImpl: typeof fetch,
  startUrl: string,
  cookie: string,
  webOrigin: string,
): Promise<PageOutcome> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': SLACKAUTH_USER_AGENT,
        Cookie: `d=${cookie}`,
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location) return { kind: 'http', status: res.status };
      const next = new URL(location, url);
      if (looksLikeSignIn(next)) return { kind: 'signed_out' };
      // Never carry the cookie off Slack (SSO providers, marketing pages…); off-Slack means signed out.
      if (!isTrustedSessionHost(next.hostname, webOrigin) || next.protocol !== new URL(url).protocol)
        return { kind: 'signed_out' };
      url = next.href;
      continue;
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'not_found' };
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: 'http', status: res.status };
    }
    const found = extractApiToken(await res.text());
    return found ? { kind: 'token', ...found } : { kind: 'no_token' };
  }
  return { kind: 'http', status: 310 };
}

function looksLikeSignIn(url: URL): boolean {
  return /\/(signin|sign_in|sign-in|login|checkcookie)\b/i.test(url.pathname) || url.searchParams.has('redir');
}
