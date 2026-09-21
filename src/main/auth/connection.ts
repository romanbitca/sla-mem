/**
 * The archive's Slack connection: validating a captured web session with auth.test, binding the
 * archive to one Slack identity (PLAN §5.7), saving the session encrypted (§3.5), and the
 * non-secret summary in meta `connection` that the UI reads (the renderer never gets secrets).
 *
 * Events: 'connected' (SlackConnectionDTO) after a successful sign-in, 'disconnected' after
 * Disconnect, 'changed' whenever the status the UI shows changed (e.g. Slack signed the user out).
 */
import { EventEmitter } from 'node:events';
import type { AuthMethod, CookieLoginRequest, SlackConnectionDTO } from '../../shared/types';
import { deleteMeta, getMeta, listUsers, setMeta, type DB } from '../db';
import { redactSecrets, safeErrorMessage } from '../redact';
import { SlackApiError, SlackClient, SLACK_API_BASE_URL } from '../slack';
import type { AuthTestResponse } from '../slack/api-types';
import type { CredentialStore, StoredCredentials } from './credentials';
import { ConnectError, isExpiredSessionCode } from './errors';
import { resolveWebOrigin } from './origin';
import { deriveTokenFromCookie, normalizeCookie, normalizeWorkspace } from './session-token';

export const CONNECTION_META_KEY = 'connection';

/** Non-secret connection summary persisted in meta `connection`. */
interface ConnectionMeta {
  method: AuthMethod;
  teamId: string;
  teamName: string;
  teamDomain: string;
  userId: string;
  userName: string;
  connectedAt: number;
  lastCheckedAt: number | null;
  /** Slack's error code from the last failed check (e.g. invalid_auth), or null. */
  lastErrorCode: string | null;
  /** Plain-language description of the last problem, or null. */
  lastError: string | null;
}

export interface ResolvedCredentials {
  token: string;
  cookie: string;
  method: AuthMethod;
}

export interface ConnectionServiceOptions {
  db: DB;
  store: CredentialStore;
  /** Default https://slack.com/api. */
  apiBaseUrl?: string;
  /** Default https://app.slack.com (tests and the mock Slack use a local origin). */
  webOrigin?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Forgets the sign-in window's Slack session (cookies, local storage) on Disconnect. */
  clearBrowserSession?: () => Promise<void>;
}

export const SIGNED_OUT_MESSAGE = 'Slack signed you out. Reconnect to keep archiving.';
const UNREACHABLE_MESSAGE = 'Can’t reach Slack right now. Check your internet connection and try again.';

export class ConnectionService extends EventEmitter {
  private readonly db: DB;
  private readonly store: CredentialStore;
  private readonly apiBaseUrl: string;
  private readonly webOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly clearBrowserSession: () => Promise<void>;
  /** Saved credentials, cached after the first decrypt (undefined = not loaded yet). */
  private cached: StoredCredentials | null | undefined;

  constructor(opts: ConnectionServiceOptions) {
    super();
    this.db = opts.db;
    this.store = opts.store;
    this.apiBaseUrl = (opts.apiBaseUrl ?? SLACK_API_BASE_URL).replace(/\/+$/, '');
    this.webOrigin = resolveWebOrigin(opts.webOrigin);
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
    this.clearBrowserSession = opts.clearBrowserSession ?? (async () => {});
  }

  /** A Slack session is saved (it may still have been signed out by Slack; see status().expired). */
  hasCredentials(): boolean {
    return this.readMeta() != null;
  }

  /** The saved session, or null. Throws when the OS secure storage can't be read. */
  getCredentials(): ResolvedCredentials | null {
    if (!this.readMeta()) return null;
    if (this.cached === undefined) this.cached = this.store.get();
    const c = this.cached;
    return c ? { token: c.token, cookie: c.cookie, method: c.method } : null;
  }

  status(): SlackConnectionDTO {
    const meta = this.readMeta();
    if (!meta) return disconnectedDTO();
    return {
      connected: true,
      method: meta.method,
      teamId: meta.teamId || null,
      teamName: meta.teamName || null,
      teamDomain: meta.teamDomain || null,
      userId: meta.userId || null,
      userName: meta.userName || null,
      connectedAt: meta.connectedAt || null,
      lastCheckedAt: meta.lastCheckedAt,
      expired: isExpiredSessionCode(meta.lastErrorCode),
      error: meta.lastError,
    };
  }

