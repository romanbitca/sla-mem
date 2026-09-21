/**
 * All IPC handlers, assembled from one module per domain. The `Handlers` type makes a missing
 * method a compile error.
 */
import type { AppContext } from '../context';
import { blocked } from '../errors';
import { archiveHandlers } from './archive';
import type { Handlers } from './register';

const notYet = (): never => {
  throw blocked('This isn’t available yet.');
};

export function createHandlers(ctx: AppContext): Handlers {
  return {
    ...archiveHandlers({ db: ctx.db, paths: ctx.paths, isConnected: () => false }),
    getSyncStatus: notYet,
    startSync: notYet,
    cancelSync: notYet,
    importExport: notYet,
    retryFile: notYet,
    startLogin: notYet,
    getLoginStatus: notYet,
    chooseLoginTeam: notYet,
    cancelLogin: notYet,
    connectWithCookie: notYet,
    testConnection: notYet,
    disconnect: notYet,
    getSettings: notYet,
    updatePreferences: notYet,
    completeOnboarding: notYet,
    getStorage: notYet,
    deleteAttachmentsOlderThan: notYet,
    backupNow: notYet,
    showDataFolder: notYet,
    showLogs: notYet,
    openFile: notYet,
    revealFile: notYet,
    getAppInfo: notYet,
    openExternal: notYet,
    getUpdateInfo: notYet,
    checkForUpdates: notYet,
    openUpdateDownload: notYet,
  };
}
