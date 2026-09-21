import type { SlackFile, SlackMessage, SlackReaction } from '../slack/types';
import { displayTextFromMessage, normalizeForSearch, type NormalizeResolvers } from './normalize';
import type { MessageRow, MessageSource } from './types';

/**
 * Pure merge rules for `upsertMessages` (see SPEC "Merge policy"). Everything here is
 * side-effect free; write.ts applies the result.
 */

export type MessageColumns = Omit<MessageRow, 'id'>;

export interface RevisionToStore {
  text: string;
  edited_ts: string | null;
  seen_at: number;
}

const DELETED_TEXT = 'This message was deleted.';

export function isTombstone(msg: { subtype?: string | null; text?: string | null }): boolean {
  if (msg.subtype === 'tombstone') return true;
  return msg.subtype === 'hidden' && msg.text === DELETED_TEXT;
}

export function isValidTs(ts: unknown): ts is string {
  return typeof ts === 'string' && /^\d+(\.\d+)?$/.test(ts);
}

/** `time` column: whole unix seconds of a Slack ts. */
export function tsToSeconds(ts: string): number {
  return Math.floor(Number(ts));
}

/**
 * A Slack ts as integer microseconds, computed from the digits (no float rounding). Message row
 * ids start from this value so rowid order is chronological; see write.ts `allocateMessageId`.
 */
export function tsToMicros(ts: string): number {
  const [whole, frac = ''] = ts.split('.');
  return Number(whole) * 1_000_000 + Number(frac.padEnd(6, '0').slice(0, 6));
}

/** Numeric ts comparison; string comparison breaks when fractional digits differ in length. */
export function compareTs(a: string, b: string): number {
  return Number(a) - Number(b);
}

export function laterTs(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return compareTs(b, a) > 0 ? b : a;
}

/** Slack sets `thread_ts === ts` on parents; only a differing thread_ts marks a reply. */
export function isReplyTs(ts: string, threadTs: string | null): boolean {
  return threadTs != null && threadTs !== ts;
}

export function isImageMime(mimetype: string | null | undefined): boolean {
  return typeof mimetype === 'string' && mimetype.toLowerCase().startsWith('image/');
}

function hasLinks(msg: SlackMessage): boolean {
  if (/<(https?:|mailto:)/i.test(displayTextFromMessage(msg))) return true;
  return (msg.attachments ?? []).some((a) => Boolean(a.from_url || a.original_url || a.title_link));
}

function normalizeReactions(
  reactions: SlackReaction[] | undefined,
): { name: string; count: number; users: string[] }[] {
  return (reactions ?? [])
    .filter((r) => r && typeof r.name === 'string')
    .map((r) => {
      const users = Array.isArray(r.users) ? r.users.filter((u) => typeof u === 'string') : [];
      return { name: r.name, count: typeof r.count === 'number' ? r.count : users.length, users };
    });
}

function filesOf(msg: SlackMessage): SlackFile[] {
  return Array.isArray(msg.files) ? msg.files.filter((f) => f && typeof f.id === 'string') : [];
}

/** Search text for a message; tombstones index nothing so "deleted" placeholders never match. */
export function plainTextFor(msg: SlackMessage, r: NormalizeResolvers): string {
  return isTombstone(msg) ? '' : normalizeForSearch(msg, r);
}

type ContentColumns = Pick<
  MessageColumns,
  | 'subtype'
  | 'user_id'
  | 'bot_id'
  | 'username'
  | 'text'
  | 'plain_text'
  | 'edited_ts'
  | 'has_files'
  | 'has_links'
  | 'has_images'
  | 'reactions'
  | 'raw'
>;

function contentOf(msg: SlackMessage, r: NormalizeResolvers): ContentColumns {
  const files = filesOf(msg);
  return {
    subtype: msg.subtype ?? null,
    user_id: msg.user ?? null,
    bot_id: msg.bot_id ?? null,
    username: msg.username ?? null,
    text: msg.text ?? '',
    plain_text: plainTextFor(msg, r),
    edited_ts: msg.edited?.ts ?? null,
    has_files: files.length > 0 ? 1 : 0,
    has_links: hasLinks(msg) ? 1 : 0,
    has_images: files.some((f) => isImageMime(f.mimetype)) ? 1 : 0,
    reactions: JSON.stringify(normalizeReactions(msg.reactions)),
    raw: JSON.stringify(msg),
  };
}

function storedContent(row: MessageRow): ContentColumns {
  const { subtype, user_id, bot_id, username, text, plain_text, edited_ts, has_files, has_links, has_images } = row;
  return {
    subtype,
    user_id,
    bot_id,
    username,
    text,
    plain_text,
    edited_ts,
    has_files,
    has_links,
    has_images,
    reactions: row.reactions,
    raw: row.raw,
  };
}

