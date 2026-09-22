/**
 * The IPC contract: every call the renderer can make into the main process, and every event main
 * pushes to the renderer. The preload script exposes exactly these (see src/preload/index.ts);
 * main registers one handler per method (src/main/ipc).
 *
 * Calls resolve to an `IpcResult` envelope instead of rejecting, so the renderer gets a stable
 * error `code` (Electron flattens thrown errors into "Error invoking remote method…" strings).
 */
import type {
  AiEventDTO,
  AppInfoDTO,
  AskAiRequest,
  BackupResultDTO,
  ExportResultDTO,
  DeletedArchiveDTO,
  CleanupResultDTO,
  ConversationDTO,
  CookieLoginRequest,
  LoginStatusDTO,
  MessageRevisionDTO,
  MessagesPage,
  MessagesQuery,
  OkDTO,
  PreferencesPatch,
  SearchParams,
  SearchResponse,
  SettingsDTO,
  SlackConnectionDTO,
  StartLoginRequest,
  StartRunResponse,
  StatsDTO,
  StorageDTO,
  SyncStatusDTO,
  ThreadDTO,
  UpdateInfoDTO,
  UserDTO,
  WorkspaceDTO,
} from './types';

/** Request → response for each method. `void` requests take no argument. */
export interface ArchiveApi {
  // Archive (read-only)
  getWorkspace(): WorkspaceDTO;
  getStats(): StatsDTO;
  getUsers(): UserDTO[];
  getConversations(): ConversationDTO[];
  getConversation(req: { id: string }): ConversationDTO;
  getMessages(req: MessagesQuery): MessagesPage;
  getThread(req: { conversationId: string; threadTs: string }): ThreadDTO;
  getRevisions(req: { conversationId: string; ts: string }): MessageRevisionDTO[];
  search(req: SearchParams): SearchResponse;
  getEmoji(): Record<string, string>;

  // Sync
  getSyncStatus(): SyncStatusDTO;
  startSync(): StartRunResponse;
  cancelSync(): OkDTO;
  /** Opens a folder/zip picker, then imports that Slack export. Null when the picker was cancelled. */
  importExport(): StartRunResponse | null;
  /** Makes a failed/skipped attachment eligible again and downloads pending files. */
  retryFile(req: { fileId: string }): StartRunResponse | null;

  // Slack connection
  startLogin(req: StartLoginRequest): LoginStatusDTO;
  getLoginStatus(): LoginStatusDTO;
  chooseLoginTeam(req: { teamId: string }): LoginStatusDTO;
  cancelLogin(): LoginStatusDTO;
  connectWithCookie(req: CookieLoginRequest): SlackConnectionDTO;
  testConnection(): SlackConnectionDTO;
  disconnect(): SlackConnectionDTO;

  // Settings
  getSettings(): SettingsDTO;
  updatePreferences(req: PreferencesPatch): SettingsDTO;
  completeOnboarding(req: { launchAtLogin: boolean }): SettingsDTO;

  // Storage and backup
  getStorage(): StorageDTO;
  deleteAttachmentsOlderThan(req: { months: number }): CleanupResultDTO;
  /** Opens a folder picker, then writes a zip of the archive there. Null when cancelled. */
  backupNow(): BackupResultDTO | null;
  /**
   * Moving from another computer: opens a file picker for a backup zip and merges it into this
   * archive as an import run. Null when cancelled.
   */
  importBackup(): { runId: number } | null;
  /** Opens a save dialog, then writes the conversation as Markdown there. Null when cancelled. */
  exportConversation(req: { conversationId: string }): ExportResultDTO | null;
  /** Fetches the people and conversation lists from Slack (no history) and returns the list. */
  refreshConversationList(): ConversationDTO[];
  /**
   * Deletes what is archived for a conversation that is excluded from archiving (its messages,
   * edit history and the attachments no other conversation shares).
   */
  deleteConversationArchive(req: { conversationId: string }): DeletedArchiveDTO;
  showDataFolder(): OkDTO;
  showLogs(): OkDTO;

  // Attachments
  openFile(req: { fileId: string }): OkDTO;
  revealFile(req: { fileId: string }): OkDTO;

  // Ask AI (Claude, with the reader's own Anthropic API key)
  /** Checks the key with Anthropic (no tokens used), then saves it encrypted. */
  saveAiKey(req: { key: string }): SettingsDTO;
  removeAiKey(): SettingsDTO;
  /** Starts answering; the answer arrives as `ai` events. One question at a time per chat. */
  askAi(req: AskAiRequest): OkDTO;
  /** Stops the answer being written in that chat; what arrived so far stays. */
  stopAi(req: { chatId: string }): OkDTO;
  /** New chat: forgets this one. Chats are only ever kept in memory. */
  endAiChat(req: { chatId: string }): OkDTO;

