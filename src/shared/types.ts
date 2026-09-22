/**
 * Data shapes shared by the main process and the renderer: every IPC request and response uses
 * these (see ./ipc.ts for the method list). Change them only in lockstep on both sides.
 *
 * Conventions:
 *  - Slack timestamps (`ts`) are strings like "1712345678.123456" and identify a message within a
 *    conversation. Convert to JS time with `Math.round(parseFloat(ts) * 1000)`.
 *  - `text` fields are raw Slack mrkdwn (entities `&lt; &gt; &amp;` still escaped, `<@U123>` refs
 *    intact). The renderer parses them into React nodes; main never produces HTML.
 *  - Times that are not Slack ts (run start/finish, connection times) are epoch milliseconds.
 *  - Secrets (the Slack token and session cookie, the Anthropic API key) never appear in any of
 *    these shapes, except the key once on its way in (`saveAiKey`).
 */

// ─── Directory ────────────────────────────────────────────────────────────────────────────────

export type ConversationType = 'channel' | 'private_channel' | 'im' | 'mpim';

export interface UserDTO {
  id: string;
  /** Slack handle (`name`). */
  name: string;
  realName: string | null;
  displayName: string | null;
  /** Best label to show: displayName || realName || name || id. */
  label: string;
  avatarUrl: string | null;
  isBot: boolean;
  deleted: boolean;
}

export interface ConversationDTO {
  id: string;
  type: ConversationType;
  /**
   * Human label without a leading '#'. Channels: channel name. IM: the other user's label (or
   * "You" for the self-DM). MPIM: comma-joined labels of the other members.
   */
  label: string;
  /** Slack's raw `name` (null for IMs). */
  rawName: string | null;
  /** For IMs: the other participant. */
  dmUserId: string | null;
  /** Known member ids (MPIM/IM participants; may be empty for channels). */
  memberIds: string[];
  isArchived: boolean;
  topic: string | null;
  purpose: string | null;
  /** Top-level + reply messages stored in the archive. */
  messageCount: number;
  latestTs: string | null;
  oldestTs: string | null;
  /** Last per-conversation sync problem (e.g. "not_in_channel"), for diagnostics. */
  syncError: string | null;
  /**
   * Its messages Slack Free no longer shows (older than 90 days). Only the single-conversation
   * read (`getConversation`) fills this in; lists leave it out.
   */
  beyondFreeWindow?: BeyondFreeWindowDTO;
}

/** Messages (replies included) older than Slack Free's 90 days: kept only in the archive. */
export interface BeyondFreeWindowDTO {
  count: number;
  /** Unix seconds of the oldest and the newest of them (null when there are none). */
  oldest: number | null;
  newest: number | null;
  /**
   * The self-DM ("You"): Slack keeps showing notes to yourself however old they are, so none of
   * them count (count 0).
   */
  notesToSelf: boolean;
}

// ─── Messages ─────────────────────────────────────────────────────────────────────────────────

export interface ReactionDTO {
  name: string;
  count: number;
  users: string[];
}

export type FileStatus = 'pending' | 'done' | 'failed' | 'skipped' | 'unavailable';

export interface FileDTO {
  id: string;
  name: string | null;
  title: string | null;
  mimetype: string | null;
  filetype: string | null;
  size: number | null;
  isImage: boolean;
  /** Original image dimensions when known. */
  width: number | null;
  height: number | null;
  /** True when a local copy exists. */
  available: boolean;
  /** `archive://file/<id>` for inline display of safe types (null when not available or unsafe). */
  url: string | null;
  /** `archive://thumb/<id>` (null when there is no local thumbnail). */
  thumbUrl: string | null;
  /** Remote Slack permalink (opens Slack in the browser), when known. */
  permalink: string | null;
  status: FileStatus;
  /** Why a file isn't archived, in plain language ("Too large (320 MB)", "Removed from Slack"…). */
  statusReason: string | null;
}

/** Simplified legacy `attachments[]` entry (link unfurls, bot attachments). */
export interface AttachmentDTO {
  color: string | null;
  pretext: string | null;
  authorName: string | null;
  authorLink: string | null;
  authorIcon: string | null;
  title: string | null;
  titleLink: string | null;
  /** mrkdwn */
  text: string | null;
  fallback: string | null;
  imageUrl: string | null;
  thumbUrl: string | null;
  serviceName: string | null;
  serviceIcon: string | null;
  footer: string | null;
  fields: { title: string; value: string; short: boolean }[];
  /** Original URL for unfurls. */
  fromUrl: string | null;
  /** If this attachment is a shared/forwarded Slack message. */
  isMsgUnfurl: boolean;
  /** Block Kit blocks carried inside the attachment (rendered instead of `text` when present). */
  blocks: BlockDTO[];
}

