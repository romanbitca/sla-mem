/**
 * The main process's service graph, built once at startup, and the wiring between services
 * (connecting starts the first sync, a looser attachment setting fetches files, preferences apply
 * their side effects…). Everything Electron-specific arrives through `PlatformHooks` and the
 * sign-in surface factory, so the whole graph can be built in tests with a temporary folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppInfoDTO, AttachmentPolicy, LoginStatusDTO, PreferencesDTO, ThemePreference } from '../shared/types';
import {
  ConnectionService,
  LoginManager,
  SafeStorageCredentialStore,
  type SecretCipher,
  type SignInSurface,
} from './auth';
import { openDb, type DB } from './db';
import { createLogger, type Logger } from './logger';
import { archivePaths, type ArchivePaths } from './paths';
import { Preferences } from './preferences';
import { RunManager, type RunJobs } from './runs';
import { Scheduler } from './scheduler';
import type { UpdateInstaller } from './update-install';
import { restartWhenIdle, UpdateService } from './update-service';

/** The GitHub repository whose releases the update check reads ("owner/repo", PLAN §9.5). */
export const UPDATE_REPO = 'romanbitca/sla-mem';

/** Actions that need Electron (dialogs, shell, theme, login items), injected by main/index.ts. */
export interface PlatformHooks {
  /** Native picker for a Slack export folder or .zip; null when cancelled. */
  chooseImportSource(): Promise<string | null>;
  /** Native folder picker for "Back up now"; null when cancelled. */
  chooseBackupFolder(): Promise<string | null>;
  /** Native file picker for a backup zip ("Import a backup"); null when cancelled. */
  chooseBackupFile(): Promise<string | null>;
  /** Native save dialog for "Export conversation", starting at `defaultName`; null when cancelled. */
  chooseExportFile(defaultName: string): Promise<string | null>;
  /** Opens a file with its default app (never used for runnable files). */
  openPath(p: string): Promise<void>;
  showItemInFolder(p: string): void;
  openExternal(url: string): Promise<boolean>;
  applyTheme(theme: ThemePreference): void;
  applyLaunchAtLogin(enabled: boolean): void;
  /** Shows or removes the menu bar / tray icon. */
  applyTrayIcon(visible: boolean): void;
  appInfo(): AppInfoDTO;
  /** Quits so the downloaded update is installed (UpdateService.applyPrepared), then reopens. */
  quitForUpdate(): void;
}

export interface AppContext {
  paths: ArchivePaths;
  log: Logger;
  prefs: Preferences;
  db: DB;
}

export interface AppServices extends AppContext {
  connection: ConnectionService;
  login: LoginManager;
  runs: RunManager;
  scheduler: Scheduler;
  updates: UpdateService;
}

export interface ServicesOptions {
  dataDir: string;
  echoLogs?: boolean;
  cipher: SecretCipher;
  createSignInSurface: () => SignInSurface;
  clearBrowserSession: () => Promise<void>;
  onLoginStatus?: (status: LoginStatusDTO) => void;
  /** Development / test overrides for the mock Slack (never honoured by packaged builds). */
  apiBaseUrl?: string;
  webOrigin?: string;
  fetch?: typeof fetch;
  jobs?: Partial<RunJobs>;
  version: string;
  /** Update and restart; null or absent where updates are downloaded by hand. */
  installer?: UpdateInstaller | null;
}

export function createContext(opts: { dataDir: string; echoLogs?: boolean }): AppContext {
  const paths = archivePaths(opts.dataDir);
  for (const dir of [paths.dataDir, paths.filesDir, paths.logsDir, paths.tmpDir])
    fs.mkdirSync(dir, { recursive: true });
  const log = createLogger({ dir: paths.logsDir, echo: opts.echoLogs });
  const prefs = new Preferences(paths.configPath);
  const db = openDb(paths.dbPath);
  return { paths, log, prefs, db };
}

