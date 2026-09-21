import type { AttachmentDTO, BlockDTO, FileDTO, FileStatus, MessageDTO, ReactionDTO } from '../../shared/types';
import type { SlackAttachment, SlackMessage } from '../slack/types';
import { nonEmpty } from './labels';
import { isImageMime, parseStringArray } from './merge';
import { displayBlocks, displayTextFromMessage } from './normalize';
import { stmt } from './stmt';
import type { DB } from './types';

/** Columns of a message needed to build a MessageDTO (plain_text is deliberately not loaded). */
interface MessageDtoRow {
  id: number;
  conversation_id: string;
  ts: string;
  thread_ts: string | null;
  is_reply: number;
  user_id: string | null;
  bot_id: string | null;
  username: string | null;
  subtype: string | null;
  reply_count: number;
  latest_reply: string | null;
  reply_users: string;
  edited_ts: string | null;
  is_deleted: number;
  reactions: string;
  raw: string;
  revision_count: number;
}

export interface FileDtoRow {
  id: string;
  name: string | null;
  title: string | null;
  mimetype: string | null;
  filetype: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  permalink: string | null;
  local_path: string | null;
  thumb_local_path: string | null;
  download_status: FileStatus;
  download_error: string | null;
  skip_reason: string | null;
}

const SELECT_MESSAGES_BY_ID = `
SELECT m.id, m.conversation_id, m.ts, m.thread_ts, m.is_reply, m.user_id, m.bot_id, m.username, m.subtype,
  m.reply_count, m.latest_reply, m.reply_users, m.edited_ts, m.is_deleted, m.reactions, m.raw,
  (SELECT count(*) FROM message_revisions r WHERE r.conversation_id = m.conversation_id AND r.ts = m.ts) AS revision_count
FROM messages m WHERE m.id IN (SELECT value FROM json_each(?))`;

const SELECT_FILES_BY_MESSAGE_ID = `
SELECT m.id AS message_id, f.id, f.name, f.title, f.mimetype, f.filetype, f.size, f.width, f.height, f.permalink,
  f.local_path, f.thumb_local_path, f.download_status, f.download_error, f.skip_reason
FROM messages m
JOIN message_files mf ON mf.conversation_id = m.conversation_id AND mf.ts = m.ts
JOIN files f ON f.id = mf.file_id
WHERE m.id IN (SELECT value FROM json_each(?))
ORDER BY m.id, mf.position`;

/**
 * Loads full MessageDTOs for message row ids, preserving the order of `ids`. Two queries total
 * regardless of page size (messages, then their files).
 */
export function hydrateMessages(db: DB, ids: readonly number[]): MessageDTO[] {
  if (!ids.length) return [];
  const idsJson = JSON.stringify(ids);
  const rows = new Map<number, MessageDtoRow>();
  for (const row of stmt<MessageDtoRow>(db, SELECT_MESSAGES_BY_ID).all(idsJson)) rows.set(row.id, row);
  const files = new Map<number, FileDTO[]>();
  for (const f of stmt<FileDtoRow & { message_id: number }>(db, SELECT_FILES_BY_MESSAGE_ID).all(idsJson)) {
    const list = files.get(f.message_id) ?? [];
    list.push(fileToDTO(f));
    files.set(f.message_id, list);
  }
  const out: MessageDTO[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (row) out.push(messageToDTO(row, files.get(id) ?? []));
  }
  return out;
}

function messageToDTO(row: MessageDtoRow, files: FileDTO[]): MessageDTO {
  const raw = parseRaw(row.raw, row.ts);
  return {
    conversationId: row.conversation_id,
    ts: row.ts,
    threadTs: row.thread_ts,
    isReply: row.is_reply === 1,
    userId: row.user_id,
    botId: row.bot_id,
    username: row.username ?? nonEmpty(raw.bot_profile?.name) ?? null,
    botIconUrl: botIconUrl(raw),
    subtype: row.subtype,
    text: displayTextFromMessage(raw),
    blocks: displayBlocks(raw.blocks) as BlockDTO[],
    replyCount: row.reply_count,
    latestReply: row.latest_reply,
    replyUsers: parseStringArray(row.reply_users),
    editedTs: row.edited_ts,
    isDeleted: row.is_deleted === 1,
    revisionCount: row.revision_count,
    reactions: parseReactions(row.reactions),
    files,
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).filter(isObject).map(attachmentToDTO),
  };
}

function parseRaw(json: string, ts: string): SlackMessage {
  try {
    const value: unknown = JSON.parse(json);
    if (isObject(value)) return value as SlackMessage;
  } catch {
    // fall through: a corrupt raw column must not break a whole page
  }
  return { ts };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ICON_KEYS = ['image_48', 'image_72', 'image_36'] as const;

function botIconUrl(raw: SlackMessage): string | null {
  for (const icons of [raw.icons, raw.bot_profile?.icons]) {
    if (!isObject(icons)) continue;
    for (const key of ICON_KEYS) {
      const url = icons[key];
      if (typeof url === 'string' && url) return url;
    }
  }
  return null;
}

function parseReactions(json: string): ReactionDTO[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).flatMap((r) => {
    if (typeof r.name !== 'string') return [];
    const users = Array.isArray(r.users) ? r.users.filter((u): u is string => typeof u === 'string') : [];
    return [{ name: r.name, count: typeof r.count === 'number' ? r.count : users.length, users }];
  });
}