/**
 * A Block Kit block as stored (loosely typed: Slack adds fields over time). The renderer knows
 * rich_text, section, header, context, divider, image, actions, and falls back to text for others.
 */
export type BlockDTO = { type: string; [key: string]: unknown };

export interface MessageDTO {
  conversationId: string;
  ts: string;
  /** Thread root ts; equals `ts` for a thread parent; null when not threaded. */
  threadTs: string | null;
  /** True for thread replies (threadTs != null && threadTs !== ts). */
  isReply: boolean;
  userId: string | null;
  botId: string | null;
  /** Display name for bot/integration messages without a user (e.g. "GitHub"). */
  username: string | null;
  /** Avatar for bot messages (icons.image_48 etc.) when no user avatar applies. */
  botIconUrl: string | null;
  subtype: string | null;
  /** Slack mrkdwn. When the original `text` was empty it is derived from blocks/attachments. */
  text: string;
  /**
   * Block Kit layout to render instead of `text` (bot/app messages whose `text` is only a
   * notification fallback). Empty when `text` is the content (plain user messages).
   */
  blocks: BlockDTO[];
  replyCount: number;
  latestReply: string | null;
  replyUsers: string[];
  editedTs: string | null;
  /** The message was deleted in Slack after we archived it (the archive keeps the last content). */
  isDeleted: boolean;
  /** Number of earlier versions stored (edits we observed). */
  revisionCount: number;
  reactions: ReactionDTO[];
  files: FileDTO[];
  attachments: AttachmentDTO[];
}

