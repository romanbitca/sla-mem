/**
 * Electron main process: app lifecycle, the main window, and wiring the services to IPC.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, nativeTheme, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { closeContext, createContext, type AppContext } from './context';
import { createHandlers } from './ipc';
import { registerIpc } from './ipc/register';
import { explicitDataDir } from './paths';
import { ARCHIVE_SCHEME, serveArchiveFile } from './protocol';
import { denyPermissions, hardenWebContents } from './security';

const isDev = !app.isPackaged;
const rendererDevUrl = isDev ? process.env.ELECTRON_RENDERER_URL : undefined;
const rendererFile = path.join(__dirname, '../renderer/index.html');

// Development runs keep their own data, far from a real archive in the same user account.
const dataDirOverride = explicitDataDir(process.argv, process.env, process.cwd());
if (dataDirOverride) app.setPath('userData', dataDirOverride);
else if (isDev) app.setPath('userData', path.join(app.getPath('appData'), `${app.getName()} (dev)`));

// Must happen before `ready`: archive:// behaves like a normal, secure origin for <img>/<video>.
protocol.registerSchemesAsPrivileged([
  { scheme: ARCHIVE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let ctx: AppContext | null = null;
let mainWindow: BrowserWindow | null = null;

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
  return mainWindow != null && event.sender === mainWindow.webContents && isAppUrl(frameUrl);
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Slack Archive',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1d21' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  hardenWebContents(win.webContents, isAppUrl);
  win.once('ready-to-show', () => win.show());
  if (rendererDevUrl) void win.loadURL(rendererDevUrl);
  else void win.loadURL(pathToFileURL(rendererFile).href);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// One running copy per archive: two would fight over the database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  void app.whenReady().then(() => {
    ctx = createContext({ dataDir: app.getPath('userData'), echoLogs: isDev });
    ctx.log.info(
      `Slack Archive ${app.getVersion()} starting (${process.platform} ${process.arch}), data in ${ctx.paths.dataDir}`,
    );
    nativeTheme.themeSource = ctx.prefs.get().theme;
    denyPermissions(session.defaultSession);
    const context = ctx;
    session.defaultSession.protocol.handle(ARCHIVE_SCHEME, (request) =>
      serveArchiveFile(request, { db: context.db, filesDir: context.paths.filesDir }),
    );
    registerIpc({ handlers: createHandlers(context), isTrustedSender, log: context.log });
    showMainWindow();
    app.on('activate', () => showMainWindow());
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    if (ctx) {
      ctx.log.info('Quitting');
      closeContext(ctx);
      ctx = null;
    }
  });
}
