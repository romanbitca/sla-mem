/**
 * All IPC handlers, assembled from one module per domain. The `Handlers` type makes a missing
 * method a compile error.
 */
import type { AppServices, PlatformHooks } from '../context';
import { actionHandlers } from './actions';
import { archiveHandlers } from './archive';
import type { Handlers } from './register';

export function createHandlers(s: AppServices, hooks: PlatformHooks): Handlers {
  return {
    ...archiveHandlers({ db: s.db, paths: s.paths, isConnected: () => s.connection.hasCredentials() }),
    ...actionHandlers(s, hooks),
  };
}
