/**
 * A local stand-in for Slack (PLAN §13), so the real app can sign in and sync end to end without a
 * Slack workspace or network access:
 *
 *   Web API   /api/<method>          auth.test, users.list, users.conversations, conversations.history
 *                                    (cursor pages, oldest/latest/inclusive, a 90-day Free window),
 *                                    conversations.replies (parent repeated per page), emoji.list …
 *                                    Requires the xoxc token AND the `d` cookie, like Slack.
 *   Files     /files-pri/…           attachment downloads (need the session, like Slack)
 *   Web app   /signin                a sign-in page ("Sign in with email") that sets the HttpOnly
 *                                    `d` cookie and opens /client/<team>
 *             /client/<team>         "the web client": writes localStorage.localConfig_v2
 *             /ssb/redirect          boot page with the session token for a valid cookie
 *   Control   /_mock/session         the current {cookie, token} (for the pasted-cookie path)
 *             /_mock/state           call counts per method
 *             /_mock/fail            POST {"method", "status"|"error"|"network", "times"} fault injection
 *             /_mock/mutate          POST: an edit, a late thread reply and a new DM, like a busy day
 *
 * Built on FakeSlack (the unit tests' in-process fake) so both share one set of Slack semantics.
 * Data comes from the synthetic "Brightwave" workspace (test/synthetic).
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeSlack, type Fault } from '../../src/main/slack/fake-slack';
import type { SlackFile, SlackMessage } from '../../src/main/slack/types';
import { generateWorkspace, SELF, TEAM_DOMAIN, TEAM_ID, TEAM_NAME } from '../synthetic/workspace';
import { makePng, PAINTERS } from '../synthetic/media';

export interface MockSlackOptions {
  port?: number;
  seed?: number;
  /** Approximate number of messages in the workspace (default 3,000 — quick first syncs). */
  messages?: number;
  /** Slack Free hides history older than this many days (default 90; null = paid plan). */
  historyWindowDays?: number | null;
  /** Answer every Web API call this much later (to interrupt a sync midway in tests). */
  delayMs?: number;
}

export interface MockSlack {
  /** e.g. http://127.0.0.1:4849 — the "web origin" for the sign-in window. */
  url: string;
  apiBaseUrl: string;
  session: { cookie: string; token: string };
  fake: FakeSlack;
  /** Changes the per-call delay while running. */
  setDelay(ms: number): void;
  close(): Promise<void>;
}

const REAL_FILES_ORIGIN = 'https://files.slack.com';

