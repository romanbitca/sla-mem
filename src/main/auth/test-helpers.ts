/**
 * Test support (not a test file): a fake of Slack's auth.test endpoint and workspace boot pages,
 * served through an injected `fetch`, plus a fake sign-in window for LoginManager.
 */
import type { SignInSurface } from './signin';

export interface FakeSlackAccount {
  token: string;
  /** The `d` cookie (as the browser stores it, URL-encoded) that must accompany an xoxc token. */
  cookie?: string;
  teamId: string;
  team: string;
  userId: string;
  user: string;
  /** Workspace URL, e.g. https://9h.slack.com/ */
  url: string;
}

export interface FakeSlackRequest {
  url: string;
  method: string;
  authorization: string | null;
  cookie: string | null;
}

export class FakeSlackWeb {
  accounts: FakeSlackAccount[] = [];
  requests: FakeSlackRequest[] = [];
  /** auth.test answers `{ok:false, error}` with this code while set. */
  authError: string | null = null;
  /** Every request fails like a network error with this message while set. */
  networkError: string | null = null;

  constructor(readonly apiBaseUrl = 'https://slack.test/api') {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const req: FakeSlackRequest = {
      url: url.href,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      cookie: headers.get('cookie'),
    };
    this.requests.push(req);
    if (this.networkError) throw new TypeError(this.networkError);
    if (url.href === `${this.apiBaseUrl}/auth.test`) return this.authTest(req);
    if (url.pathname === '/ssb/redirect') return this.bootPage(url, req);
    return new Response('not found', { status: 404 });
  };

  /** The auth.test requests seen so far. */
  authTestCalls(): FakeSlackRequest[] {
    return this.requests.filter((r) => r.url === `${this.apiBaseUrl}/auth.test`);
  }

  private authTest(req: FakeSlackRequest): Response {
    if (this.authError) return jsonResponse({ ok: false, error: this.authError });
    const token = req.authorization?.replace(/^Bearer /, '');
    const account = this.accounts.find((a) => a.token === token);
    if (!account) return jsonResponse({ ok: false, error: 'invalid_auth' });
    if (/^xoxc-/.test(account.token) && !cookieValue(req.cookie, account.cookie))
      return jsonResponse({ ok: false, error: 'invalid_auth' });
    return jsonResponse({
      ok: true,
      url: account.url,
      team: account.team,
      user: account.user,
      team_id: account.teamId,
      user_id: account.userId,
    });
  }

  private bootPage(url: URL, req: FakeSlackRequest): Response {
    const account = this.accounts.find((a) => a.cookie && cookieValue(req.cookie, a.cookie) && hostMatches(url, a.url));
    if (!account) return new Response(null, { status: 302, headers: { location: '/?redir=%2Fssb%2Fredirect' } });
    const boot = `<script>var boot_data = {"team_id":"${account.teamId}","api_token":"${account.token}","user_id":"${account.userId}"};</script>`;
    return new Response(`<!DOCTYPE html><html><head>${boot}</head><body>Redirecting…</body></html>`, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }
}

function cookieValue(header: string | null, expected: string | undefined): boolean {
  if (!header || !expected) return false;
  return header.split(/;\s*/).some((part) => part === `d=${expected}`);
}

function hostMatches(url: URL, workspaceUrl: string): boolean {
  // A fake SLACK_WEB_ORIGIN (127.0.0.1) serves every workspace.
  return url.hostname === '127.0.0.1' || url.hostname === new URL(workspaceUrl).hostname;
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Polls `fn` until it returns truthy (or throws after `timeoutMs`). */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs = 3000,
  stepMs = 5,
): Promise<Exclude<T, null | undefined | false>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as Exclude<T, null | undefined | false>;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** A scriptable stand-in for the Slack sign-in window. */
export class FakeSurface implements SignInSurface {
  opened: string[] = [];
  navigations: string[] = [];
  closed = false;
  url: string | null = null;
  cookie: string | null = null;
  localConfig: string | null = null;
  hosts: string[] = [];
  private closedListener: (() => void) | null = null;

  open(url: string): void {
    this.opened.push(url);
    this.url = url;
  }
  navigate(url: string): void {
    this.navigations.push(url);
    this.url = url;
  }
  close(): void {
    this.closed = true;
  }
  isOpen(): boolean {
    return !this.closed && this.opened.length > 0;
  }
  currentUrl(): string | null {
    return this.url;
  }
  async getSessionCookie(): Promise<string | null> {
    return this.cookie;
  }
  async readLocalConfig(): Promise<string | null> {
    return this.url?.startsWith('https://app.slack.com/') ? this.localConfig : null;
  }
  onClosed(listener: () => void): void {
    this.closedListener = listener;
  }
  visitedWorkspaceHosts(): string[] {
    return [...this.hosts];
  }
  /** The user closes the window. */
  userCloses(): void {
    this.closed = true;
    this.closedListener?.();
  }
}

/** localConfig_v2 as the Slack web client writes it. */
export function localConfig(teams: { id: string; name: string; domain: string; token: string }[]): string {
  return JSON.stringify({ teams: Object.fromEntries(teams.map((t) => [t.id, { ...t, user_id: 'U0ROMAN' }])) });
}
