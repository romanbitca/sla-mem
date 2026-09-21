/** Slack Web API sync: client, sync engine and file downloader. */
export { SlackClient, methodIntervalMs, SLACK_API_BASE_URL } from './client';
export type { SlackClientOptions, Sleep, DownloadOptions, DownloadResult } from './client';
export {
  runApiSync,
  runFileDownloads,
  statsFromError,
  teamDomainFromUrl,
  assertSameOwner,
  DEFAULT_OVERLAP_SECONDS,
  DEFAULT_THREAD_RECHECK_DAYS,
} from './sync';
export type { ApiSyncOptions, ApiSyncStats } from './sync';
export { downloadPendingFiles, sanitizeFileName, fileTarget } from './files';
export type { DownloadFilesOptions, DownloadFilesStats, FileTarget } from './files';
export { decideDownload, POLICY_RULES, MB } from './policy';
export {
  SlackApiError,
  SlackHttpError,
  DownloadError,
  WrongAccountError,
  isFatalAuthError,
  AUTH_FAILURE_CODES,
} from './errors';
export type { DownloadFailureKind } from './errors';
export { isAbortError, stripQuery, redactSecrets } from './util';
export type { SlackParams } from './api-types';