  // App
  getAppInfo(): AppInfoDTO;
  openExternal(req: { url: string }): OkDTO;
  getUpdateInfo(): UpdateInfoDTO;
  checkForUpdates(): UpdateInfoDTO;
  openUpdateDownload(): OkDTO;
  /**
   * Update and restart: downloads the new version, then quits, replaces the app and opens the new
   * one (after a sync or import that's under way). Progress arrives as `update` events.
   */
  installUpdate(): UpdateInfoDTO;
}

export type ApiMethod = keyof ArchiveApi;
export type ApiRequest<M extends ApiMethod> = Parameters<ArchiveApi[M]> extends [infer R] ? R : void;
export type ApiResponse<M extends ApiMethod> = ReturnType<ArchiveApi[M]>;

/** Every method, for the preload whitelist and main's handler registration. */
export const API_METHODS = [
  'getWorkspace',
  'getStats',
  'getUsers',
  'getConversations',
  'getConversation',
  'getMessages',
  'getThread',
  'getRevisions',
  'search',
  'getEmoji',
  'getSyncStatus',
  'startSync',
  'cancelSync',
  'importExport',
  'retryFile',
  'startLogin',
  'getLoginStatus',
  'chooseLoginTeam',
  'cancelLogin',
  'connectWithCookie',
  'testConnection',
  'disconnect',
  'getSettings',
  'updatePreferences',
  'completeOnboarding',
  'getStorage',
  'deleteAttachmentsOlderThan',
  'backupNow',
  'importBackup',
  'exportConversation',
  'refreshConversationList',
  'deleteConversationArchive',
  'showDataFolder',
  'showLogs',
  'openFile',
  'revealFile',
  'saveAiKey',
  'removeAiKey',
  'askAi',
  'stopAi',
  'endAiChat',
  'getAppInfo',
  'openExternal',
  'getUpdateInfo',
  'checkForUpdates',
  'openUpdateDownload',
  'installUpdate',
] as const satisfies readonly ApiMethod[];

// Compile-time check that API_METHODS lists every method exactly: a missing one fails here.
type Missing = Exclude<ApiMethod, (typeof API_METHODS)[number]>;
const _allMethodsListed: [Missing] extends [never] ? true : Missing = true;
void _allMethodsListed;

export const IPC_CHANNEL_PREFIX = 'archive:';
export const channelFor = (method: ApiMethod): string => `${IPC_CHANNEL_PREFIX}${method}`;

/**
 * Error categories the renderer can act on:
 *  - invalid: bad input (message says what to fix)
 *  - not_found: the conversation/file doesn't exist
 *  - conflict: something is already running (a sync, a sign-in)
 *  - blocked: can't do that right now (not connected, shutting down)
 *  - signed_out: Slack rejected the saved session
 *  - internal: unexpected; the message is safe to show but generic
 */
export type IpcErrorCode = 'invalid' | 'not_found' | 'conflict' | 'blocked' | 'signed_out' | 'internal';

export interface IpcError {
  code: IpcErrorCode;
  /** Plain-language, redacted message. */
  message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

/** Events main pushes to the renderer. */
export interface ArchiveEvents {
  /** Sync status changed (run started/finished, progress, schedule). Throttled. */
  'sync-status': SyncStatusDTO;
  /** Slack sign-in progressed. */
  'login-status': LoginStatusDTO;
  /** Preferences or the connection changed. */
  settings: SettingsDTO;
  /** A newer release was found, or installing it moved on (download progress, restarting). */
  update: UpdateInfoDTO;
  /** Main asks the UI to show a route (tray menu "Settings", notification clicks). */
  navigate: { path: string };
  /** Ask AI: an answer being written (steps, text, sources, then done or error). */
  ai: AiEventDTO;
}

export type ArchiveEvent = keyof ArchiveEvents;

export const ARCHIVE_EVENTS = [
  'sync-status',
  'login-status',
  'settings',
  'update',
  'navigate',
  'ai',
] as const satisfies readonly ArchiveEvent[];

export const eventChannel = (event: ArchiveEvent): string => `${IPC_CHANNEL_PREFIX}event:${event}`;

/** What the preload exposes as `window.archive`. */
export interface ArchiveBridge {
  call<M extends ApiMethod>(
    method: M,
    ...args: ApiRequest<M> extends void ? [] : [ApiRequest<M>]
  ): Promise<IpcResult<ApiResponse<M>>>;
  on<E extends ArchiveEvent>(event: E, listener: (payload: ArchiveEvents[E]) => void): () => void;
  platform: 'darwin' | 'win32' | 'linux';
}
