/**
 * Electron main process: app lifecycle, the main window, the tray, and wiring the services to
 * IPC and to the operating system (sleep/wake, login items, dialogs, notifications).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import type { ArchiveEvent, ArchiveEvents } from '../shared/ipc';
import { eventChannel } from '../shared/ipc';
import type { AppInfoDTO } from '../shared/types';
import { clearSlackSession, createElectronSignInSurface } from './auth/electron-signin';
import { closeServices, createServices, wireServices, type AppServices, type PlatformHooks } from './context';
import { refreshSearchTextIfOutdated } from './db';
import { createHandlers } from './ipc';
import { settingsDTO } from './ipc/actions';
import { registerIpc } from './ipc/register';
import { applyLaunchAtLogin, wasOpenedAtLogin } from './login-item';
import { DATA_DIR_NAME, explicitDataDir, LEGACY_DATA_DIR_NAME, moveLegacyDataDir, type LegacyMove } from './paths';
import { ARCHIVE_SCHEME, serveArchiveFile } from './protocol';
import { denyPermissions, hardenWebContents, openExternalSafe } from './security';
import { createTray, IDLE_TRAY_STATE, type TrayController, type TrayState } from './tray';
import { createInstaller } from './update-install';

const isDev = !app.isPackaged;
const rendererDevUrl = isDev ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererFile = path.join(__dirname, '../renderer/index.html');
const USER_GUIDE_URL = 'https://github.com/romanbitca/sla-mem/blob/main/docs/INSTALL.md';

app.setName('sla-mem');
// Development runs keep their own data, far from a real archive in the same user account. An
// archive from before the app was renamed ("Slack Archive") moves to the new folder once.
const dataDirOverride = explicitDataDir(process.argv, process.env, process.cwd());
let legacyMove: LegacyMove = 'none';
if (dataDirOverride) {
  app.setPath('userData', dataDirOverride);
} else {
  const appData = app.getPath('appData');
  const kind = isDev ? 'development' : 'production';
  const target = path.join(appData, DATA_DIR_NAME[kind]);
  const legacy = path.join(appData, LEGACY_DATA_DIR_NAME[kind]);
  legacyMove = moveLegacyDataDir(legacy, target);
  // A folder that couldn't move is used where it is; while the old app runs, nothing is touched
  // (see the check before start below) and this run only needs a scratch folder.
  if (legacyMove === 'failed') app.setPath('userData', legacy);
  else if (legacyMove === 'in-use') app.setPath('userData', path.join(app.getPath('temp'), `sla-mem-${process.pid}`));
  else app.setPath('userData', target);
}
if (process.platform === 'win32') app.setAppUserModelId('com.9h.sla-mem');

// The development mock Slack (test/mock-slack) is only ever reachable from unpackaged builds.
const slackOverrides = isDev
  ? {
      apiBaseUrl: process.env.SLA_MEM_SLACK_API || undefined,
      webOrigin: process.env.SLA_MEM_SLACK_WEB || undefined,
    }
  : {};

// Must happen before `ready`: archive:// behaves like a normal, secure origin for <img>/<video>.
protocol.registerSchemesAsPrivileged([
  { scheme: ARCHIVE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: TrayController | null = null;
/** What the tray shows, kept so the icon can be turned off and on again in Settings. */
let trayState: TrayState = IDLE_TRAY_STATE;
let quitting = false;
/** Quitting for Update and restart: the new version is installed and opened as the app exits. */
let restartingForUpdate = false;
let syncBlocker: number | null = null;
let stopStatus: (() => void) | null = null;
let appLog: AppServices['log'] | null = null;

function isAppUrl(url: string): boolean {
  if (rendererDevUrl) return url.startsWith(rendererDevUrl);
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && path.resolve(decodeURIComponent(u.pathname)) === path.resolve(rendererFile);
  } catch {
    return false;
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frameUrl = event.senderFrame?.url ?? '';
  return (
    mainWindow != null && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && isAppUrl(frameUrl)
  );
}

function send<E extends ArchiveEvent>(event: E, payload: ArchiveEvents[E]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannel(event), payload);
}

// ─── window ─────────────────────────────────────────────────────────────────────────────────────

