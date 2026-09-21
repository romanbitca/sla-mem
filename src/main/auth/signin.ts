/**
 * "Connect Slack": opens Slack's own sign-in page in an app window, waits for the user to sign in
 * (email code, Google, SSO…), captures the web session (`d` cookie + xoxc token), verifies and saves
 * it through ConnectionService, then closes the window (PLAN §2.3).
 *
 * Completion is detected by polling for the credentials, never by watching URLs: sign-in redirects
 * through SSO providers and several Slack hosts. The token normally comes from the web client's
 * `localStorage.localConfig_v2`; when the flow ends somewhere else (e.g. a "launch the desktop app"
 * page) the window is nudged to the web client, and as a last resort the token is derived from the
 * cookie over HTTP (§2.2).
 *
 * The window itself is behind `SignInSurface` so this state machine is tested without Electron.
 */
import type { LoginState, LoginStatusDTO, SlackConnectionDTO, StartLoginRequest } from '../../shared/types';
import { conflict } from '../errors';
import { safeErrorMessage } from '../redact';
import type { ConnectionService } from './connection';
import { ConnectError, isExpiredSessionCode } from './errors';
import { isDefaultWebOrigin, isSlackHost, resolveWebOrigin } from './origin';
import { deriveTokenFromCookie, normalizeWorkspace } from './session-token';

export interface SignInSurface {
  /** Creates the Slack window and loads `url`. */
  open(url: string): void;
  navigate(url: string): void;
  close(): void;
  isOpen(): boolean;
  currentUrl(): string | null;
  /** The `d` session cookie of the Slack web session, or null before sign-in. */
  getSessionCookie(): Promise<string | null>;
  /** `localStorage.localConfig_v2` when the window shows the Slack web client, else null. */
  readLocalConfig(): Promise<string | null>;
  /** Called once if the user closes the window. */
  onClosed(listener: () => void): void;
  /** Workspace hosts (e.g. "9h.slack.com") the window visited, most recent first. */
  visitedWorkspaceHosts(): string[];
}

export interface LocalTeam {
  id: string;
  name: string;
  /** Host, e.g. "9h.slack.com". */
  domain: string;
  token: string;
}

export interface LoginManagerOptions {
  connection: Pick<ConnectionService, 'saveSession'>;
  createSurface: () => SignInSurface;
  /** Default https://app.slack.com. */
  webOrigin?: string;
  /** For deriving the token from the cookie (fallback). */
  fetch?: typeof fetch;
  /** Credential polling interval (PLAN §2.3: ~1.5 s). */
  pollMs?: number;
  /** Give up after this long without finishing (PLAN §2.3: ~10 min). */
  timeoutMs?: number;
  /** After the cookie appears, wait this long for the web client before nudging the window to it. */
  nudgeAfterMs?: number;
  /** After the cookie appears, wait this long for localConfig before deriving the token over HTTP. */
  deriveAfterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onStatus?: (status: LoginStatusDTO) => void;
  onConnected?: (connection: SlackConnectionDTO) => void;
  log?: (line: string) => void;
}

const ACTIVE: ReadonlySet<LoginState> = new Set(['opening', 'waiting', 'choose_team', 'verifying']);

const MESSAGES: Record<LoginState, string> = {
  idle: 'Not started',
  opening: 'Opening Slack…',
  waiting: 'Sign in to Slack in the window that opened.',
  choose_team: 'You’re signed in to several workspaces. Choose the one to archive.',
  verifying: 'Checking your Slack sign-in…',
  connected: 'Connected.',
  error: 'Signing in didn’t work.',
  cancelled: 'The Slack window was closed before signing in finished.',
};

interface Attempt {
  id: number;
  surface: SignInSurface;
  hint: string | null;
  startedAt: number;
  ended: boolean;
  /** `d` cookie values Slack already rejected (a stale session left in the window's storage). */
  rejected: Set<string>;
  cookieSeenAt: number | null;
  cookie: string | null;
  nudged: boolean;
  derived: boolean;
  verifying: boolean;
  teams: LocalTeam[];
}

export class LoginManager {
  private readonly opts: LoginManagerOptions;
  private readonly webOrigin: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly nudgeAfterMs: number;
  private readonly deriveAfterMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private state: LoginState = 'idle';
  private message = MESSAGES.idle;
  private error: string | null = null;
  private startedAt: number | null = null;
  private connection: SlackConnectionDTO | null = null;
  private attempt: Attempt | null = null;
  private nextId = 1;