export async function startMockSlack(opts: MockSlackOptions = {}): Promise<MockSlack> {
  const session = {
    cookie: `xoxd-${randomBytes(24).toString('base64url')}`,
    token: `xoxc-${randomBytes(6).toString('hex')}-${randomBytes(6).toString('hex')}-${randomBytes(16).toString('hex')}`,
  };
  const fake = new FakeSlack();
  let delayMs = opts.delayMs ?? 0;
  const server = http.createServer((req, res) => void handle(req, res).catch((err) => fail(res, err)));
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.baseUrl = `${url}/api`;
  fake.token = session.token;
  fake.historyWindowDays = opts.historyWindowDays === undefined ? 90 : opts.historyWindowDays;
  loadWorkspace(fake, url, opts);

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', url);
    const cookies = parseCookies(req.headers.cookie);
    const body = await readBody(req);

    if (u.pathname.startsWith('/api/')) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      // Like Slack: a session token is useless without its `d` cookie.
      const headers = { ...req.headers } as Record<string, string>;
      if (cookies.d !== session.cookie) headers.authorization = 'Bearer invalid-without-cookie';
      return relay(res, await fake.fetch(`${url}${u.pathname}`, { method: 'POST', headers, body }));
    }
    if (u.pathname.startsWith('/files-pri/') || u.pathname.startsWith('/files-tmb/')) {
      if (cookies.d !== session.cookie) return send(res, 200, 'text/html', signInPage('Your session ended.'));
      return relay(
        res,
        await fake.fetch(`${url}${u.pathname}`, { headers: { authorization: req.headers.authorization ?? '' } }),
      );
    }
    switch (u.pathname) {
      case '/':
      case '/signin':
        return send(res, 200, 'text/html', signInPage());
      case '/_web/login':
        res.setHeader('Set-Cookie', [
          `d=${session.cookie}; Path=/; HttpOnly; SameSite=Lax`,
          `d-s=${Math.floor(Date.now() / 1000)}; Path=/; HttpOnly; SameSite=Lax`,
        ]);
        res.writeHead(302, { Location: `/client/${TEAM_ID}` });
        return void res.end();
      case '/ssb/redirect':
        if (cookies.d !== session.cookie) {
          res.writeHead(302, { Location: '/signin?redir=%2Fssb%2Fredirect' });
          return void res.end();
        }
        return send(res, 200, 'text/html', bootPage(session.token));
      case '/_mock/session':
        return send(res, 200, 'application/json', JSON.stringify(session));
      case '/_mock/state':
        return send(res, 200, 'application/json', JSON.stringify(callCounts(fake)));
      case '/_mock/fail': {
        const f = JSON.parse(body || '{}') as { method: string; times?: number } & Record<string, unknown>;
        const fault: Fault = f.network
          ? { network: String(f.network) }
          : f.error
            ? { error: String(f.error) }
            : f.status === 429
              ? { status: 429, retryAfter: Number(f.retryAfter ?? 1) }
              : { status: Number(f.status ?? 500) as 500 };
        fake.inject(f.method, fault, f.times ?? 1);
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      case '/_mock/mutate':
        return send(res, 200, 'application/json', JSON.stringify(mutate(fake)));
    }
    if (u.pathname.startsWith('/client')) return send(res, 200, 'text/html', clientPage(session.token));
    send(res, 404, 'text/plain', 'not found');
  }

  return {
    url,
    apiBaseUrl: fake.baseUrl,
    session,
    fake,
    setDelay: (ms) => {
      delayMs = ms;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ─── data ─────────────────────────────────────────────────────────────────────────────────────

function loadWorkspace(fake: FakeSlack, url: string, opts: MockSlackOptions): void {
  const ws = generateWorkspace({ seed: opts.seed ?? 7, messages: opts.messages ?? 3_000 });
  fake.team = { id: TEAM_ID, name: TEAM_NAME, domain: TEAM_DOMAIN };
  fake.selfUserId = SELF;
  fake.users = ws.users;
  fake.conversations = ws.conversations;
  for (const c of ws.conversations) if (c.is_mpim && c.members) fake.members.set(c.id, c.members);
  fake.emoji = Object.fromEntries(
    Object.entries(ws.customEmoji).filter(([, v]) => v.startsWith('alias:') || v.startsWith('http')),
  );

  const bytesById = new Map(ws.gen.files.filter((f) => f.bytes).map((f) => [f.id, f] as const));
  for (const [convId, messages] of ws.gen.messages) {
    for (const m of messages) {
      for (const f of m.files ?? []) rewriteFile(fake, f, url, bytesById.get(f.id)?.bytes ?? null);
      const isReply = m.thread_ts && m.thread_ts !== m.ts;
      if (!isReply || m.subtype === 'thread_broadcast') fake.addMessage(convId, m);
      if (isReply) {
        const key = `${convId}/${m.thread_ts}`;
        fake.replies.set(key, [...(fake.replies.get(key) ?? []), m]);
      }
    }
  }
}

/** Points a synthetic file's URLs at the mock and registers its bytes (PNG thumbnails too). */
function rewriteFile(fake: FakeSlack, f: SlackFile, url: string, bytes: Buffer | null): void {
  for (const key of ['url_private', 'url_private_download', 'thumb_360', 'thumb_pdf'] as const) {
    const value = f[key];
    if (typeof value !== 'string' || !value.startsWith(REAL_FILES_ORIGIN)) continue;
    const local = value.replace(REAL_FILES_ORIGIN, url);
    f[key] = local;
    if (key.startsWith('thumb')) {
      fake.files.set(local, { body: new Uint8Array(makePng(180, 120, PAINTERS.mockup)), contentType: 'image/png' });
    } else if (bytes) {
      fake.files.set(local, { body: new Uint8Array(bytes), contentType: f.mimetype ?? 'application/octet-stream' });
    }
  }
}

/** A busy day in Slack: an edit, a late reply to an old thread, and a new DM. */
function mutate(fake: FakeSlack): Record<string, string> {
  const nowS = Math.floor(Date.now() / 1000);
  const general = fake.history.get('C0DEMOGENL') ?? [];
  const recent = [...general].reverse().find((m) => m.user && !m.subtype && !m.files);
  if (recent) fake.editMessage('C0DEMOGENL', recent.ts, `${recent.text} (edited in the mock)`, `${nowS}.000100`);
  // A thread whose parent is older than the 7-day history overlap but still active (PLAN §5.2's
  // active-thread recheck). Replies to threads dormant for weeks can't be seen (PLAN §5.4).
  const eng = fake.history.get('C0DEMOENGR') ?? [];
  const parent = [...eng]
    .reverse()
    .find(
      (m) =>
        (m.reply_count ?? 0) > 0 &&
        Number(m.ts) < nowS - 8 * 86_400 &&
        Number(m.latest_reply ?? 0) > nowS - 20 * 86_400,
    );
  if (parent)
    fake.addReply('C0DEMOENGR', parent.ts, {
      type: 'message',
      user: 'U0DEMOPRIY',
      ts: `${nowS - 60}.000200`,
      text: 'Late reply from the mock',
    });
  const dm: SlackMessage = {
    type: 'message',
    user: 'U0DEMOPRIY',
    ts: `${nowS - 30}.000300`,
    text: 'New DM from the mock :wave:',
  };
  fake.addMessage('D0DEMOPRIY', dm);
  return { edited: recent?.ts ?? '', repliedTo: parent?.ts ?? '', dm: dm.ts };
}

function callCounts(fake: FakeSlack): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of fake.calls) out[c.method] = (out[c.method] ?? 0) + 1;
  return out;
}

