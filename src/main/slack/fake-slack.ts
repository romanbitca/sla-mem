/**
 * Test support (not a test file): an in-process fake of the Slack Web API and file host, used
 * through an injected `fetch`. It paginates fixtures with cursors like Slack does, hides history
 * beyond a Free-plan window, and can inject 429s, 5xx, network errors and Slack error codes.
 */
import type { TeamIcon } from './api-types';
import type { SlackConversation, SlackMessage, SlackUser } from './types';

export const FAKE_TOKEN = 'xoxp-1111-2222-fake-token-do-not-log';
export const FAKE_BASE_URL = 'https://slack.test/api';

export type Fault =
  | { status: 429; retryAfter?: number }
  | { status: 500 | 502 | 503 }
  | { error: string; retryAfter?: number }
  | { network: string };

interface PendingFault {
  method: string;
  fault: Fault;
  remaining: number;
  when?: (params: Record<string, string>) => boolean;
}

export interface FakeFile {
  body: string | Uint8Array<ArrayBuffer>;
  contentType?: string;
  status?: number;
  headers?: Record<string, string>;
  /** Omit Content-Length (forces the downloader to count streamed bytes). */
  noLength?: boolean;
}

export interface RecordedCall {
  method: string;
  params: Record<string, string>;
}

export interface RecordedDownload {
  url: string;
  authorization: string | null;
}

export class FakeSlack {
  token = FAKE_TOKEN;
  baseUrl = FAKE_BASE_URL;
  team: { id: string; name: string; domain: string; icon?: TeamIcon } = {
    id: 'T0001',
    name: '9hdigital',
    domain: '9hdigital',
  };
  selfUserId = 'USELF';
  /** Server-side page size cap, so small fixtures still paginate. */
  pageSize = 200;
  /** Free plan: messages older than this many days (relative to `now`) are invisible. null = no limit. */
  historyWindowDays: number | null = 90;
  now: () => number = Date.now;

  users: SlackUser[] = [];
  conversations: SlackConversation[] = [];
  /** conversations.members data (MPIMs). */
  members = new Map<string, string[]>();
  /** Channel history: top-level messages and thread broadcasts. */
  history = new Map<string, SlackMessage[]>();
  /** `${channel}/${threadTs}` → replies (excluding the parent). */
  replies = new Map<string, SlackMessage[]>();
  emoji: Record<string, string> | null = {};
  /** Error code returned for history/replies of a channel (e.g. not_in_channel). */
  channelErrors = new Map<string, string>();
  /** URL (origin + path) → file response. */
  files = new Map<string, FakeFile | ((auth: string | null) => Response)>();

  readonly calls: RecordedCall[] = [];
  readonly downloads: RecordedDownload[] = [];
  /** Called before each API request is answered (e.g. to abort mid-run). */
  onCall?: (call: RecordedCall) => void;

  private faults: PendingFault[] = [];