  constructor(opts: LoginManagerOptions) {
    this.opts = opts;
    this.webOrigin = resolveWebOrigin(opts.webOrigin);
    this.pollMs = opts.pollMs ?? 1500;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.nudgeAfterMs = opts.nudgeAfterMs ?? 6_000;
    this.deriveAfterMs = opts.deriveAfterMs ?? 20_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  status(): LoginStatusDTO {
    return {
      state: this.state,
      message: this.message,
      startedAt: this.startedAt,
      error: this.error,
      teams:
        this.state === 'choose_team'
          ? (this.attempt?.teams ?? []).map(({ id, name, domain }) => ({ id, name, domain }))
          : [],
      connection: this.state === 'connected' ? this.connection : null,
    };
  }

  isActive(): boolean {
    return ACTIVE.has(this.state);
  }

  /** Opens the Slack window. A sign-in already in progress is brought forward, not restarted. */
  start(req: StartLoginRequest = {}): LoginStatusDTO {
    if (this.isActive()) throw conflict('Slack sign-in is already open.');
    const hint = req.workspace?.trim() ? normalizeWorkspace(req.workspace).domain : null;
    const surface = this.opts.createSurface();
    const attempt: Attempt = {
      id: this.nextId++,
      surface,
      hint,
      startedAt: this.now(),
      ended: false,
      rejected: new Set(),
      cookieSeenAt: null,
      cookie: null,
      nudged: false,
      derived: false,
      verifying: false,
      teams: [],
    };
    this.attempt = attempt;
    this.startedAt = attempt.startedAt;
    this.connection = null;
    this.set('opening');
    surface.onClosed(() => this.onWindowClosed(attempt));
    surface.open(this.startUrl(hint));
    this.set('waiting');
    void this.poll(attempt);
    return this.status();
  }

  /** The user picked a workspace from several. */
  choose(teamId: string): LoginStatusDTO {
    const attempt = this.attempt;
    if (!attempt || this.state !== 'choose_team') throw conflict('There’s no workspace to choose right now.');
    const team = attempt.teams.find((t) => t.id === teamId);
    if (!team || !attempt.cookie) throw conflict('That workspace isn’t available. Please sign in again.');
    void this.verify(attempt, team, attempt.cookie);
    return this.status();
  }

  cancel(): LoginStatusDTO {
    const attempt = this.attempt;
    if (attempt && this.isActive()) this.end(attempt, 'cancelled', null, 'Signing in was cancelled.');
    return this.status();
  }

  // ─── the flow ───────────────────────────────────────────────────────────────────────────────

  private startUrl(hint: string | null): string {
    if (!isDefaultWebOrigin(this.webOrigin)) return `${this.webOrigin}/${hint ? '' : 'signin'}`;
    return hint ? `https://${hint}/` : `${this.webOrigin}/signin`;
  }

  private async poll(attempt: Attempt): Promise<void> {
    while (!attempt.ended) {
      await this.sleep(this.pollMs);
      if (attempt.ended) return;
      if (this.now() - attempt.startedAt > this.timeoutMs) {
        this.end(attempt, 'error', 'Signing in took too long. Please try again.');
        return;
      }
      if (attempt.verifying || this.state === 'choose_team') continue;
      try {
        await this.checkCredentials(attempt);
      } catch (err) {
        this.opts.log?.(`Sign-in check failed: ${safeErrorMessage(err)}`);
      }
    }
  }

  private async checkCredentials(attempt: Attempt): Promise<void> {
    const cookie = await attempt.surface.getSessionCookie();
    if (attempt.ended || !cookie || attempt.rejected.has(cookie)) return;
    if (cookie !== attempt.cookie) {
      attempt.cookie = cookie;
      attempt.cookieSeenAt = this.now();
      attempt.nudged = false;
      attempt.derived = false;
    }
    const teams = parseLocalConfig(await attempt.surface.readLocalConfig());
    if (attempt.ended) return;
    const candidates = attempt.hint ? teams.filter((t) => t.domain === attempt.hint) : teams;
    if (candidates.length === 1) return this.verify(attempt, candidates[0], cookie);
    if (candidates.length > 1) {
      attempt.teams = candidates;
      this.set('choose_team');
      return;
    }
    const waited = this.now() - (attempt.cookieSeenAt ?? this.now());
    if (!attempt.nudged && waited >= this.nudgeAfterMs && !this.onWebClient(attempt.surface)) {
      // Signed in, but the flow ended outside the web client (e.g. "open the Slack app"): the web
      // client is where the session token is written.
      attempt.nudged = true;
      attempt.surface.navigate(`${this.webOrigin}/client/`);
      return;
    }
    if (!attempt.derived && waited >= this.deriveAfterMs) {
      attempt.derived = true;
      await this.deriveFromCookie(attempt, cookie);
    }
  }

  private onWebClient(surface: SignInSurface): boolean {
    const url = surface.currentUrl();
    try {
      return url != null && new URL(url).origin === this.webOrigin;
    } catch {
      return false;
    }
  }

  /** PLAN §2.2 fallback: the workspace's boot page, fetched with the cookie, carries the token. */
  private async deriveFromCookie(attempt: Attempt, cookie: string): Promise<void> {
    const host = attempt.hint ?? attempt.surface.visitedWorkspaceHosts()[0];
    if (!host) return;
    try {
      const { token, teamId } = await deriveTokenFromCookie({
        workspace: host,
        cookie,
        fetch: this.opts.fetch,
        webOrigin: this.webOrigin,
      });
      if (attempt.ended) return;
      await this.verify(attempt, { id: teamId ?? '', name: host, domain: host, token }, cookie);
    } catch (err) {
      if (err instanceof ConnectError && isExpiredSessionCode(err.slackCode)) attempt.rejected.add(cookie);
      this.opts.log?.(`Sign-in: couldn’t derive the session from the cookie: ${safeErrorMessage(err, [cookie])}`);
    }
  }

  private async verify(attempt: Attempt, team: LocalTeam, cookie: string): Promise<void> {
    attempt.verifying = true;
    this.set('verifying');
    try {
      const connection = await this.opts.connection.saveSession({ method: 'browser', token: team.token, cookie });
      if (attempt.ended) return;
      this.connection = connection;
      const who = [connection.userName, connection.teamName].filter(Boolean);
      this.end(attempt, 'connected', null, who.length === 2 ? `Connected to ${who[1]} as ${who[0]}.` : 'Connected.');
      this.opts.onConnected?.(connection);
    } catch (err) {
      if (attempt.ended) return;
      attempt.verifying = false;
      const slackCode = err instanceof ConnectError ? err.slackCode : null;
      if (isExpiredSessionCode(slackCode)) {
        // An old session left in the window: wait for the user to sign in again.
        attempt.rejected.add(cookie);
        attempt.cookie = null;
        this.set('waiting', 'That Slack session has ended. Please sign in again in the Slack window.');
        return;
      }
      const message =
        err instanceof ConnectError ? err.message : `Something went wrong while saving the sign-in. Please try again.`;
      this.end(attempt, 'error', message);
    }
  }

  private onWindowClosed(attempt: Attempt): void {
    // Closing the window after we have the session (while verifying) doesn't matter.
    if (attempt.ended || attempt.verifying) return;
    this.end(attempt, 'cancelled', null);
  }

  private end(attempt: Attempt, state: LoginState, error: string | null, message?: string): void {
    if (attempt.ended) return;
    attempt.ended = true;
    try {
      if (attempt.surface.isOpen()) attempt.surface.close();
    } catch {
      // already gone
    }
    this.error = error;
    this.set(state, message ?? error ?? undefined);
  }

  private set(state: LoginState, message?: string): void {
    this.state = state;
    this.message = message ?? MESSAGES[state];
    // Terminal states get their error from end(); every step of an attempt clears the last one.
    if (ACTIVE.has(state)) this.error = null;
    this.opts.onStatus?.(this.status());
  }
}

/**
 * Teams in the Slack web client's `localConfig_v2`: `{ teams: { T123: { id, name, domain, token } } }`,
 * one entry per signed-in workspace. Only entries with a web session token count.
 */
export function parseLocalConfig(raw: string | null): LocalTeam[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const teams = (parsed as { teams?: unknown })?.teams;
  if (!teams || typeof teams !== 'object') return [];
  const out: LocalTeam[] = [];
  for (const [key, value] of Object.entries(teams as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const t = value as Record<string, unknown>;
    const token = typeof t.token === 'string' ? t.token : '';
    if (!/^xoxc-/.test(token)) continue;
    const domain = typeof t.domain === 'string' ? t.domain.toLowerCase() : '';
    out.push({
      id: typeof t.id === 'string' ? t.id : key,
      name: typeof t.name === 'string' && t.name ? t.name : domain || key,
      domain: domain ? (domain.includes('.') ? domain : `${domain}.slack.com`) : '',
      token,
    });
  }
  return out;
}

/** Workspace hosts worth deriving a token from: `9h.slack.com`, not app/api/www. */
export function isWorkspaceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!isSlackHost(host) || host === 'slack.com') return false;
  const sub = host.slice(0, -'.slack.com'.length).split('.')[0];
  return ![
    'app',
    'api',
    'www',
    'files',
    'status',
    'edgeapi',
    'slack-files',
    'downloads',
    'my',
    'a',
    'ca',
    'emoji',
  ].includes(sub);
}