  /** Re-validates the saved session with auth.test and records the outcome. */
  async test(): Promise<SlackConnectionDTO> {
    const meta = this.readMeta();
    if (!meta) return this.status();
    let creds: ResolvedCredentials | null;
    try {
      creds = this.getCredentials();
    } catch (err) {
      this.writeMeta({
        ...meta,
        lastCheckedAt: this.now(),
        lastErrorCode: 'storage',
        lastError: safeErrorMessage(err),
      });
      return this.changed();
    }
    if (!creds) {
      this.writeMeta({
        ...meta,
        lastCheckedAt: this.now(),
        lastErrorCode: 'invalid_auth',
        lastError: SIGNED_OUT_MESSAGE,
      });
      return this.changed();
    }
    try {
      const auth = await this.authTest(creds.token, creds.cookie);
      this.writeMeta({
        ...meta,
        teamName: auth.team || meta.teamName,
        userName: auth.user || meta.userName,
        lastCheckedAt: this.now(),
        lastErrorCode: null,
        lastError: null,
      });
    } catch (err) {
      const code = err instanceof SlackApiError ? err.code : 'unreachable';
      const message = isExpiredSessionCode(code) ? SIGNED_OUT_MESSAGE : UNREACHABLE_MESSAGE;
      this.writeMeta({ ...meta, lastCheckedAt: this.now(), lastErrorCode: code, lastError: message });
    }
    return this.changed();
  }

  /** A sync was rejected by Slack: remember it so the UI offers Reconnect (without another call). */
  markSignedOut(code: string): void {
    const meta = this.readMeta();
    if (!meta || !isExpiredSessionCode(code)) return;
    this.writeMeta({ ...meta, lastCheckedAt: this.now(), lastErrorCode: code, lastError: SIGNED_OUT_MESSAGE });
    this.changed();
  }

  /** Advanced: a pasted `d` cookie → the matching session token from the workspace page → save. */
  async connectWithCookie(req: CookieLoginRequest): Promise<SlackConnectionDTO> {
    const { domain } = normalizeWorkspace(req?.workspace ?? '');
    const cookie = normalizeCookie(req?.cookie ?? '');
    const { token } = await deriveTokenFromCookie({
      workspace: domain,
      cookie,
      fetch: this.fetchImpl,
      webOrigin: this.webOrigin,
    });
    return this.saveSession({ method: 'cookie', token, cookie });
  }

  /**
   * A captured web session (sign-in window or pasted cookie): auth.test, identity binding, encrypted
   * store, meta, 'connected'.
   */
  async saveSession(s: { method: AuthMethod; token: string; cookie: string }): Promise<SlackConnectionDTO> {
    if (!/^xox[a-z]-/.test(s.token ?? ''))
      throw new ConnectError('Slack didn’t finish signing you in. Please try again.');
    const cookie = normalizeCookie(s.cookie);
    let auth: AuthTestResponse;
    try {
      auth = await this.authTest(s.token, cookie);
    } catch (err) {
      if (err instanceof SlackApiError) {
        throw new ConnectError('Slack didn’t accept this sign-in. Please sign in again.', err.code);
      }
      throw new ConnectError(UNREACHABLE_MESSAGE, null);
    }
    if (!auth.team_id || !auth.user_id)
      throw new ConnectError('Slack didn’t say which workspace this is. Please try again.');
    this.assertSameOwner(auth);

    const creds: StoredCredentials = {
      method: s.method,
      token: s.token,
      cookie,
      teamId: auth.team_id,
      teamName: auth.team || auth.team_id,
      teamDomain: hostOf(auth.url) ?? '',
      userId: auth.user_id,
      userName: auth.user || auth.user_id,
      connectedAt: this.now(),
    };
    try {
      this.store.set(creds);
    } catch (err) {
      throw new ConnectError(`Couldn’t save the Slack sign-in: ${safeErrorMessage(err, [s.token, cookie])}`);
    }
    this.cached = creds;

    setMeta(this.db, 'team_id', creds.teamId);
    setMeta(this.db, 'team_name', creds.teamName);
    const sub = subdomainOf(auth.url);
    if (sub) setMeta(this.db, 'team_domain', sub);
    setMeta(this.db, 'self_user_id', creds.userId);
    this.writeMeta({
      method: creds.method,
      teamId: creds.teamId,
      teamName: creds.teamName,
      teamDomain: creds.teamDomain,
      userId: creds.userId,
      userName: creds.userName,
      connectedAt: creds.connectedAt,
      lastCheckedAt: creds.connectedAt,
      lastErrorCode: null,
      lastError: null,
    });
    const dto = this.status();
    this.emit('connected', dto);
    this.emit('changed', dto);
    return dto;
  }