  /** Makes the next `times` calls of `method` (matching `when`) fail with `fault`. */
  inject(method: string, fault: Fault, times = 1, when?: (params: Record<string, string>) => boolean): void {
    this.faults.push({ method, fault, remaining: times, when });
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  // -------------------------------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------------------------------

  addMessage(channel: string, msg: SlackMessage): SlackMessage {
    const list = this.history.get(channel) ?? [];
    list.push(msg);
    this.history.set(channel, list);
    return msg;
  }

  /** Adds a reply and updates the parent's reply metadata the way Slack does. */
  addReply(channel: string, threadTs: string, reply: SlackMessage, opts: { broadcast?: boolean } = {}): SlackMessage {
    const full: SlackMessage = { type: 'message', ...reply, thread_ts: threadTs };
    const key = `${channel}/${threadTs}`;
    const list = this.replies.get(key) ?? [];
    list.push(full);
    this.replies.set(key, list);
    const parent = this.findMessage(channel, threadTs);
    if (parent) {
      parent.thread_ts = threadTs;
      parent.reply_count = list.length;
      parent.latest_reply = list
        .map((r) => r.ts)
        .sort(byTs)
        .at(-1);
      parent.reply_users = [...new Set(list.map((r) => r.user).filter((u): u is string => typeof u === 'string'))];
    }
    if (opts.broadcast) {
      full.subtype = 'thread_broadcast';
      if (parent) full.root = structuredClone(parent);
      this.addMessage(channel, full);
    }
    return full;
  }

  findMessage(channel: string, ts: string): SlackMessage | undefined {
    return this.history.get(channel)?.find((m) => m.ts === ts);
  }

  editMessage(channel: string, ts: string, text: string, editedTs: string): void {
    const msg = this.findMessage(channel, ts) ?? this.findReply(channel, ts);
    if (!msg) throw new Error(`no message ${channel}/${ts}`);
    msg.text = text;
    msg.edited = { user: msg.user, ts: editedTs };
  }

  private findReply(channel: string, ts: string): SlackMessage | undefined {
    for (const [key, list] of this.replies) {
      if (!key.startsWith(`${channel}/`)) continue;
      const found = list.find((m) => m.ts === ts);
      if (found) return found;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // fetch
  // -------------------------------------------------------------------------------------------

  readonly fetch: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    if (url.href.startsWith(`${this.baseUrl}/`)) {
      const params = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
      return this.handleApi(url.href.slice(this.baseUrl.length + 1), params, headers.get('authorization'));
    }
    return this.handleDownload(url, headers.get('authorization'));
  };

  private handleApi(method: string, params: Record<string, string>, auth: string | null): Response {
    const call = { method, params };
    this.calls.push(call);
    this.onCall?.(call);
    const fault = this.takeFault(method, params);
    if (fault) return faultResponse(fault);
    if (auth !== `Bearer ${this.token}`) return json({ ok: false, error: 'invalid_auth' });
    const handler = this.handlers[method];
    return json(handler ? handler(params) : { ok: false, error: 'unknown_method' });
  }

  private takeFault(method: string, params: Record<string, string>): Fault | null {
    const pending = this.faults.find((f) => f.method === method && f.remaining > 0 && (!f.when || f.when(params)));
    if (!pending) return null;
    pending.remaining--;
    return pending.fault;
  }

  private readonly handlers: Record<string, (p: Record<string, string>) => object> = {
    'auth.test': () => ({
      ok: true,
      url: `https://${this.team.domain}.slack.com/`,
      team: this.team.name,
      user: 'me',
      team_id: this.team.id,
      user_id: this.selfUserId,
    }),
    'team.info': () => ({ ok: true, team: this.team }),
    'users.list': (p) => this.page(this.users, p, 'members'),
    'users.conversations': (p) => {
      if (p.user !== this.selfUserId) return { ok: false, error: 'user_not_found' };
      // Like the real API: MPIM objects carry no member list.
      const listed = this.conversations.map(({ members: _members, ...c }) => c);
      return this.page(listed, p, 'channels');
    },
    'conversations.members': (p) => {
      const members = this.members.get(p.channel);
      return members ? this.page(members, p, 'members') : { ok: false, error: 'channel_not_found' };
    },
    'conversations.history': (p) => this.historyPage(p),
    'conversations.replies': (p) => this.repliesPage(p),
    'emoji.list': () =>
      this.emoji ? { ok: true, emoji: this.emoji } : { ok: false, error: 'missing_scope', needed: 'emoji:read' },
  };

  private historyPage(p: Record<string, string>): object {
    const error = this.channelErrors.get(p.channel);
    if (error) return { ok: false, error };
    if (!this.history.has(p.channel) && !this.conversations.some((c) => c.id === p.channel)) {
      return { ok: false, error: 'channel_not_found' };
    }
    const inRange = this.visible(this.history.get(p.channel) ?? []).filter((m) => withinBounds(m.ts, p));
    // Newest first, as Slack returns history.
    return this.page(
      inRange.sort((a, b) => byTs(b.ts, a.ts)),
      p,
      'messages',
    );
  }

  private repliesPage(p: Record<string, string>): object {
    const error = this.channelErrors.get(p.channel);
    if (error) return { ok: false, error };
    const parent = this.findMessage(p.channel, p.ts);
    if (!parent || !this.visible([parent]).length) return { ok: false, error: 'thread_not_found' };
    const replies = this.visible(this.replies.get(`${p.channel}/${p.ts}`) ?? [])
      .filter((m) => withinBounds(m.ts, p))
      .sort((a, b) => byTs(a.ts, b.ts));
    const res = this.page(replies, p, 'messages') as { messages: SlackMessage[] };
    // Slack repeats the parent at the top of every page.
    res.messages = [parent, ...res.messages];
    return res;
  }

  private visible(messages: SlackMessage[]): SlackMessage[] {
    if (this.historyWindowDays == null) return [...messages];
    const cutoff = this.now() / 1000 - this.historyWindowDays * 86_400;
    return messages.filter((m) => Number(m.ts) >= cutoff);
  }

  private page<T>(items: T[], p: Record<string, string>, key: string): object {
    const limit = Math.min(Number(p.limit) || 100, this.pageSize);
    const offset = p.cursor ? Number(Buffer.from(p.cursor, 'base64').toString('utf8').replace('offset:', '')) : 0;
    const slice = items.slice(offset, offset + limit);
    const more = offset + limit < items.length;
    return {
      ok: true,
      [key]: structuredClone(slice),
      has_more: more,
      response_metadata: { next_cursor: more ? Buffer.from(`offset:${offset + limit}`).toString('base64') : '' },
    };
  }

  private handleDownload(url: URL, authorization: string | null): Response {
    this.downloads.push({ url: url.href, authorization });
    const file = this.files.get(`${url.origin}${url.pathname}`);
    if (!file) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (typeof file === 'function') return file(authorization);
    const body = typeof file.body === 'string' ? new TextEncoder().encode(file.body) : file.body;
    const headers: Record<string, string> = {
      'content-type': file.contentType ?? 'application/octet-stream',
      ...file.headers,
    };
    if (!file.noLength) headers['content-length'] = String(body.byteLength);
    return new Response(file.noLength ? streamOf(body) : body, { status: file.status ?? 200, headers });
  }
}

function json(body: object, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function faultResponse(fault: Fault): Response {
  if ('network' in fault) throw new TypeError('fetch failed', { cause: { code: fault.network } });
  if ('error' in fault) {
    const headers: Record<string, string> = fault.retryAfter != null ? { 'retry-after': String(fault.retryAfter) } : {};
    return json({ ok: false, error: fault.error }, 200, headers);
  }
  if (fault.status === 429) {
    const headers: Record<string, string> = fault.retryAfter != null ? { 'retry-after': String(fault.retryAfter) } : {};
    return new Response('', { status: 429, headers });
  }
  return new Response('upstream error', { status: fault.status });
}

/** Slack's oldest/latest/inclusive semantics (inclusive applies to both bounds). */
function withinBounds(ts: string, p: Record<string, string>): boolean {
  const inclusive = p.inclusive === 'true' || p.inclusive === '1';
  const t = Number(ts);
  if (p.oldest && (inclusive ? t < Number(p.oldest) : t <= Number(p.oldest))) return false;
  if (p.latest && (inclusive ? t > Number(p.latest) : t >= Number(p.latest))) return false;
  return true;
}

function byTs(a: string, b: string): number {
  return Number(a) - Number(b);
}

/** A body without a known length, delivered in two chunks. */
function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  const mid = Math.floor(bytes.byteLength / 2);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
}

/** A clock whose `sleep` advances time instantly, recording each wait. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      t += ms;
    },
  };
}
