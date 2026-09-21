/**
 * The only bridge between the renderer and Node/Electron. It exposes `window.archive` with a
 * whitelisted `call` (one IPC channel per method in the contract) and `on` for pushed events.
 * The renderer never gets ipcRenderer itself, Node APIs, or any Slack secret.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { API_METHODS, ARCHIVE_EVENTS, channelFor, eventChannel, type ArchiveBridge } from '../shared/ipc';

const methods = new Set<string>(API_METHODS);
const events = new Set<string>(ARCHIVE_EVENTS);

const bridge: ArchiveBridge = {
  call(method, ...args) {
    if (!methods.has(method)) return Promise.reject(new Error(`Unknown method: ${String(method)}`));
    return ipcRenderer.invoke(channelFor(method), ...args);
  },
  on(event, listener) {
    if (!events.has(event)) throw new Error(`Unknown event: ${String(event)}`);
    const channel = eventChannel(event);
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
};

contextBridge.exposeInMainWorld('archive', bridge);