  /** Forgets the saved session and the sign-in window's Slack session. The archive stays (§3.5). */
  async disconnect(): Promise<SlackConnectionDTO> {
    try {
      this.store.clear();
    } catch (err) {
      throw new ConnectError(`Couldn’t remove the saved Slack sign-in: ${safeErrorMessage(err)}`, null, 'internal');
    }
    this.cached = null;
    deleteMeta(this.db, CONNECTION_META_KEY);
    await this.clearBrowserSession().catch(() => undefined);
    const dto = this.status();
    this.emit('disconnected', dto);
    this.emit('changed', dto);
    return dto;
  }

  // ─── internals ──────────────────────────────────────────────────────────────────────────────

  /**
   * One archive = one person's view of one workspace (PLAN §5.7): signing in as someone else would
   * merge a second archive into this one.
   */
  private assertSameOwner(auth: AuthTestResponse): void {
    const knownTeam = getMeta(this.db, 'team_id');
    const knownSelf = getMeta(this.db, 'self_user_id');
    const otherTeam = knownTeam && auth.team_id && knownTeam !== auth.team_id;
    const otherUser = knownSelf && auth.user_id && knownSelf !== auth.user_id;
    if (!otherTeam && !otherUser) return;
    const owner = knownSelf
      ? (listUsers(this.db).find((u) => u.id === knownSelf)?.label ?? 'someone else')
      : 'someone else';
    const team = getMeta(this.db, 'team_name') ?? 'another workspace';
    throw new ConnectError(
      `This archive belongs to ${owner} at ${team}. To archive a different account, use a different archive folder.`,
      'wrong_account',
    );
  }

  private async authTest(token: string, cookie: string): Promise<AuthTestResponse> {
    const client = new SlackClient({
      token,
      cookie,
      baseUrl: this.apiBaseUrl,
      fetch: this.fetchImpl,
      throttle: false,
      maxAttempts: 2,
      maxRateLimitRetries: 1,
      requestTimeoutMs: 20_000,
    });
    return client.call<AuthTestResponse>('auth.test');
  }

  private changed(): SlackConnectionDTO {
    const dto = this.status();
    this.emit('changed', dto);
    return dto;
  }

  private readMeta(): ConnectionMeta | null {
    const raw = getMeta(this.db, CONNECTION_META_KEY);
    if (!raw) return null;
    try {
      const m = JSON.parse(raw) as Partial<ConnectionMeta>;
      if (!m || (m.method !== 'browser' && m.method !== 'cookie')) return null;
      return {
        method: m.method,
        teamId: String(m.teamId ?? ''),
        teamName: String(m.teamName ?? ''),
        teamDomain: String(m.teamDomain ?? ''),
        userId: String(m.userId ?? ''),
        userName: String(m.userName ?? ''),
        connectedAt: Number(m.connectedAt) || 0,
        lastCheckedAt: typeof m.lastCheckedAt === 'number' ? m.lastCheckedAt : null,
        lastErrorCode: typeof m.lastErrorCode === 'string' ? m.lastErrorCode : null,
        lastError: typeof m.lastError === 'string' ? m.lastError : null,
      };
    } catch {
      return null;
    }
  }

  private writeMeta(m: ConnectionMeta): void {
    setMeta(
      this.db,
      CONNECTION_META_KEY,
      JSON.stringify({ ...m, lastError: m.lastError ? redactSecrets(m.lastError) : null }),
    );
  }
}

export function disconnectedDTO(): SlackConnectionDTO {
  return {
    connected: false,
    method: null,
    teamId: null,
    teamName: null,
    teamDomain: null,
    userId: null,
    userName: null,
    connectedAt: null,
    lastCheckedAt: null,
    expired: false,
    error: null,
  };
}

/** `https://9h.slack.com/` → `9h.slack.com`. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** `https://9h.slack.com/` → `9h` (the form the sync stores in meta team_domain). */
function subdomainOf(url: string | undefined): string | null {
  const host = hostOf(url);
  return host && host.endsWith('.slack.com') ? host.split('.')[0] || null : null;
}
