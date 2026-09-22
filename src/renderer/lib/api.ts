/**
 * Typed client for the main process, over the preload bridge (`window.archive.call`). Every
 * request and response shape comes from src/shared (the IPC contract). Main answers with an
 * `IpcResult` envelope instead of rejecting; this module unwraps it and turns failures into
 * `ApiError`s that carry a stable `code`, so the UI can tell "not found" from "a sync is already
 * running" without parsing messages.
 */
import type { ApiMethod, ApiRequest, ApiResponse, IpcErrorCode, IpcResult } from '../../shared/ipc';
import type {
  AskAiRequest,
  CookieLoginRequest,
  MessagesQuery,
  PreferencesPatch,
  SearchParams,
  StartLoginRequest,
} from '../../shared/types';
import { getBridge } from './bridge';

export class ApiError extends Error {
  readonly code: IpcErrorCode;
  /** The contract method that failed, for logs and tests (never shown to people). */
  readonly method: ApiMethod | null;

  constructor(code: IpcErrorCode, message: string, opts: { method?: ApiMethod; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'ApiError';
    this.code = code;
    this.method = opts.method ?? null;
  }

  get isNotFound(): boolean {
    return this.code === 'not_found';
  }

  /** Something is already running: a sync or import, or a Slack sign-in. */
  get isConflict(): boolean {
    return this.code === 'conflict';
  }

  get isSignedOut(): boolean {
    return this.code === 'signed_out';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export const isConflict = (error: unknown): boolean => isApiError(error) && error.code === 'conflict';
export const isNotFound = (error: unknown): boolean => isApiError(error) && error.code === 'not_found';
export const isSignedOut = (error: unknown): boolean => isApiError(error) && error.code === 'signed_out';
export const isBlocked = (error: unknown): boolean => isApiError(error) && error.code === 'blocked';

// ---------------------------------------------------------------------------------------------
// Plain-language errors (PLAN §8.5)

export const GENERIC_ERROR = 'Something went wrong. Nothing was lost — please try again.';

/** What to say when main's message is missing or unusable. */
const DEFAULT_MESSAGES: Record<IpcErrorCode, string> = {
  invalid: 'That didn’t work. Please check what you entered and try again.',
  not_found: 'That isn’t in the archive.',
  conflict: 'That’s already in progress. Please wait for it to finish.',
  blocked: 'That isn’t possible right now.',
  signed_out: 'Slack signed you out. Reconnect to keep archiving.',
  internal: GENERIC_ERROR,
};

// Main already speaks plain language; these are a safety net so nothing technical ever reaches
// the reader: session secrets and API keys, the words token/cookie, error codes (`invalid_auth`,
// `SQLITE_BUSY`, `net::ERR_…`, `ENOSPC`), HTTP statuses, exception names and stack traces.
const SECRET = /xox[a-z]-|sk-ant-[A-Za-z0-9_-]{8}/i;
const TOKEN_WORDS = /\b(?:tokens?|xox[a-z]?)\b/i;
const COOKIE_WORDS = /\bcookies?\b/i;
/** `invalid_auth`, `Invalid_Auth`, `SQLITE_BUSY`, but not a channel name like `#dev_ops`. */
const CODE_WORD = /(?<![#@\w])[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/;
const ERRNO = /\bE[A-Z]{3,}\b/;
const TECHNICAL = new RegExp(
  [
    String.raw`\n\s*at\s`, // stack frames
    String.raw`Error invoking remote method`,
    String.raw`\bnet::`,
    String.raw`\bfetch failed\b`,
    String.raw`\bsocket hang up\b`,
    String.raw`\bgetaddrinfo\b`,
    String.raw`\bHTTP\b`,
    // "status 500", "Slack returned 429 …", "Request failed: 503 …"
    String.raw`\b(?:status|code|returned|responded|request failed)\b\D{0,12}\b[1-5]\d{2}\b`,
    String.raw`\bof (?:undefined|null)\b`,
    String.raw`\bis not (?:a function|defined)\b`,
  ].join('|'),
  'i',
);
/** Case matters here: "TypeError:" and HTTP reason phrases, not the same words in a sentence. */
const TECHNICAL_EXACT =
  /\b(?:[A-Z][a-z]+)*Error:|\b(?:Too Many Requests|Service Unavailable|Bad Gateway|Internal Server Error|Gateway Time-?out)\b/;

function isPresentable(message: string, allowCookie: boolean): boolean {
  if (!message.trim() || message.length > 400) return false;
  if (SECRET.test(message) || TOKEN_WORDS.test(message)) return false;
  if (!allowCookie && COOKIE_WORDS.test(message)) return false;
  return ![CODE_WORD, ERRNO, TECHNICAL, TECHNICAL_EXACT].some((re) => re.test(message));
}

export interface DescribeOptions {
  /**
   * The Advanced "paste your session cookie" form is the one place that may say "cookie"
   * (PLAN §8.5); everywhere else such a message is replaced by a plain default.
   */
  allowCookie?: boolean;
}

/** A message from main (sign-in steps, file reasons) if it's fit to show, else `fallback`. */
export function presentableMessage(
  message: string | null | undefined,
  fallback: string,
  opts: DescribeOptions = {},
): string {
  return message && isPresentable(message, opts.allowCookie ?? false) ? message : fallback;
}

/** A sentence to show for a failed action or load. Never codes, statuses or stack traces. */
export function describeError(error: unknown, opts: DescribeOptions = {}): string {
  if (isApiError(error)) {
    return isPresentable(error.message, opts.allowCookie ?? false) ? error.message : DEFAULT_MESSAGES[error.code];
  }
  // Anything else is a bug on our side; its message would only confuse.
  return GENERIC_ERROR;
}

// ---------------------------------------------------------------------------------------------
// Transport

const NO_BRIDGE_MESSAGE = 'Slamem didn’t start properly. Quit it and open it again.';

type CallArgs<M extends ApiMethod> = ApiRequest<M> extends void ? [] : [ApiRequest<M>];

function isResult(value: unknown): value is IpcResult<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean';
}

/** One contract call: unwraps the envelope, or throws an `ApiError`. */
async function call<M extends ApiMethod>(method: M, ...args: CallArgs<M>): Promise<ApiResponse<M>> {
  const bridge = getBridge();
  if (!bridge) throw new ApiError('internal', NO_BRIDGE_MESSAGE, { method });
  let result: unknown;
  try {
    result = await bridge.call(method, ...args);
  } catch (cause) {
    // Main never rejects for handled errors, so this is "no handler" or a broken bridge.
    throw new ApiError('internal', GENERIC_ERROR, { method, cause });
  }
  if (!isResult(result)) throw new ApiError('internal', GENERIC_ERROR, { method });
  if (result.ok) return result.value as ApiResponse<M>;
  const { code, message } = (result.error ?? {}) as { code?: unknown; message?: unknown };
  const known = typeof code === 'string' && Object.hasOwn(DEFAULT_MESSAGES, code);
  throw new ApiError(known ? (code as IpcErrorCode) : 'internal', typeof message === 'string' ? message : '', {
    method,
  });
}

/** The part of `MessagesQuery` that picks a window; the conversation is its own argument. */
export type MessagesWindow = Omit<MessagesQuery, 'conversationId'>;

/**
 * Every contract method, as one object so tests can `vi.spyOn(api, 'getMessages')` and
 * components share a single import. Reads accept an `AbortSignal` so react-query's
 * `queryFn: ({ signal }) => …` stays idiomatic, but IPC calls can't be aborted: it's ignored.
 * Conversation-scoped reads take positional ids (like the paths they used to be); everything
 * else takes the contract's request object.
 */
export const api = {
  // Archive (read-only)
  getWorkspace: (_signal?: AbortSignal) => call('getWorkspace'),
  getStats: (_signal?: AbortSignal) => call('getStats'),
  getUsers: (_signal?: AbortSignal) => call('getUsers'),
  getConversations: (_signal?: AbortSignal) => call('getConversations'),
  getConversation: (id: string, _signal?: AbortSignal) => call('getConversation', { id }),
  getMessages: (conversationId: string, query: MessagesWindow = {}, _signal?: AbortSignal) =>
    call('getMessages', { conversationId, ...query }),
  getThread: (conversationId: string, threadTs: string, _signal?: AbortSignal) =>
    call('getThread', { conversationId, threadTs }),
  getRevisions: (conversationId: string, ts: string, _signal?: AbortSignal) =>
    call('getRevisions', { conversationId, ts }),
  search: (params: SearchParams, _signal?: AbortSignal) => call('search', params),
  getEmoji: (_signal?: AbortSignal) => call('getEmoji'),

  // Sync
  getSyncStatus: (_signal?: AbortSignal) => call('getSyncStatus'),
  startSync: () => call('startSync'),
  cancelSync: () => call('cancelSync'),
  /** Main shows a folder/zip picker; null when it was cancelled. */
  importExport: () => call('importExport'),
  retryFile: (req: { fileId: string }) => call('retryFile', req),

  // Slack connection
  startLogin: (req: StartLoginRequest = {}) => call('startLogin', req),
  getLoginStatus: (_signal?: AbortSignal) => call('getLoginStatus'),
  chooseLoginTeam: (req: { teamId: string }) => call('chooseLoginTeam', req),
  cancelLogin: () => call('cancelLogin'),
  connectWithCookie: (req: CookieLoginRequest) => call('connectWithCookie', req),
  testConnection: () => call('testConnection'),
  disconnect: () => call('disconnect'),

  // Settings
  getSettings: (_signal?: AbortSignal) => call('getSettings'),
  updatePreferences: (req: PreferencesPatch) => call('updatePreferences', req),
  completeOnboarding: (req: { launchAtLogin: boolean }) => call('completeOnboarding', req),

  // Storage and backup
  getStorage: (_signal?: AbortSignal) => call('getStorage'),
  deleteAttachmentsOlderThan: (req: { months: number }) => call('deleteAttachmentsOlderThan', req),
  /** Main shows a folder picker; null when it was cancelled. */
  backupNow: () => call('backupNow'),
  importBackup: () => call('importBackup'),
  exportConversation: (req: { conversationId: string }) => call('exportConversation', req),
  refreshConversationList: () => call('refreshConversationList'),
  deleteConversationArchive: (req: { conversationId: string }) => call('deleteConversationArchive', req),
  showDataFolder: () => call('showDataFolder'),
  showLogs: () => call('showLogs'),

  // Attachments
  openFile: (req: { fileId: string }) => call('openFile', req),
  revealFile: (req: { fileId: string }) => call('revealFile', req),

  // Ask AI
  saveAiKey: (req: { key: string }) => call('saveAiKey', req),
  removeAiKey: () => call('removeAiKey'),
  askAi: (req: AskAiRequest) => call('askAi', req),
  stopAi: (req: { chatId: string }) => call('stopAi', req),
  endAiChat: (req: { chatId: string }) => call('endAiChat', req),

  // App
  getAppInfo: (_signal?: AbortSignal) => call('getAppInfo'),
  openExternal: (req: { url: string }) => call('openExternal', req),
  getUpdateInfo: (_signal?: AbortSignal) => call('getUpdateInfo'),
  checkForUpdates: () => call('checkForUpdates'),
  openUpdateDownload: () => call('openUpdateDownload'),
  installUpdate: () => call('installUpdate'),
} satisfies { [M in ApiMethod]: (...args: never[]) => Promise<ApiResponse<M>> };

export type Api = typeof api;