export interface MessagesPage {
  /** Ascending by ts. Top-level messages only (plus thread_broadcast replies). */
  messages: MessageDTO[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface MessagesQuery {
  conversationId: string;
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
}

export interface ThreadDTO {
  parent: MessageDTO | null;
  /** Ascending by ts, excluding the parent. */
  replies: MessageDTO[];
}

export interface MessageRevisionDTO {
  text: string;
  editedTs: string | null;
  /** When we recorded this version (epoch ms). */
  seenAt: number;
}

// ─── Search ───────────────────────────────────────────────────────────────────────────────────

export type SearchSort = 'relevance' | 'newest' | 'oldest';
export type SearchHas = 'file' | 'link' | 'reaction' | 'thread' | 'image';

/**
 * `q` may itself contain Slack-style modifiers, which are parsed and merged with the explicit
 * filters:
 *   from:@name  from:me  in:#channel  in:@name (DM)  before:YYYY-MM-DD  after:YYYY-MM-DD
 *   on:YYYY-MM-DD  during:YYYY-MM | during:YYYY  has:file|link|reaction|thread|image  is:thread
 *   "exact phrase"  -exclude
 */
export interface SearchParams {
  q: string;
  /** Conversation id filter. */
  conversation?: string[];
  /** Author user id filter. */
  user?: string[];
  /** Inclusive lower bound, YYYY-MM-DD (local time). */
  after?: string;
  /** Exclusive upper bound, YYYY-MM-DD (local time). */
  before?: string;
  has?: SearchHas[];
  sort?: SearchSort;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  message: MessageDTO;
  /**
   * Plain-text excerpt with highlight markers: '\u0002' starts a match, '\u0003' ends it.
   * Everything else is literal text (render as text, never as HTML).
   */
  snippet: string;
}

export interface SearchResponse {
  total: number;
  hits: SearchHit[];
  /** What was understood from `q` (for filter chips). */
  parsed: {
    text: string;
    conversationIds: string[];
    userIds: string[];
    after: string | null;
    before: string | null;
    has: SearchHas[];
    /** Modifiers that could not be resolved, e.g. "from:@nobody". Makes the result empty. */
    unresolved: string[];
  };
  tookMs: number;
}

// ─── Archive overview ─────────────────────────────────────────────────────────────────────────

export interface WorkspaceDTO {
  teamId: string | null;
  teamName: string | null;
  teamDomain: string | null;
  selfUserId: string | null;
  /** Credentials are saved (the connection may still have expired; see SlackConnectionDTO). */
  connected: boolean;
}

export interface StatsDTO {
  messageCount: number;
  conversationCount: number;
  userCount: number;
  fileCount: number;
  filesDownloaded: number;
  filesBytes: number;
  dbBytes: number;
  /**
   * The period the archive covers: its oldest and newest messages. Notes to yourself (the self-DM)
   * don't set the start, since Slack keeps showing them however old they are, unless the archive
   * holds nothing else.
   */
  oldestTs: string | null;
  newestTs: string | null;
  /** The conversation that holds the oldest message (as `oldestTs` counts it). */
  oldestConversationId: string | null;
  /**
   * When the oldest messages are a thin trickle long before the rest (say, thread starters that
   * Slack still showed for their recent replies): the day most of the archive starts (local
   * midnight, as a ts) and how many messages are older. Null when the archive simply starts at
   * `oldestTs`.
   */
  mainStart: { ts: string; olderCount: number } | null;
  /** Messages older than 90 days, notes to yourself aside: history Slack Free no longer shows. */
  beyondFreeWindowCount: number;
}

// ─── Sync runs ────────────────────────────────────────────────────────────────────────────────

/** 'sync' = Slack API sync; 'files' = attachment downloads only; 'import' = a Slack export. */
export type RunKind = 'sync' | 'files' | 'import';
export type RunStatus = 'running' | 'ok' | 'error' | 'cancelled';

export interface SyncRunDTO {
  id: number;
  kind: RunKind;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  /** Counters such as messagesInserted, messagesUpdated, threadsFetched, filesDownloaded, apiCalls. */
  stats: Record<string, number>;
  /** Technical error (redacted); show `problem` to users instead. */
  error: string | null;
}

export interface SyncProgress {
  /** 'auth' | 'users' | 'conversations' | 'history' | 'threads' | 'emoji' | 'files' | 'import' … */
  phase: string;
  /** Plain-language description, e.g. "Fetching #general — 1,240 messages so far". */
  message: string;
  current: number | null;
  total: number | null;
}

/**
 * Something the user should know about, in plain language with the action to offer (PLAN §8.5).
 * Never contains error codes, HTTP statuses or the words token/cookie.
 */
export interface ProblemDTO {
  kind: 'signed_out' | 'offline' | 'disk_full' | 'wrong_account' | 'unexpected';
  message: string;
  action: 'reconnect' | 'retry' | 'show_logs' | null;
}

export interface SyncStatusDTO {
  running: boolean;
  currentRun: SyncRunDTO | null;
  progress: SyncProgress | null;
  /** Last ~50 log lines of the current (or most recent) run. */
  log: string[];
  recentRuns: SyncRunDTO[];
  intervalMinutes: number;
  /** Epoch ms of the next scheduled automatic sync, or null. */
  nextRunAt: number | null;
  /** Epoch ms when the last successful Slack sync finished. */
  lastSuccessAt: number | null;
  /** New messages that sync archived ("13 new messages"); null before the first one. */
  lastSuccessNewMessages: number | null;
  /** Why syncing can't run right now (e.g. not connected), in plain language; null when it can. */
  blockedReason: string | null;
  /** The last run's failure, humanized; null when the last run was fine. */
  problem: ProblemDTO | null;
  /** The last successful sync is older than 30 days: Slack may already have hidden some history. */
  stale: boolean;
}

export interface StartRunResponse {
  runId: number;
}

// ─── Slack connection ─────────────────────────────────────────────────────────────────────────

/**
 * How the archive authenticates to Slack:
 *  - 'browser': the user signed in inside the app's Slack window; we captured the web session.
 *  - 'cookie': the user pasted the `d` cookie (Advanced) and the session token was derived from it.
 */
export type AuthMethod = 'browser' | 'cookie';

export interface SlackConnectionDTO {
  connected: boolean;
  method: AuthMethod | null;
  teamId: string | null;
  teamName: string | null;
  /** e.g. "9h.slack.com" */
  teamDomain: string | null;
  userId: string | null;
  userName: string | null;
  /** Epoch ms. */
  connectedAt: number | null;
  /** Epoch ms of the last check with Slack. */
  lastCheckedAt: number | null;
  /** Slack signed the session out; the UI offers Reconnect. */
  expired: boolean;
  /** Last validation problem in plain language, or null. */
  error: string | null;
}

export type LoginState =
  | 'idle'
  | 'opening'
  | 'waiting' // Slack window open, waiting for the user to finish signing in
  | 'choose_team' // signed in to several workspaces; the user picks one
  | 'verifying'
  | 'connected'
  | 'error'
  | 'cancelled';

export interface LoginStatusDTO {
  state: LoginState;
  /** Plain-language description of the step. */
  message: string;
  startedAt: number | null;
  error: string | null;
  /** Present in state 'choose_team'. */
  teams: { id: string; name: string; domain: string }[];
  /** Present in state 'connected'. */
  connection: SlackConnectionDTO | null;
}

export interface StartLoginRequest {
  /** Optional workspace hint: "9h", "9h.slack.com" or "https://9h.slack.com". */
  workspace?: string;
}

export interface CookieLoginRequest {
  /** Workspace: "9h", "9h.slack.com" or a URL. */
  workspace: string;
  /** Value of the `d` cookie (starts with "xoxd-"). */
  cookie: string;
}

// ─── Settings ─────────────────────────────────────────────────────────────────────────────────

/** Minutes between automatic syncs; 0 = manual only. */
export type SyncInterval = 0 | 15 | 60 | 360 | 1440;
export const SYNC_INTERVALS: readonly SyncInterval[] = [0, 15, 60, 360, 1440];

/**
 * Which attachments to download (PLAN §8.4 / §10.4):
 *  - 'none': text only.
 *  - 'standard': images & documents (everything except video and audio) up to 25 MB. Default.
 *  - 'everything': any file up to 200 MB.
 */
export type AttachmentPolicy = 'none' | 'standard' | 'everything';

export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * The Claude model Ask AI uses (paid for by the reader's own Anthropic API key). Sonnet is the
 * default; Haiku is faster and cheaper, Opus smarter and the most expensive (2.5 times Sonnet).
 */
export type AiModel = 'claude-sonnet-5' | 'claude-haiku-4-5' | 'claude-opus-5';
export const AI_MODELS: readonly AiModel[] = ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5'];

export interface PreferencesDTO {
  syncIntervalMinutes: SyncInterval;
  attachmentPolicy: AttachmentPolicy;
  /** Days re-read before the newest known message on each sync, to catch edits (PLAN §5.2). */
  overlapDays: number;
  launchAtLogin: boolean;
  theme: ThemePreference;
  onboardingComplete: boolean;
  /** The menu-bar (macOS) / tray (Windows) icon. Without it the app is reopened like any app. */
  showTrayIcon: boolean;
  /** Conversations never synced: no history, threads or attachments are fetched for them. */
  excludedConversationIds: string[];
  aiModel: AiModel;
}

export type PreferencesPatch = Partial<
  Pick<
    PreferencesDTO,
    | 'syncIntervalMinutes'
    | 'attachmentPolicy'
    | 'launchAtLogin'
    | 'theme'
    | 'showTrayIcon'
    | 'excludedConversationIds'
    | 'aiModel'
  >
>;

export interface SettingsDTO {
  preferences: PreferencesDTO;
  connection: SlackConnectionDTO;
  ai: AiKeyStatusDTO;
}

// ─── Ask AI ───────────────────────────────────────────────────────────────────────────────────

/** Whether an Anthropic API key is saved. The key itself never leaves main. */
export interface AiKeyStatusDTO {
  saved: boolean;
  /** The key's last four characters, to recognise it by ("…x7Qa"); null when none is saved. */
  hint: string | null;
}

/** Something the assistant did on the way to an answer, shown as a line above it. */
export interface AiStepDTO {
  kind: 'search' | 'read' | 'list';
  /** e.g. 'Searched “test from:ana”', 'Read #general, 1–7 Sep'. */
  label: string;
  /** The outcome, e.g. "12 results"; null when there's nothing to add. */
  detail: string | null;
}

/** A message the assistant was shown, numbered: the answer cites it as [n]. */
export interface AiSourceDTO {
  ref: number;
  message: MessageDTO;
}

export interface AiUsageDTO {
  model: AiModel;
  /** Everything read, cached or not. */
  inputTokens: number;
  outputTokens: number;
  /** At Anthropic's list prices, in US dollars. */
  costUsd: number;
}

/** What Ask AI has cost, per local day (Settings → Ask AI → Spending). */
export interface AiSpendingDTO {
  /** Days anything was spent, oldest first. */
  days: AiSpendingDayDTO[];
}

export interface AiSpendingDayDTO {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** Estimated at Anthropic's list prices, in US dollars. */
  costUsd: number;
  /** Questions that used any tokens: answered, stopped or failed. */
  questions: number;
}

/**
 *  - no_key: no API key is saved
 *  - bad_key: Anthropic refused the key
 *  - no_credit: the Anthropic account has no credit left
 *  - rate_limited / overloaded: try again in a moment
 *  - offline: Anthropic couldn't be reached
 *  - refused: Claude declined to answer
 *  - failed: anything else
 */
export type AiErrorKind =
  'no_key' | 'bad_key' | 'no_credit' | 'rate_limited' | 'overloaded' | 'offline' | 'refused' | 'failed';

/**
 * One question's progress (`ai` event), in order: steps and text as they happen, sources as the
 * assistant reads messages, then exactly one `done` or `error`.
 */
export type AiEventDTO = { chatId: string; turnId: string } & (
  | { type: 'step'; step: AiStepDTO }
  | { type: 'text'; text: string }
  | { type: 'sources'; sources: AiSourceDTO[] }
  | { type: 'done'; usage: AiUsageDTO | null; stopped: boolean }
  | { type: 'error'; kind: AiErrorKind; message: string }
);

/**
 * What a question is limited to (the "In", "From" and "Date" buttons under the question box).
 * Claude is told, and its tools can't look outside it. Empty lists and nulls mean no limit.
 */
export interface AiScopeDTO {
  /** Only these conversations. */
  conversationIds: string[];
  /** Only messages these people wrote. */
  userIds: string[];
  /** Inclusive, YYYY-MM-DD (local time). */
  after: string | null;
  /** Exclusive, YYYY-MM-DD (local time). */
  before: string | null;
}

export interface AskAiRequest {
  /** Chosen by the window; a new chat is a new id. */
  chatId: string;
  /** This question, echoed in its events. */
  turnId: string;
  question: string;
  scope?: AiScopeDTO;
}

// ─── Storage, backup, app ─────────────────────────────────────────────────────────────────────

export interface StorageDTO {
  dataDir: string;
  databaseBytes: number;
  attachmentsBytes: number;
  logsBytes: number;
  totalBytes: number;
  filesDownloaded: number;
  /** Free space on the archive's disk, when known. */
  diskFreeBytes: number | null;
  /** The archive is larger than the warning threshold (20 GB) or the disk is nearly full. */
  warning: string | null;
}

export interface CleanupResultDTO {
  filesRemoved: number;
  bytesFreed: number;
}

export interface BackupResultDTO {
  path: string;
  bytes: number;
}

export interface DeletedArchiveDTO {
  /** Messages removed from the archive. */
  messages: number;
  /** Attachments removed (those no other conversation shares). */
  files: number;
}

export interface ExportResultDTO {
  /** Where the Markdown file was saved (the user chose it). */
  path: string;
  /** Messages written, thread replies included. */
  messages: number;
}

export interface AppInfoDTO {
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  arch: string;
  isPackaged: boolean;
  dataDir: string;
  logsDir: string;
  /** macOS: false when running from outside /Applications (e.g. straight from the dmg). */
  installedProperly: boolean;
}

export interface UpdateInfoDTO {
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  /** Release notes (markdown-ish plain text written for non-technical readers). */
  notes: string | null;
  releaseUrl: string | null;
  /** The asset for this OS/arch, when the release has one. */
  downloadUrl: string | null;
  checkedAt: number | null;
  /** Checking failed (offline, GitHub unavailable); the banner simply doesn't show. */
  error: string | null;
  /**
   * GitHub answered, but there is no published release to compare with: none has been published
   * yet, or the releases aren't public (GitHub hides a private repository's releases). Not a failure
   * that retrying fixes.
   */
  noRelease: boolean;
  /**
   * Slamem can install this version itself: download it, replace the app and reopen. False when
   * the release has no package for this computer, or this copy can't be replaced where it runs
   * (straight from the disk image, a folder it may not change, a development build); Download
   * remains.
   */
  canInstall: boolean;
  /** Where "Update and restart" has got to. */
  install: UpdateInstallDTO;
}

/**
 *  - idle: not started
 *  - downloading: fetching the new version (`progress`)
 *  - waiting: downloaded; Slamem restarts once the run in `waitingFor` finishes
 *  - restarting: quitting to replace the app, then opening the new version
 *  - failed: `error` says why; Try again and Download remain
 */
export type UpdateInstallState = 'idle' | 'downloading' | 'waiting' | 'restarting' | 'failed';

export interface UpdateInstallDTO {
  state: UpdateInstallState;
  /** 0–1 while downloading. */
  progress: number | null;
  /** While waiting: the sync, attachment download or import that finishes first. */
  waitingFor: RunKind | null;
  /** Plain-language reason when the update failed. */
  error: string | null;
}

/** Response of calls that only acknowledge. */
export interface OkDTO {
  ok: true;
}
