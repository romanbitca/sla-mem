import type { IpcErrorCode } from '../../shared/ipc';
import { AppError } from '../errors';

/**
 * A connect/verify attempt failed. The message is user-facing and redacted (AppError redacts), so
 * no token or cookie can leak through it. `slackCode` keeps Slack's error (e.g. `invalid_auth`).
 */
export class ConnectError extends AppError {
  readonly slackCode: string | null;

  constructor(message: string, slackCode: string | null = null, code: IpcErrorCode = 'invalid') {
    super(code, message);
    this.name = 'ConnectError';
    this.slackCode = slackCode;
  }
}

/** Slack error codes meaning the session itself is unusable (signed out, revoked, deactivated). */
export const EXPIRED_SESSION_CODES: ReadonlySet<string> = new Set([
  'invalid_auth',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'not_authed',
]);

export function isExpiredSessionCode(code: string | null | undefined): boolean {
  return !!code && EXPIRED_SESSION_CODES.has(code);
}
