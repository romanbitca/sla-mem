/**
 * Versioned schema migrations. `PRAGMA user_version` records the last applied version; each
 * migration runs once, inside a transaction, in ascending order. Never edit a shipped migration:
 * append a new one instead.
 *
 * v1 is PLAN.md Appendix B (which now reproduces it): the original draft plus `conversation_stats`
 * (sidebar counts without scanning messages), `bots` (so `from:<app>` finds bot messages),
 * `runs.pid` / `runs.problem`, and the file retry columns `skip_reason` / `next_attempt_at`
 * (PLAN §5.6: failed and skipped files must stay retryable). v2 adds one index for the People
 * pages. An older app refuses a newer archive (open.ts), and importing a newer backup says to
 * update first (restore.ts).
 */
export interface Migration {
  version: number;
  description: string;
  sql: string;
}

const V1_TABLES = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE users (
  id TEXT PRIMARY KEY, team_id TEXT, name TEXT, real_name TEXT, display_name TEXT,
  avatar_url TEXT, is_bot INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
  raw TEXT NOT NULL, updated_at INTEGER NOT NULL
);

-- Integrations and apps that post without a user (bot_id only). Filled from messages.
CREATE TABLE bots (
  id TEXT PRIMARY KEY, name TEXT, icon_url TEXT, app_id TEXT, user_id TEXT, updated_at INTEGER NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('channel','private_channel','im','mpim')),
  name TEXT, dm_user_id TEXT, is_archived INTEGER NOT NULL DEFAULT 0,
  is_member INTEGER NOT NULL DEFAULT 1, topic TEXT, purpose TEXT, created INTEGER,
  member_ids TEXT NOT NULL DEFAULT '[]', raw TEXT NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL, ts TEXT NOT NULL,
  time INTEGER NOT NULL,
  thread_ts TEXT, is_reply INTEGER NOT NULL DEFAULT 0,
  user_id TEXT, bot_id TEXT, username TEXT, subtype TEXT,
  text TEXT NOT NULL DEFAULT '',
  plain_text TEXT NOT NULL DEFAULT '',
  reply_count INTEGER NOT NULL DEFAULT 0, latest_reply TEXT, reply_users TEXT NOT NULL DEFAULT '[]',
  edited_ts TEXT, has_files INTEGER NOT NULL DEFAULT 0, has_links INTEGER NOT NULL DEFAULT 0,
  has_images INTEGER NOT NULL DEFAULT 0,
  reactions TEXT NOT NULL DEFAULT '[]', is_deleted INTEGER NOT NULL DEFAULT 0,
  raw TEXT NOT NULL, source TEXT NOT NULL, first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (conversation_id, ts)
);

CREATE VIRTUAL TABLE messages_fts USING fts5(plain_text, content='messages', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2');

CREATE TABLE message_revisions (
  id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, ts TEXT NOT NULL,
  text TEXT NOT NULL, edited_ts TEXT, seen_at INTEGER NOT NULL
);

-- skip_reason: 'policy' (attachment setting), 'too_large', 'removed' (the user freed space).
-- next_attempt_at: epoch ms before which a failed download isn't retried (backoff).
CREATE TABLE files (
  id TEXT PRIMARY KEY, name TEXT, title TEXT, mimetype TEXT, filetype TEXT, size INTEGER,
  url_private TEXT, url_private_download TEXT, permalink TEXT, thumb_url TEXT,
  width INTEGER, height INTEGER,
  local_path TEXT, thumb_local_path TEXT,
  download_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (download_status IN ('pending','done','failed','skipped','unavailable')),
  download_error TEXT, download_attempts INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT, next_attempt_at INTEGER,
  created INTEGER, user_id TEXT, raw TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE message_files (
  conversation_id TEXT NOT NULL, ts TEXT NOT NULL, file_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, ts, file_id)
);

CREATE TABLE custom_emoji (name TEXT PRIMARY KEY, url TEXT, alias_for TEXT, updated_at INTEGER NOT NULL);

CREATE TABLE sync_state (
  conversation_id TEXT PRIMARY KEY, latest_ts TEXT, oldest_ts TEXT,
  backfill_complete INTEGER NOT NULL DEFAULT 0, last_synced_at INTEGER, last_error TEXT
);

-- pid: lets a starting app tell its own stale runs (crash) apart from a live one.
-- problem: what kind of failure the error describes (signed_out, offline, disk_full…), for the UI.
CREATE TABLE runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, stats TEXT NOT NULL DEFAULT '{}',
  error TEXT, problem TEXT, log TEXT NOT NULL DEFAULT '[]', pid INTEGER
);

-- Aggregate maintained by triggers so the sidebar (message counts, date ranges) and stats stay
-- O(conversations) instead of scanning every message.
CREATE TABLE conversation_stats (
  conversation_id TEXT PRIMARY KEY,
  message_count INTEGER NOT NULL DEFAULT 0,
  oldest_ts TEXT, latest_ts TEXT
);
`;

// External-content FTS5 tables must be told the *old* indexed text to delete it, so updates are a
// delete + insert. The WHEN clause skips re-indexing when an upsert rewrites identical text.
const V1_TRIGGERS = `
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, plain_text) VALUES (new.id, new.plain_text);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, plain_text) VALUES ('delete', old.id, old.plain_text);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF plain_text ON messages
WHEN old.plain_text IS NOT new.plain_text BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, plain_text) VALUES ('delete', old.id, old.plain_text);
  INSERT INTO messages_fts (rowid, plain_text) VALUES (new.id, new.plain_text);