/** archive:// URLs served by the main process (src/main/protocol.ts). */
export const FILE_URL_PREFIX = 'archive://file/';
export const THUMB_URL_PREFIX = 'archive://thumb/';

/**
 * Types the app may show inline. Attachments are untrusted: HTML, SVG, XML and everything else
 * are only ever opened with the system app or revealed in the folder (PLAN §3.6, pitfall 19).
 */
export function isInlineSafeMime(mimetype: string | null | undefined): boolean {
  const type = (mimetype ?? '').toLowerCase().split(';')[0].trim();
  if (type === 'image/svg+xml') return false;
  return /^image\/(png|jpe?g|gif|webp|bmp|avif)$/.test(type) || /^(video|audio)\//.test(type);
}

export function fileToDTO(f: FileDtoRow): FileDTO {
  const available = f.download_status === 'done' && f.local_path != null;
  const isImage = isImageMime(f.mimetype);
  const id = encodeURIComponent(f.id);
  const inline = available && isInlineSafeMime(f.mimetype);
  return {
    id: f.id,
    name: f.name,
    title: f.title,
    mimetype: f.mimetype,
    filetype: f.filetype,
    size: f.size,
    isImage,
    width: f.width,
    height: f.height,
    available,
    url: inline ? `${FILE_URL_PREFIX}${id}` : null,
    // A downloaded image can serve as its own thumbnail when Slack gave us no separate thumb.
    thumbUrl: f.thumb_local_path || (inline && isImage) ? `${THUMB_URL_PREFIX}${id}` : null,
    permalink: f.permalink,
    status: f.download_status,
    statusReason: fileStatusReason(f),
  };
}

/** Plain-language reason a file has no local copy (technical errors stay in the logs). */
export function fileStatusReason(
  f: Pick<FileDtoRow, 'download_status' | 'download_error' | 'skip_reason'>,
): string | null {
  switch (f.download_status) {
    case 'done':
      return null;
    case 'pending':
      return 'It will be downloaded with the next sync';
    case 'failed':
      return failedReason(f.download_error);
    case 'skipped':
      if (f.skip_reason === 'removed') return 'Removed to save space';
      return f.download_error || 'Not downloaded (attachment setting)';
    case 'unavailable':
      return f.download_error || 'No longer available from Slack';
  }
}

/** A failed download's stored error (technical, for the logs) as a reason the reader can use. */
function failedReason(error: string | null): string {
  const e = (error ?? '').toLowerCase();
  if (e.includes('html page')) {
    return 'Slack showed a sign-in page instead of the file. If this keeps happening, reconnect Slack in Settings';
  }
  if (/http 40[13]\b/.test(e)) return 'Slack refused to send it. It will be tried again later';
  if (/http 429\b/.test(e)) return 'Slack asked the app to slow down. It will be tried again automatically';
  if (/http 5\d\d\b/.test(e)) return 'Slack couldn’t send it just now. It will be tried again automatically';
  if (/timed out|stalled|network error|incomplete download|empty download/.test(e)) {
    return 'The download was interrupted. It will be tried again automatically';
  }
  return 'It will be tried again automatically';
}

const s = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function attachmentToDTO(a: SlackAttachment): AttachmentDTO {
  return {
    color: normalizeColor(a.color),
    pretext: s(a.pretext),
    authorName: s(a.author_name),
    authorLink: s(a.author_link),
    authorIcon: s(a.author_icon),
    title: s(a.title),
    titleLink: s(a.title_link),
    text: s(a.text),
    fallback: s(a.fallback),
    imageUrl: s(a.image_url),
    thumbUrl: s(a.thumb_url),
    serviceName: s(a.service_name),
    serviceIcon: s(a.service_icon),
    footer: s(a.footer),
    fields: (Array.isArray(a.fields) ? a.fields : []).filter(isObject).map((f) => ({
      title: typeof f.title === 'string' ? f.title : '',
      value: typeof f.value === 'string' ? f.value : '',
      short: f.short === true,
    })),
    fromUrl: s(a.from_url) ?? s(a.original_url),
    isMsgUnfurl: a.is_msg_unfurl === true || a.is_share === true,
    blocks: (Array.isArray(a.blocks) ? a.blocks : []).filter(isObject) as BlockDTO[],
  };
}

/** Slack sends hex colors with or without '#', or the names good/warning/danger. */
function normalizeColor(color: unknown): string | null {
  if (typeof color !== 'string' || !color) return null;
  return /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? `#${color}` : color;
}
