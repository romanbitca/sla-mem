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
  conversationTypeOf,
} from './write';
export type { UpsertMessagesResult } from './write';

export { tryAcquireLock, refreshLock, releaseLock, readLock, isPidAlive, DEFAULT_LOCK_STALE_MS } from './locks';
export type { LockInfo } from './locks';

export { createRun, updateRun, listRuns, getRun, getRunLog, markStaleRunsInterrupted, MAX_RUN_LOG_LINES } from './runs';
export type { RunPatch } from './runs';

export {
  listUsers,
  listConversations,
  getConversation,
  getMessages,
  getThread,
  getMessageRevisions,
  getStats,
  listCustomEmoji,
  normalizeTs,
  FREE_WINDOW_DAYS,
} from './read';
export type { GetMessagesQuery } from './read';

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
} from './search';
export type { ParsedSearchQuery, SearchResolvers, SearchUser, SearchConversation, SearchBot } from './search';

export { normalizeForSearch, displayTextFromMessage, displayBlocks, mrkdwnToPlain, blocksToMrkdwn } from './normalize';
export { fileToDTO, fileStatusReason, isInlineSafeMime, FILE_URL_PREFIX, THUMB_URL_PREFIX } from './dto';
export type { NormalizeResolvers } from './normalize';
export { isTombstone } from './merge';