export function createServices(opts: ServicesOptions): AppServices {
  const ctx = createContext(opts);
  const connection = new ConnectionService({
    db: ctx.db,
    store: new SafeStorageCredentialStore(ctx.paths.credentialsPath, opts.cipher),
    apiBaseUrl: opts.apiBaseUrl,
    webOrigin: opts.webOrigin,
    fetch: opts.fetch,
    clearBrowserSession: opts.clearBrowserSession,
  });
  const login = new LoginManager({
    connection,
    createSurface: opts.createSignInSurface,
    webOrigin: opts.webOrigin,
    fetch: opts.fetch,
    onStatus: opts.onLoginStatus,
    log: (line) => ctx.log.info(line),
  });
  const runs = new RunManager({
    db: ctx.db,
    filesDir: ctx.paths.filesDir,
    tmpDir: ctx.paths.tmpDir,
    prefs: ctx.prefs,
    connection,
    // Moving computers keeps the choice of what not to archive.
    onExcludedConversations: (ids) =>
      ctx.prefs.update({
        excludedConversationIds: [...new Set([...ctx.prefs.get().excludedConversationIds, ...ids])],
      }),
    apiBaseUrl: opts.apiBaseUrl,
    jobs: opts.jobs,
    log: (line) => ctx.log.info(line),
  });
  const scheduler = new Scheduler({ runs, settings: ctx.prefs, connection, log: (line) => ctx.log.info(line) });
  const updates = new UpdateService({
    repo: UPDATE_REPO,
    currentVersion: opts.version,
    platform: process.platform,
    arch: process.arch,
    fetch: opts.fetch,
    log: (line) => ctx.log.info(line),
    installer: opts.installer ?? null,
    workDir: path.join(ctx.paths.tmpDir, 'update'),
  });
  return { ...ctx, connection, login, runs, scheduler, updates };
}

/** Policy order, from strictest to loosest: loosening it may make skipped files eligible. */
const POLICY_RANK: Record<AttachmentPolicy, number> = { none: 0, standard: 1, everything: 2 };

/**
 * Cross-service behaviour. Returns a function that removes the listeners.
 *  - Connecting Slack starts a sync right away, except during onboarding, which first asks what
 *    to archive (PLAN §8.1 screen 3) and then starts the first sync itself.
 *  - Disconnecting stops a running Slack sync (its session is gone).
 *  - Preferences apply their side effects: theme, login item, and a looser attachment setting
 *    downloads the newly allowed files now rather than at the next scheduled sync.
 *  - A downloaded update restarts the app once no run is under way.
 */
export function wireServices(
  s: AppServices,
  hooks: Pick<PlatformHooks, 'applyTheme' | 'applyLaunchAtLogin' | 'applyTrayIcon' | 'quitForUpdate'>,
): () => void {
  let prefs: PreferencesDTO = s.prefs.get();
  const onConnected = () => {
    if (s.runs.isRunning()) return;
    // Onboarding first asks what to archive, then starts the first sync itself.
    if (!s.prefs.get().onboardingComplete) {
      s.log.info('Connected to Slack: waiting for the choice of what to archive');
      return;
    }
    try {
      s.runs.startSync();
      s.log.info('Connected to Slack: started the first sync');
    } catch (err) {
      s.log.warn(`Connected to Slack, but the sync did not start: ${String(err)}`);
    }
  };
  const onDisconnected = () => {
    const kind = s.runs.activeKind();
    if (kind === 'sync' || kind === 'files') s.runs.cancel();
  };
  const onPrefs = (next: PreferencesDTO) => {
    const before = prefs;
    prefs = next;
    if (next.theme !== before.theme) hooks.applyTheme(next.theme);
    if (next.showTrayIcon !== before.showTrayIcon) hooks.applyTrayIcon(next.showTrayIcon);
    if (next.launchAtLogin !== before.launchAtLogin || next.onboardingComplete !== before.onboardingComplete) {
      hooks.applyLaunchAtLogin(next.onboardingComplete && next.launchAtLogin);
    }
    if (
      POLICY_RANK[next.attachmentPolicy] > POLICY_RANK[before.attachmentPolicy] &&
      !s.runs.isRunning() &&
      !s.runs.blockedReason()
    ) {
      try {
        s.runs.startFileDownloads();
      } catch (err) {
        s.log.warn(`Attachment downloads did not start: ${String(err)}`);
      }
    }
  };
  const onUpdateReady = () => {
    void restartWhenIdle({ runs: s.runs, scheduler: s.scheduler, updates: s.updates, quit: hooks.quitForUpdate });
  };
  s.connection.on('connected', onConnected);
  s.connection.on('disconnected', onDisconnected);
  s.prefs.on('changed', onPrefs);
  s.updates.on('ready', onUpdateReady);
  return () => {
    s.connection.off('connected', onConnected);
    s.connection.off('disconnected', onDisconnected);
    s.prefs.off('changed', onPrefs);
    s.updates.off('ready', onUpdateReady);
  };
}

export async function closeServices(s: AppServices): Promise<void> {
  s.scheduler.stop();
  s.updates.stop();
  s.login.cancel();
  await s.runs.shutdown(5_000);
  closeContext(s);
}

export function closeContext(ctx: AppContext): void {
  try {
    ctx.db.pragma('optimize');
  } catch {
    // best effort
  }
  ctx.db.close();
}
