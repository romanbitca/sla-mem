/**
 * Errors that cross the IPC boundary. Handlers throw `AppError`s with a plain-language message;
 * anything else is logged and replaced by a generic message, so stack traces, error codes and
 * secrets never reach the UI (PLAN §8.5).
 */
import type { IpcError, IpcErrorCode } from '../shared/ipc';
import { redactSecrets } from './redact';

export class AppError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(redactSecrets(message));
    this.name = 'AppError';
    this.code = code;
  }
}

export const invalid = (message: string) => new AppError('invalid', message);
export const notFound = (message: string) => new AppError('not_found', message);
export const conflict = (message: string) => new AppError('conflict', message);
export const blocked = (message: string) => new AppError('blocked', message);

export const GENERIC_ERROR_MESSAGE = 'Something went wrong. Nothing was lost — please try again.';

/** Anything thrown by a handler → what the renderer may see. */
export function toIpcError(err: unknown): IpcError {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  const code = (err as { ipcCode?: unknown })?.ipcCode;
  if (typeof code === 'string' && err instanceof Error) {
    return { code: code as IpcErrorCode, message: redactSecrets(err.message) };
  }
  return { code: 'internal', message: GENERIC_ERROR_MESSAGE };
}

/** Node's errno for "no space left on device" (and Windows' equivalents surfaced by libuv). */
export function isDiskFullError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return true;
  const message = err instanceof Error ? err.message : '';
  return /SQLITE_FULL|database or disk is full/i.test(message);
}
