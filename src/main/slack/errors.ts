import type { SlackApiResponse } from './types';

/** A Slack Web API response with `ok: false`. `code` is Slack's error string (e.g. `not_in_channel`). */
export class SlackApiError extends Error {
  readonly code: string;
  readonly method: string;
  /** Scope Slack says is missing (for `missing_scope`). */
  readonly needed?: string;

  constructor(method: string, response: Pick<SlackApiResponse, 'error' | 'needed'>, message?: string) {
    const code = response.error || 'unknown_error';
    const scope = response.needed ? ` (needs scope ${response.needed})` : '';
    super(message ?? `Slack ${method} failed: ${code}${scope}`);
    this.name = 'SlackApiError';
    this.code = code;
    this.method = method;
    this.needed = response.needed;
  }
}

/**
 * The request never produced a usable Slack response (network failure, 5xx, invalid JSON) even
 * after retries. Usually means Slack is unreachable, so the sync aborts instead of failing every
 * remaining conversation one slow retry cycle at a time.
 */
export class SlackHttpError extends Error {
  readonly method: string;
  readonly status: number | null;

  constructor(method: string, status: number | null, detail: string) {
    super(`Slack ${method} failed: ${detail}`);
    this.name = 'SlackHttpError';
    this.method = method;
    this.status = status;
  }
}

export type DownloadFailureKind =
  /** Content-Length or streamed bytes exceeded the limit. */
  | 'too_large'
  /** Got an HTML page (usually Slack's login page) where a file was expected. */
  | 'html'
  /** Non-success HTTP status. */
  | 'http'
  /** URL is not on a Slack host (we never send the token, or fetch at all, elsewhere). */
  | 'untrusted_url'
  /** Connection failed or stalled after retries. */
  | 'network';

export class DownloadError extends Error {
  readonly kind: DownloadFailureKind;
  readonly status: number | null;
  /** Server-requested wait before retrying (HTTP 429 Retry-After). */
  readonly retryAfterMs: number | null;

  constructor(
    kind: DownloadFailureKind,
    message: string,
    status: number | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'DownloadError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  /** Transient failures worth another attempt: connection problems, throttling and 5xx. */
  get retryable(): boolean {
    if (this.kind === 'network') return true;
    return this.kind === 'http' && this.status != null && (this.status === 429 || this.status >= 500);
  }
}

/** Slack answers meaning the saved session itself is unusable: nothing else in the run can succeed. */
const FATAL_AUTH_MESSAGES: Record<string, string> = {
  invalid_auth: 'Slack signed you out (invalid_auth). Reconnect to keep archiving.',
  not_authed: 'Slack did not accept the saved sign-in (not_authed). Reconnect to keep archiving.',
  token_revoked: 'Slack signed you out (token_revoked). Reconnect to keep archiving.',
  token_expired: 'Slack signed you out (token_expired). Reconnect to keep archiving.',
  account_inactive: 'This Slack account has been deactivated (account_inactive).',
};

export const AUTH_FAILURE_CODES: ReadonlySet<string> = new Set(Object.keys(FATAL_AUTH_MESSAGES));

export function isFatalAuthError(err: unknown): err is SlackApiError {
  return err instanceof SlackApiError && err.code in FATAL_AUTH_MESSAGES;
}

/** Re-wraps a fatal auth error with an actionable message; the code stays the same. */
export function toFatalAuthError(err: SlackApiError): SlackApiError {
  return new SlackApiError(err.method, { error: err.code }, FATAL_AUTH_MESSAGES[err.code] ?? err.message);
}

/**
 * The credentials belong to a different workspace or person than the archive (PLAN §5.7). Syncing
 * would merge two people's data into one database, so the run refuses.
 */
export class WrongAccountError extends Error {
  readonly code = 'wrong_account';

  constructor(message: string) {
    super(message);
    this.name = 'WrongAccountError';
  }
}
