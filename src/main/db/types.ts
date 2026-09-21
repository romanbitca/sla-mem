import type Database from 'better-sqlite3';
import type { FileStatus } from '../../shared/types';

/** A better-sqlite3 connection opened (and migrated) by `openDb`. */
export type DB = Database.Database;

/** Per-conversation sync bookkeeping (table `sync_state`). */
export interface SyncStateRow {
  conversation_id: string;
  /** Newest message ts seen by a sync (incremental syncs resume from here). */
  latest_ts: string | null;
  /** Oldest message ts seen by a sync. */
  oldest_ts: string | null;
  /** True once history was paged to its end (on Free plan: to the 90-day limit). */
  backfill_complete: boolean;
  /** Epoch ms of the last successful sync of this conversation. */
  last_synced_at: number | null;
  last_error: string | null;
}

/**
 * Patch accepted by `setSyncState`. `backfill_complete` also accepts 0/1 so callers can pass the
 * raw SQLite representation.
 */
export type SyncStatePatch = Partial<Omit<SyncStateRow, 'conversation_id' | 'backfill_complete'>> & {
  backfill_complete?: boolean | number;
};

/** A row of the `files` table, as stored. */
export interface FileRow {
  id: string;
  name: string | null;
  title: string | null;
  mimetype: string | null;
  filetype: string | null;
  size: number | null;
  url_private: string | null;
  url_private_download: string | null;
  permalink: string | null;
  /** Best remote thumbnail (thumb_720 | thumb_480 | thumb_360 | thumb_pdf | thumb_video). */
  thumb_url: string | null;
  width: number | null;
  height: number | null;
  /** Relative to the archive's files directory. */
  local_path: string | null;
  /** Relative to the archive's files directory. */
  thumb_local_path: string | null;
  download_status: FileStatus;
  download_error: string | null;
  download_attempts: number;
  /** Why a file is `skipped`: 'policy' | 'too_large' | 'removed' (the user freed the space). */
  skip_reason: FileSkipReason | null;
  /** Epoch ms before which a `failed` file isn't retried. */
  next_attempt_at: number | null;
  created: number | null;
  user_id: string | null;
  /** JSON of the raw Slack file object. */
  raw: string;
  updated_at: number;
}

/** Stored `messages` row (all columns). */
export interface MessageRow {
  id: number;
  conversation_id: string;
  ts: string;
  time: number;
  thread_ts: string | null;
  is_reply: number;
  user_id: string | null;
  bot_id: string | null;
  username: string | null;
  subtype: string | null;
  text: string;
  plain_text: string;
  reply_count: number;
  latest_reply: string | null;
  /** JSON string[] */
  reply_users: string;
  edited_ts: string | null;
  has_files: number;
  has_links: number;
  has_images: number;
  /** JSON ReactionDTO-like array */
  reactions: string;
  is_deleted: number;
  raw: string;
  source: string;
  first_seen_at: number;
  updated_at: number;
}

export type MessageSource = 'api' | 'import';

export type FileSkipReason = 'policy' | 'too_large' | 'removed';
