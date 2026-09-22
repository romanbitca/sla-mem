/**
 * IPC handlers for everything except the read-only archive calls: sync, the Slack connection,
 * settings, storage and backups, attachments, and app/update information.
 */
import type { SettingsDTO } from '../../shared/types';
import { backupArchive } from '../backup';
import type { AppServices, PlatformHooks } from '../context';
import fs from 'node:fs';
import path from 'node:path';
import { deleteConversationData, getConversation, listConversations, requeueFile } from '../db';
import { exportConversationMarkdown, exportFileName } from '../export';
import { blocked, conflict, invalid, notFound } from '../errors';
import { isRunnableFile, localAttachmentPath } from '../file-actions';
import { isSafeExternalUrl } from '../security-urls';
import { deleteAttachmentsOlderThan, storageInfo } from '../storage';
import { record, slackId, string } from '../validate';
import type { Handlers } from './register';

type ActionHandlers = Omit<
  Handlers,
  | 'getWorkspace'
  | 'getStats'
  | 'getUsers'
  | 'getConversations'
  | 'getConversation'
  | 'getMessages'
  | 'getThread'
  | 'getRevisions'
  | 'search'
  | 'getEmoji'
>;

export function settingsDTO(s: AppServices): SettingsDTO {
  return { preferences: s.prefs.get(), connection: s.connection.status() };
}