function createMainWindow(s: AppServices): BrowserWindow {
  const bounds = s.prefs.getInternal().windowBounds;
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'sla-mem',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161617' : '#fbfbfa',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  if (bounds?.maximized) win.maximize();
  hardenWebContents(win.webContents, isAppUrl);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed() && !startHidden) win.show();
  });
  if (rendererDevUrl) void win.loadURL(rendererDevUrl);
  else void win.loadURL(pathToFileURL(rendererFile).href);

  // Closing the window keeps the app (and its scheduled syncs) running in the tray (PLAN §8.3).
  win.on('close', (event) => {
    rememberBounds(s, win);
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (process.platform === 'win32' && tray && !s.prefs.getInternal().trayHintShown) {
      tray.showBalloonOnce(
        'sla-mem is still running',
        'It keeps archiving in the background. Use the tray icon to open it or quit.',
      );
      s.prefs.setInternal({ trayHintShown: true });
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  watchRenderer(s, win);
  return win;
}

/**
 * Window failures reach the log, so "Show logs" can explain a crash screen (PLAN §8.5): console
 * errors (React reports what its error boundary caught there), each logged once and at most 100
 * per window; and a renderer process that died, after which the window reloads (up to 3 times).
 */
function watchRenderer(s: AppServices, win: BrowserWindow): void {
  const seen = new Set<string>();
  let reloads = 0;
  win.webContents.on('console-message', (details) => {
    if (details.level !== 'error' || seen.size >= 100) return;
    const text = details.message.slice(0, 2_000);
    if (seen.has(text)) return;
    seen.add(text);
    s.log.warn(`Window error: ${text}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    s.log.error(`The window stopped (${details.reason}, exit code ${details.exitCode})`);
    if (details.reason === 'clean-exit' || win.isDestroyed() || reloads >= 3) return;
    reloads += 1;
    win.webContents.reload();
  });
}

function rememberBounds(s: AppServices, win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const { x, y, width, height } = win.getNormalBounds();
  s.prefs.setInternal({ windowBounds: { x, y, width, height, maximized: win.isMaximized() } });
}

let startHidden = false;

function showMainWindow(path?: string): void {
  if (!services) return;
  startHidden = false;
  if (process.platform === 'darwin') void app.dock?.show();
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow(services);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (path) {
    const target = path;
    const win = mainWindow;
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => send('navigate', { path: target }));
    else send('navigate', { path: target });
  }
}

// ─── platform hooks for the IPC handlers ────────────────────────────────────────────────────────

function platformHooks(s: AppServices): PlatformHooks {
  return {
    async chooseImportSource() {
      const parent = mainWindow ?? undefined;
      if (process.platform === 'darwin') {
        const r = await dialog.showOpenDialog(parent!, {
          title: 'Import a Slack export',
          message: 'Choose a Slack export folder or .zip file',
          properties: ['openFile', 'openDirectory'],
          filters: [{ name: 'Slack export', extensions: ['zip'] }],
        });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      }
      // Windows can't pick "a file or a folder" in one dialog.
      const choice = await dialog.showMessageBox(parent!, {
        type: 'question',
        message: 'Is your Slack export a .zip file or a folder?',
        buttons: ['A .zip file', 'A folder', 'Cancel'],
        cancelId: 2,
      });
      if (choice.response === 2) return null;
      const r = await dialog.showOpenDialog(parent!, {
        title: 'Import a Slack export',
        properties: [choice.response === 0 ? 'openFile' : 'openDirectory'],
        filters: choice.response === 0 ? [{ name: 'Slack export', extensions: ['zip'] }] : undefined,
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    async chooseBackupFolder() {
      const r = await dialog.showOpenDialog(mainWindow!, {
        title: 'Back up sla-mem',
        message: 'Choose where to save the backup',
        buttonLabel: 'Save backup here',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: app.getPath('documents'),
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    async chooseBackupFile() {
      const r = await dialog.showOpenDialog(mainWindow!, {
        title: 'Import a backup',
        message: 'Choose the sla-mem backup (.zip) made on your other computer',
        buttonLabel: 'Import',
        properties: ['openFile'],
        filters: [{ name: 'sla-mem backup', extensions: ['zip'] }],
        defaultPath: app.getPath('documents'),
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    async chooseExportFile(defaultName) {
      const r = await dialog.showSaveDialog(mainWindow!, {
        title: 'Export conversation',
        buttonLabel: 'Export',
        defaultPath: path.join(app.getPath('documents'), defaultName),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    async openPath(p) {
      const error = await shell.openPath(p);
      if (error) s.log.warn(`Could not open a path: ${error}`);
    },
    showItemInFolder: (p) => shell.showItemInFolder(p),
    openExternal: (url) => openExternalSafe(url),
    applyTheme: (theme) => {
      nativeTheme.themeSource = theme;
    },
    applyLaunchAtLogin,
    applyTrayIcon: (visible) => setTrayVisible(s, visible),
    appInfo: (): AppInfoDTO => ({
      version: app.getVersion(),
      platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
      arch: process.arch,
      isPackaged: app.isPackaged,
      dataDir: s.paths.dataDir,
      logsDir: s.paths.logsDir,
      installedProperly: process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder(),
    }),
    quitForUpdate: () => {
      restartingForUpdate = true;
      quitting = true;
      app.quit();
    },
  };
}

// ─── status → UI, tray, OS ──────────────────────────────────────────────────────────────────────

function throttle(fn: () => void, ms: number): { (): void; cancel(): void } {
  let timer: NodeJS.Timeout | null = null;
  let last = 0;
  const run = () => {
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, wait);
    }
  };
  return Object.assign(run, {
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  });
}

/** Returns a function that stops the updates, which read the database, before it is closed. */
function wireStatus(s: AppServices): () => void {
  let stopped = false;
  const pushStatus = throttle(() => {
    if (stopped) return;
    const status = s.runs.status();
    send('sync-status', status);
    const connection = s.connection.status();
    const { progress } = status;
    trayState = {
      syncing: status.running,
      // Signed out (or a sign-in that can't be read): Sync now would only fail; the line says why.
      connected: connection.connected && !connection.expired,
      lastSuccessAt: status.lastSuccessAt,
      problem: status.problem && status.problem.kind !== 'offline' ? shortProblem(status.problem.kind) : null,
      progress:
        status.running && progress?.current != null && progress.total != null
          ? { current: progress.current, total: progress.total }
          : null,
    };
    tray?.update(trayState);
  }, 400);

  s.runs.subscribe((event) => {
    if (stopped || event.type === 'log') return;
    pushStatus();
    if (event.type === 'started' && syncBlocker == null) syncBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (event.type === 'finished') {
      if (syncBlocker != null) powerSaveBlocker.stop(syncBlocker);
      syncBlocker = null;
      const problem = s.runs.status().problem;
      if (problem?.kind === 'signed_out' && (!mainWindow || !mainWindow.isVisible()))
        notify('Slack signed you out', 'Open sla-mem and click Reconnect to keep archiving.');
    }
  });
  s.connection.on('changed', () => {
    send('settings', settingsDTO(s));
    pushStatus();
  });
  s.prefs.on('changed', () => {
    send('settings', settingsDTO(s));
    pushStatus();
  });
  s.updates.on('changed', (info) => send('update', info));
  pushStatus();
  return () => {
    stopped = true;
    pushStatus.cancel();
  };
}

function shortProblem(kind: string): string {
  switch (kind) {
    case 'signed_out':
      return 'Slack signed you out';
    case 'disk_full':
      return 'Your disk is full';
    case 'wrong_account':
      return 'Signed in as a different account';
    default:
      return 'The last sync didn’t finish';
  }
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => showMainWindow('/settings'));
  n.show();
}

// ─── menus ──────────────────────────────────────────────────────────────────────────────────────

function buildMenu(s: AppServices): void {
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: 'sla-mem',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => showMainWindow('/settings') },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Sync now', accelerator: 'CmdOrCtrl+R', click: () => safeStartSync(s) },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(isDev
          ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[])
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'User guide', click: () => void openExternalSafe(USER_GUIDE_URL) },
        { label: 'Show logs', click: () => shell.showItemInFolder(s.log.file) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The menu bar / tray icon, per Settings. Without it the app keeps running in the background and
 * is reopened like any other app (the Dock, Applications or the Start menu).
 */
function setTrayVisible(s: AppServices, visible: boolean): void {
  if (visible && !tray) {
    tray = createTray(
      resourcesDir(),
      {
        open: () => showMainWindow(),
        syncNow: () => safeStartSync(s),
        settings: () => showMainWindow('/settings'),
        quit: () => {
          quitting = true;
          app.quit();
        },
      },
      trayState,
    );
  } else if (!visible && tray) {
    tray.destroy();
    tray = null;
    if (process.platform === 'darwin') void app.dock?.show();
  }
}

function safeStartSync(s: AppServices): void {
  try {
    s.runs.startSync();
  } catch (err) {
    s.log.info(`Sync not started: ${String(err)}`);
  }
}

// ─── first run checks ───────────────────────────────────────────────────────────────────────────

/** macOS: running straight from the disk image breaks updates and login items (PLAN §11 Stage 7). */
async function offerMoveToApplications(s: AppServices): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) return;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Move sla-mem to your Applications folder?',
    detail: 'It needs to live in Applications to start at login and to update properly.',
    buttons: ['Move to Applications', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  // Quitting while the question is open ends it with the default answer: that is not a "yes".
  if (response !== 0 || quitting) return;
  try {
    app.moveToApplicationsFolder();
  } catch (err) {
    s.log.warn(`Could not move to Applications: ${String(err)}`);
  }
}

// ─── lifecycle ──────────────────────────────────────────────────────────────────────────────────

function resourcesDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'tray') : path.join(app.getAppPath(), 'resources', 'tray');
}

async function start(): Promise<void> {
  const s = createServices({
    dataDir: app.getPath('userData'),
    echoLogs: isDev,
    cipher: safeStorage,
    createSignInSurface: () =>
      createElectronSignInSurface({
        webOrigin: slackOverrides.webOrigin ?? 'https://app.slack.com',
        log: services!.log,
        parent: mainWindow,
      }),
    clearBrowserSession: clearSlackSession,
    onLoginStatus: (status) => {
      send('login-status', status);
      if (status.state === 'connected' || status.state === 'error') showMainWindow();
    },
    apiBaseUrl: slackOverrides.apiBaseUrl,
    webOrigin: slackOverrides.webOrigin,
    version: app.getVersion(),
    installer: createInstaller({ platform: process.platform, execPath: process.execPath, isPackaged: app.isPackaged }),
  });
  services = s;
  appLog = s.log;
  s.log.info(`sla-mem ${app.getVersion()} starting (${process.platform} ${process.arch}), data in ${s.paths.dataDir}`);
  if (legacyMove === 'moved') s.log.info('Moved the archive here from its folder under the old name (Slack Archive)');
  if (legacyMove === 'failed')
    s.log.warn('Couldn’t move the archive from its folder under the old name; using it there');
  const interrupted = s.runs.init();
  if (interrupted) s.log.info(`Marked ${interrupted} interrupted run(s) from the last session`);
  void refreshSearchTextIfOutdated(s.db, { log: (line) => s.log.info(line) }).catch((err: unknown) =>
    s.log.error('Updating search text failed', err),
  );

  nativeTheme.themeSource = s.prefs.get().theme;
  denyPermissions(session.defaultSession);
  session.defaultSession.protocol.handle(ARCHIVE_SCHEME, (request) =>
    serveArchiveFile(request, { db: s.db, filesDir: s.paths.filesDir }),
  );
  const hooks = platformHooks(s);
  registerIpc({ handlers: createHandlers(s, hooks), isTrustedSender, log: s.log });
  wireServices(s, hooks);
  buildMenu(s);
  app.setAboutPanelOptions({
    applicationName: 'sla-mem',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 Roman Bitca',
  });

  setTrayVisible(s, s.prefs.get().showTrayIcon);
  stopStatus = wireStatus(s);

  // Keep the login item in step with the preference (it may have been changed by the OS or a reinstall).
  const prefs = s.prefs.get();
  if (prefs.onboardingComplete) applyLaunchAtLogin(prefs.launchAtLogin);

  startHidden = prefs.onboardingComplete && wasOpenedAtLogin();
  mainWindow = createMainWindow(s);
  // Started at login: just the menu bar icon. Without the icon, the Dock icon stays as the way in.
  if (startHidden && process.platform === 'darwin' && prefs.showTrayIcon) app.dock?.hide();

  s.connection.checkSavedSignIn();
  s.scheduler.start();
  s.updates.start();
  powerMonitor.on('resume', () => {
    s.log.info('Computer woke up');
    s.scheduler.wake();
  });
  void offerMoveToApplications(s);
}

// One running copy per archive: two would fight over the database.
// Logged rather than shown: Electron's default is a technical dialog that blocks the app, and
// quitting, until someone clicks it.
process.on('uncaughtException', (err) => {
  if (appLog) appLog.error('Unexpected error', err);
  else console.error(err);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (process.platform === 'darwin') void app.dock?.show();
    showMainWindow();
  });

  void app.whenReady().then(() => {
    if (legacyMove === 'in-use') {
      dialog.showErrorBox(
        'Quit Slack Archive first',
        'sla-mem is the new name of Slack Archive. Quit the old app (its menu bar icon → Quit), then open ' +
          'sla-mem again: your archive moves over by itself.',
      );
      app.exit(0);
      return;
    }
    return start().catch((err: unknown) => {
      services?.log.error('Startup failed', err);
      dialog.showErrorBox(
        'sla-mem couldn’t start',
        `Something went wrong while opening the archive.\n\n${String(err)}`,
      );
      app.exit(1);
    });
  });

  app.on('activate', () => {
    if (services) showMainWindow();
  });

  // Closing the last window keeps the app in the tray on every platform; Quit really quits.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('will-quit', (event) => {
    const s = services;
    if (!s) return;
    services = null;
    event.preventDefault();
    stopStatus?.();
    stopStatus = null;
    tray?.destroy();
    s.log.info(restartingForUpdate ? 'Quitting to install an update' : 'Quitting');
    void closeServices(s).finally(() => {
      if (restartingForUpdate) installUpdateOnExit(s);
      app.exit(0);
    });
  });
}

/**
 * Hands over to the updater, which replaces the app once this process has exited and opens the
 * new version (with the same archive folder). If it can't start, this version reopens instead:
 * clicking Update and restart never leaves the app closed.
 */
function installUpdateOnExit(s: AppServices): void {
  const started = s.updates.applyPrepared({
    pid: process.pid,
    args: dataDirOverride ? [`--data-dir=${dataDirOverride}`] : [],
    logFile: s.log.file,
  });
  if (!started) app.relaunch();
}