// ─── pages ────────────────────────────────────────────────────────────────────────────────────

const PAGE_STYLE = 'font: 16px system-ui; max-width: 420px; margin: 80px auto; text-align: center; color: #1d1c1d';

function signInPage(notice = ''): string {
  return `<!doctype html><html><head><title>Sign in | Slack (mock)</title></head>
<body style="${PAGE_STYLE}">
  <h1>Sign in to ${TEAM_NAME}</h1>
  <p style="color:#616061">Mock Slack for testing Slamem. ${notice}</p>
  <form method="post" action="/_web/login"><button id="signin" type="submit"
    style="font-size:16px;padding:12px 24px;background:#4a154b;color:#fff;border:0;border-radius:6px">Sign in with email</button></form>
</body></html>`;
}

function clientPage(token: string): string {
  const teams = { [TEAM_ID]: { id: TEAM_ID, name: TEAM_NAME, domain: TEAM_DOMAIN, token, user_id: SELF } };
  return `<!doctype html><html><head><title>Slack (mock)</title>
<script>localStorage.setItem('localConfig_v2', ${JSON.stringify(JSON.stringify({ teams }))});</script></head>
<body style="${PAGE_STYLE}"><h1>You're signed in</h1><p>This is the mock Slack web client.</p></body></html>`;
}

function bootPage(token: string): string {
  return `<!doctype html><html><head><script>var boot_data = {"team_id":"${TEAM_ID}","api_token":"${token}","user_id":"${SELF}"};</script></head><body>Redirecting…</body></html>`;
}

// ─── http plumbing ────────────────────────────────────────────────────────────────────────────

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function relay(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  const body = Buffer.from(await response.arrayBuffer());
  if (!headers['content-length'] && !headers['transfer-encoding']) headers['content-length'] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(body);
}

function send(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function fail(res: http.ServerResponse, err: unknown): void {
  if (!res.headersSent) send(res, 500, 'text/plain', String(err));
  else res.end();
}