export function actionHandlers(s: AppServices, hooks: PlatformHooks): ActionHandlers {
  const ok = { ok: true } as const;
  return {
    // ─── sync ──────────────────────────────────────────────────────────────────────────────────
    getSyncStatus: () => s.runs.status(),
    startSync: () => ({ runId: s.runs.startSync() }),
    cancelSync: () => {
      s.runs.cancel();
      return ok;
    },
    importExport: async () => {
      const source = await hooks.chooseImportSource();
      return source ? { runId: s.runs.startImport(source) } : null;
    },
    retryFile: (req) => {
      const fileId = slackId(record(req).fileId, 'file');
      if (!requeueFile(s.db, fileId)) throw notFound('That attachment can’t be retried.');
      if (s.runs.isRunning() || s.runs.blockedReason()) return null; // picked up by the next run
      return { runId: s.runs.startFileDownloads() };
    },

    // ─── Slack connection ──────────────────────────────────────────────────────────────────────
    startLogin: (req) => s.login.start({ workspace: optionalWorkspace(req) }),
    getLoginStatus: () => s.login.status(),
    chooseLoginTeam: (req) => s.login.choose(slackId(record(req).teamId, 'workspace')),
    cancelLogin: () => s.login.cancel(),
    connectWithCookie: (req) => {
      const r = record(req);
      return s.connection.connectWithCookie({
        workspace: string(r.workspace, 'workspace', 200),
        cookie: string(r.cookie, 'cookie', 4_000),
      });
    },
    testConnection: () => s.connection.test(),
    disconnect: async () => {
      s.login.cancel();
      return s.connection.disconnect();
    },

    // ─── settings ──────────────────────────────────────────────────────────────────────────────
    getSettings: () => settingsDTO(s),
    updatePreferences: (req) => {
      s.prefs.update(req);
      return settingsDTO(s);
    },
    completeOnboarding: (req) => {
      const launchAtLogin = record(req).launchAtLogin;
      if (typeof launchAtLogin !== 'boolean') throw invalid('Invalid “start at login” value');
      s.prefs.completeOnboarding(launchAtLogin);
      return settingsDTO(s);
    },

    // ─── storage and backup ────────────────────────────────────────────────────────────────────
    getStorage: () => storageInfo(s.db, s.paths),
    deleteAttachmentsOlderThan: (req) => {
      const months = record(req).months;
      if (typeof months !== 'number' || !Number.isInteger(months) || months < 1 || months > 120) {
        throw invalid('Choose how many months of attachments to keep');
      }
      return deleteAttachmentsOlderThan(s.db, s.paths.filesDir, months);
    },
    backupNow: async () => {
      const dest = await hooks.chooseBackupFolder();
      if (!dest) return null;
      const result = await backupArchive({ db: s.db, paths: s.paths, destDir: dest });
      s.log.info(`Backup written (${result.bytes} bytes)`);
      hooks.showItemInFolder(result.path);
      return result;
    },
    importBackup: async () => {
      const file = await hooks.chooseBackupFile();
      return file ? { runId: s.runs.startImport(file) } : null;
    },
    exportConversation: async (req) => {
      const id = slackId(record(req).conversationId, 'conversation');
      const conversation = getConversation(s.db, id);
      if (!conversation) throw notFound('That conversation isn’t in the archive');
      const file = await hooks.chooseExportFile(exportFileName(conversation));
      if (!file) return null;
      const result = await exportConversationMarkdown(s.db, id, file);
      s.log.info(`Exported a conversation (${result.messages} messages)`);
      hooks.showItemInFolder(result.path);
      return result;
    },
    refreshConversationList: async () => {
      await s.runs.refreshLists();
      return listConversations(s.db);
    },
    deleteConversationArchive: async (req) => {
      const id = slackId(record(req).conversationId, 'conversation');
      if (!s.prefs.get().excludedConversationIds.includes(id)) {
        throw invalid('Choose not to archive this conversation first.');
      }
      if (s.runs.isRunning()) throw conflict('Slamem is busy syncing. Try again when it has finished.');
      const removed = deleteConversationData(s.db, id);
      for (const fileId of removed.fileIds) {
        // Stored ids are Slack's (F…); anything else is never turned into a path.
        if (/^[A-Za-z0-9_-]+$/.test(fileId)) {
          await fs.promises.rm(path.join(s.paths.filesDir, fileId), { recursive: true, force: true });
        }
      }
      s.log.info(
        `Deleted the archive of a conversation not to archive: ${removed.messages} messages, ${removed.fileIds.length} attachments`,
      );
      return { messages: removed.messages, files: removed.fileIds.length };
    },
    showDataFolder: async () => {
      await hooks.openPath(s.paths.dataDir);
      return ok;
    },
    showLogs: () => {
      hooks.showItemInFolder(s.log.file);
      return ok;
    },

    // ─── attachments ───────────────────────────────────────────────────────────────────────────
    openFile: async (req) => {
      const abs = localAttachmentPath(s.db, s.paths.filesDir, slackId(record(req).fileId, 'file'));
      // Programs and scripts are revealed, never launched from the archive (PLAN §3.6).
      if (isRunnableFile(abs)) hooks.showItemInFolder(abs);
      else await hooks.openPath(abs);
      return ok;
    },
    revealFile: (req) => {
      hooks.showItemInFolder(localAttachmentPath(s.db, s.paths.filesDir, slackId(record(req).fileId, 'file')));
      return ok;
    },

    // ─── app and updates ───────────────────────────────────────────────────────────────────────
    getAppInfo: () => hooks.appInfo(),
    openExternal: async (req) => {
      const url = string(record(req).url, 'link', 8_000);
      if (!isSafeExternalUrl(url)) throw invalid('Only web and email links can be opened.');
      await hooks.openExternal(url);
      return ok;
    },
    getUpdateInfo: () => s.updates.info(),
    checkForUpdates: () => s.updates.check(),
    openUpdateDownload: async () => {
      const info = s.updates.info();
      const url = info.downloadUrl ?? info.releaseUrl;
      if (!info.available || !url) throw blocked('There’s no update to download.');
      await hooks.openExternal(url);
      return ok;
    },
    installUpdate: () => s.updates.installUpdate(),
  };
}

function optionalWorkspace(req: unknown): string | undefined {
  if (req == null) return undefined;
  const value = record(req).workspace;
  return value == null || value === '' ? undefined : string(value, 'workspace', 200);
}