END;

CREATE TRIGGER messages_stats_ai AFTER INSERT ON messages BEGIN
  INSERT INTO conversation_stats (conversation_id, message_count, oldest_ts, latest_ts)
  VALUES (new.conversation_id, 1, new.ts, new.ts)
  ON CONFLICT (conversation_id) DO UPDATE SET
    message_count = message_count + 1,
    oldest_ts = min(COALESCE(oldest_ts, excluded.oldest_ts), excluded.oldest_ts),
    latest_ts = max(COALESCE(latest_ts, excluded.latest_ts), excluded.latest_ts);
END;
CREATE TRIGGER messages_stats_ad AFTER DELETE ON messages BEGIN
  UPDATE conversation_stats SET
    message_count = message_count - 1,
    oldest_ts = (SELECT min(ts) FROM messages WHERE conversation_id = old.conversation_id),
    latest_ts = (SELECT max(ts) FROM messages WHERE conversation_id = old.conversation_id)
  WHERE conversation_id = old.conversation_id;
END;
-- Identity columns never change in practice; handled anyway so the aggregate can't drift.
CREATE TRIGGER messages_stats_au AFTER UPDATE OF conversation_id, ts ON messages BEGIN
  UPDATE conversation_stats SET
    message_count = message_count - 1,
    oldest_ts = (SELECT min(ts) FROM messages WHERE conversation_id = old.conversation_id),
    latest_ts = (SELECT max(ts) FROM messages WHERE conversation_id = old.conversation_id)
  WHERE conversation_id = old.conversation_id;
  INSERT INTO conversation_stats (conversation_id, message_count, oldest_ts, latest_ts)
  VALUES (new.conversation_id, 1, new.ts, new.ts)
  ON CONFLICT (conversation_id) DO UPDATE SET
    message_count = message_count + 1,
    oldest_ts = (SELECT min(ts) FROM messages WHERE conversation_id = new.conversation_id),
    latest_ts = (SELECT max(ts) FROM messages WHERE conversation_id = new.conversation_id);
END;
`;

const V1_INDEXES = `
CREATE INDEX messages_conv_reply_ts ON messages (conversation_id, is_reply, ts);
CREATE INDEX messages_conv_thread_ts ON messages (conversation_id, thread_ts, ts);
-- Author and conversation filters, sorted by time. The trailing columns make combined filters
-- (from:me has:link, in:#x is:thread) index-only instead of one table lookup per candidate.
CREATE INDEX messages_user_time ON messages (user_id, time, has_links, has_files, has_images, reply_count, thread_ts);
CREATE INDEX messages_conv_time ON messages (conversation_id, time, has_links, has_files, has_images, reply_count, thread_ts);
CREATE INDEX messages_bot_time ON messages (bot_id, time) WHERE bot_id IS NOT NULL;
CREATE INDEX messages_time ON messages (time);
-- The conversation view pages over top-level messages only. The WHERE clause must match the
-- query text exactly for SQLite to use this partial index (see read.ts TOP_LEVEL).
CREATE INDEX messages_conv_top_ts ON messages (conversation_id, ts)
  WHERE is_reply = 0 OR subtype = 'thread_broadcast';
-- Sparse partial indexes so filter-only has: listings don't scan every message. Their WHERE
-- clauses must match search.ts HAS_SQL verbatim (modulo the m. alias).
CREATE INDEX messages_has_files ON messages (time) WHERE has_files = 1;
CREATE INDEX messages_has_links ON messages (time) WHERE has_links = 1;
CREATE INDEX messages_has_images ON messages (time) WHERE has_images = 1;
CREATE INDEX messages_has_reactions ON messages (time) WHERE reactions <> '[]';
CREATE INDEX messages_has_thread ON messages (time) WHERE reply_count > 0;
-- is:thread (parents and replies); matches search.ts IS_THREAD_SQL.
CREATE INDEX messages_in_thread ON messages (time) WHERE thread_ts IS NOT NULL;
CREATE INDEX message_files_file ON message_files (file_id);
CREATE INDEX message_revisions_conv_ts ON message_revisions (conversation_id, ts);
CREATE INDEX files_status_created ON files (download_status, created);
CREATE INDEX runs_status ON runs (status);
`;

// v2, People: what one person wrote in one conversation ("where they write", "did you answer in
// that DM"). Without it, that is one table lookup per message they ever sent: 84 ms for someone
// with 53k messages in a 488k-message archive, 2 ms with it. Partial on purpose: only a query
// naming an author (user_id = ?) can use it, so every older query keeps its plan. As a full index
// SQLite preferred it, being narrower, and sorted: a conversation's newest messages went from
// reading 8 rows in order to sorting 60k, and author-only queries sorted too.
const V2_PEOPLE = `
CREATE INDEX messages_conv_user_time ON messages (conversation_id, user_id, time) WHERE user_id IS NOT NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, description: 'initial schema', sql: V1_TABLES + V1_TRIGGERS + V1_INDEXES },
  { version: 2, description: 'index messages by author and conversation (People)', sql: V2_PEOPLE },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