export function newMessageRow(
  conversationId: string,
  msg: SlackMessage,
  source: MessageSource,
  now: number,
  r: NormalizeResolvers,
): MessageColumns {
  const threadTs = msg.thread_ts ?? null;
  return {
    conversation_id: conversationId,
    ts: msg.ts,
    time: tsToSeconds(msg.ts),
    thread_ts: threadTs,
    is_reply: isReplyTs(msg.ts, threadTs) ? 1 : 0,
    ...contentOf(msg, r),
    reply_count: Math.max(0, msg.reply_count ?? 0),
    latest_reply: msg.latest_reply ?? null,
    reply_users: JSON.stringify(uniqueStrings(msg.reply_users ?? [])),
    is_deleted: isTombstone(msg) ? 1 : 0,
    source,
    first_seen_at: now,
    updated_at: now,
  };
}

/**
 * True when the incoming copy is an older or degraded snapshot of what we already store, e.g. an
 * old export imported after an API sync saw an edit, or a Free-plan-locked message. Stored content
 * then wins so we never regress or blank out archived text.
 */
export function isStaleContent(stored: MessageRow, msg: SlackMessage): boolean {
  if (msg.is_locked === true) return true;
  const incomingEdit = msg.edited?.ts ?? null;
  const storedEdit = stored.edited_ts;
  if (incomingEdit && (!storedEdit || compareTs(incomingEdit, storedEdit) > 0)) return false;
  if (storedEdit && incomingEdit !== storedEdit) return true;
  return !(msg.text ?? '').trim() && stored.text.trim() !== '';
}

export interface MergeResult {
  row: MessageColumns;
  revision: RevisionToStore | null;
  changed: boolean;
}

export function mergeMessageRow(
  stored: MessageRow,
  msg: SlackMessage,
  source: MessageSource,
  now: number,
  r: NormalizeResolvers,
): MergeResult {
  const incomingTombstone = isTombstone(msg);
  const storedTombstone = isTombstone(stored);
  const keepStored = incomingTombstone || (!storedTombstone && isStaleContent(stored, msg));
  const content = keepStored ? storedContent(stored) : mergeFreshContent(stored, contentOf(msg, r), source);
  const threadTs = msg.thread_ts ?? stored.thread_ts;

  const row: MessageColumns = {
    conversation_id: stored.conversation_id,
    ts: stored.ts,
    time: stored.time,
    thread_ts: threadTs,
    is_reply: isReplyTs(stored.ts, threadTs) ? 1 : 0,
    ...content,
    // Reply metadata only grows: a stale source (old export, partial page) must not shrink it.
    reply_count: Math.max(stored.reply_count, msg.reply_count ?? 0),
    latest_reply: laterTs(stored.latest_reply, msg.latest_reply ?? null),
    reply_users: JSON.stringify(uniqueStrings([...parseStringArray(stored.reply_users), ...(msg.reply_users ?? [])])),
    // Slack never un-deletes; once we saw a tombstone the flag sticks.
    is_deleted: stored.is_deleted || incomingTombstone ? 1 : 0,
    source: stored.source,
    first_seen_at: stored.first_seen_at,
    updated_at: stored.updated_at,
  };

  const changed = rowDiffers(stored, row);
  if (changed) {
    // `source` records the last writer that actually changed something.
    row.source = source;
    row.updated_at = now;
  }
  const revision = shouldStoreRevision(stored, content, keepStored, storedTombstone)
    ? { text: stored.text, edited_ts: stored.edited_ts, seen_at: stored.updated_at }
    : null;
  return { row, revision, changed };
}

/**
 * Incoming content, but authorship and file flags are never lost to a sparser source, and an
 * export imported after an API sync doesn't roll reactions back to the export's older snapshot.
 */
function mergeFreshContent(stored: MessageRow, incoming: ContentColumns, source: MessageSource): ContentColumns {
  const olderSnapshot = source === 'import' && stored.source === 'api';
  return {
    ...incoming,
    user_id: incoming.user_id ?? stored.user_id,
    bot_id: incoming.bot_id ?? stored.bot_id,
    username: incoming.username ?? stored.username,
    has_files: incoming.has_files || stored.has_files,
    has_images: incoming.has_images || stored.has_images,
    reactions: olderSnapshot ? stored.reactions : incoming.reactions,
  };
}

/**
 * The previous text becomes a revision whenever fresh content replaces it, including an edit
 * that empties the text (pitfall 1: the archived words must survive in the history).
 */
function shouldStoreRevision(
  stored: MessageRow,
  next: ContentColumns,
  keptStored: boolean,
  storedTombstone: boolean,
): boolean {
  if (keptStored || storedTombstone) return false;
  return stored.text !== next.text && stored.text !== '';
}

function rowDiffers(stored: MessageRow, next: MessageColumns): boolean {
  for (const key of Object.keys(next) as (keyof MessageColumns)[]) {
    if (key === 'updated_at') continue;
    if (stored[key] !== next[key]) return true;
  }
  return false;
}

export function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string'))];
}
