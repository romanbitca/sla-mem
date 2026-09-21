/**
 * Registers one ipcMain handler per contract method. Each call:
 *  - is accepted only from the app's own renderer (defence in depth: the Slack sign-in window has
 *    no preload, but a stray frame must never reach the archive);
 *  - resolves to an IpcResult envelope, never rejects, so the renderer gets a stable error code;
 *  - logs unexpected errors (redacted) and returns a generic message instead of a stack trace.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  API_METHODS,
  channelFor,
  type ApiMethod,
  type ApiRequest,
  type ApiResponse,
  type IpcResult,
} from '../../shared/ipc';
import { AppError, toIpcError } from '../errors';
import type { Logger } from '../logger';

export type Handlers = {
  [M in ApiMethod]: (req: ApiRequest<M>) => ApiResponse<M> | Promise<ApiResponse<M>>;
};

export interface RegisterOptions {
  handlers: Handlers;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
  log: Logger;
}

export function registerIpc(opts: RegisterOptions): () => void {
  for (const method of API_METHODS) {
    ipcMain.handle(channelFor(method), (event, arg: unknown) => invoke(opts, method, event, arg));
  }
  return () => {
    for (const method of API_METHODS) ipcMain.removeHandler(channelFor(method));
  };
}

export async function invoke(
  opts: Pick<RegisterOptions, 'handlers' | 'isTrustedSender' | 'log'>,
  method: ApiMethod,
  event: IpcMainInvokeEvent,
  arg: unknown,
): Promise<IpcResult<unknown>> {
  if (!opts.isTrustedSender(event)) {
    opts.log.warn(`Refused IPC ${method} from an untrusted frame`);
    return { ok: false, error: { code: 'blocked', message: 'Not allowed' } };
  }
  try {
    const handler = opts.handlers[method] as (req: unknown) => unknown;
    return { ok: true, value: await handler(arg) };
  } catch (err) {
    if (!(err instanceof AppError)) opts.log.error(`IPC ${method} failed`, err);
    return { ok: false, error: toIpcError(err) };
  }
}
