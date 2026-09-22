/**
 * Archive database: schema/migrations, merge-policy writes, DTO reads, search, locks and runs.
 * Other modules import from here ('../db') rather than from individual files.
 */
export type { DB, FileRow, FileSkipReason, SyncStateRow, SyncStatePatch, MessageRow, MessageSource } from './types';

export { openDb, migrate, getSchemaVersion } from './open';
export { MIGRATIONS, LATEST_SCHEMA_VERSION } from './schema';
export { getMeta, setMeta, deleteMeta, getWorkspaceMeta } from './meta';

export {
  upsertUsers,
  upsertConversations,
  upsertMessages,
  upsertCustomEmoji,
  getSyncState,
  setSyncState,
  listActiveThreads,
  getStoredThreadInfo,
  countHistoryMessagesSince,
  listDownloadCandidates,
  markFileDownloaded,
  markFileFailed,
  markFileSkipped,
  markFileUnavailable,
  markFileRemoved,
  setFileThumb,
  requeueFile,
  listDownloadedFilesBefore,
  failureBackoffMs,
  getFileRow,
  isUsableFile,
  reindexAll,
  deleteConversationData,
  reindexBatch,
  refreshSearchTextIfOutdated,
  allocateMessageId,
  SEARCH_TEXT_VERSION_KEY,
  SEARCH_TEXT_VERSION,
  conversationTypeOf,
} from './write';
export type { UpsertMessagesResult } from './write';

export { tryAcquireLock, refreshLock, releaseLock, readLock, isPidAlive, DEFAULT_LOCK_STALE_MS } from './locks';
export type { LockInfo } from './locks';

export {
  createRun,
  updateRun,
  listRuns,
  getRun,
  getRunLog,
  markStaleRunsInterrupted,
  lastFinishedRun,
  lastSuccessfulRunAt,
  lastSuccessfulRun,
  MAX_RUN_LOG_LINES,
} from './runs';
export type { RunPatch } from './runs';

export {
  listUsers,
  listConversations,
  getConversation,
  conversationBeyondFreeWindow,
  notesToSelfId,
  getMessages,
  getThread,
  getMessageRevisions,
  getStats,
  listCustomEmoji,
  normalizeTs,
  FREE_WINDOW_DAYS,
  tsAtSecond,
  topLevelInRange,
  threadReplies,
  messageRowIds,
  plainTexts,
  conversationActivity,
} from './read';
export type { GetMessagesQuery, TopLevelRow, ConversationActivity } from './read';

export {
  search,
  parseSearchQuery,
  tokenizeSearchQuery,
  buildMatchExpression,
  ftsLiteral,
  createSearchResolvers,
  loadSearchResolvers,
  clampSnippet,
  stripControlChars,
  parseDay,
  addDays,
  localDayStartSeconds,
} from './search';
export type {
  ParsedSearchQuery,
  SearchResolvers,
  SearchUser,
  SearchConversation,
  SearchBot,
  SearchWithin,
} from './search';

export {
  normalizeForSearch,
  displayTextFromMessage,
  displayBlocks,
  mrkdwnToPlain,
  blocksToMrkdwn,
  unescapeEntities,
} from './normalize';
export {
  fileToDTO,
  fileStatusReason,
  isInlineSafeMime,
  hydrateMessages,
  FILE_URL_PREFIX,
  THUMB_URL_PREFIX,
} from './dto';
export type { NormalizeResolvers } from './normalize';
export { isTombstone } from './merge';
