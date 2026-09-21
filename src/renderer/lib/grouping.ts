import type { MessageDTO } from '../../shared/types';
import { tsToMs } from './ts';

/** Consecutive messages by the same author within this window share one header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Channel housekeeping events rendered as compact one-liners rather than full messages. */
export const SYSTEM_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'group_topic',
  'group_purpose',
  'group_name',
  'channel_archive',
  'channel_unarchive',
  'group_archive',
  'group_unarchive',
  'pinned_item',
  'unpinned_item',
  'bot_add',
  'bot_remove',
]);

export function isSystemMessage(message: MessageDTO): boolean {
  return message.subtype != null && SYSTEM_SUBTYPES.has(message.subtype);
}

/** Identity used for grouping: a user, or a bot/integration posting under a given name. */
export function authorKey(message: MessageDTO): string {
  if (message.userId) return `u:${message.userId}`;
  return `b:${message.botId ?? ''}:${message.username ?? ''}`;
}

export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * Whether `message` should render without avatar/name because it continues `prev`.
 * Broadcast replies and system events always get their own header because they read
 * differently from the conversation around them.
 */
export function isContinuation(prev: MessageDTO | undefined, message: MessageDTO): boolean {
  if (!prev) return false;
  if (authorKey(prev) !== authorKey(message)) return false;
  if (isSystemMessage(prev) || isSystemMessage(message)) return false;
  if (message.subtype === 'thread_broadcast' || prev.subtype === 'thread_broadcast') return false;
  const prevMs = tsToMs(prev.ts);
  const ms = tsToMs(message.ts);
  if (localDayKey(prevMs) !== localDayKey(ms)) return false;
  return ms - prevMs >= 0 && ms - prevMs < GROUP_WINDOW_MS;
}

export interface TimelineRow {
  message: MessageDTO;
  continuation: boolean;
}

export interface DayGroup {
  /** Local calendar day key, stable across re-renders (used as React key). */
  key: string;
  date: Date;
  rows: TimelineRow[];
}

/** Splits an ascending message list into local calendar days with grouping flags. */
export function groupByDay(messages: readonly MessageDTO[]): DayGroup[] {
  const days: DayGroup[] = [];
  let current: DayGroup | null = null;
  let prev: MessageDTO | undefined;
  for (const message of messages) {
    const ms = tsToMs(message.ts);
    const key = localDayKey(ms);
    if (!current || current.key !== key) {
      const date = new Date(ms);
      current = { key, date: new Date(date.getFullYear(), date.getMonth(), date.getDate()), rows: [] };
      days.push(current);
      prev = undefined;
    }
    current.rows.push({ message, continuation: isContinuation(prev, message) });
    prev = message;
  }
  return days;
}

/**
 * Best guess for the thread parent of a reply `ts` that the channel view does not contain.
 * Top-level pages never include plain replies, so when a link points at one we look for the
 * closest earlier parent whose thread was still active at that time.
 */
export function guessThreadParent(messages: readonly MessageDTO[], replyTs: string): MessageDTO | null {
  const replyMs = tsToMs(replyTs);
  let best: MessageDTO | null = null;
  for (const m of messages) {
    if (m.replyCount <= 0 || m.isReply) continue;
    const parentMs = tsToMs(m.ts);
    if (parentMs >= replyMs) continue;
    const latest = m.latestReply ? tsToMs(m.latestReply) : Number.POSITIVE_INFINITY;
    if (latest < replyMs) continue;
    if (!best || parentMs > tsToMs(best.ts)) best = m;
  }
  return best;
}

/** Merge pages, dropping duplicates that appear when a page boundary shifted between requests. */
export function dedupeMessages(pages: readonly (readonly MessageDTO[])[]): MessageDTO[] {
  const seen = new Set<string>();
  const out: MessageDTO[] = [];
  for (const page of pages) {
    for (const m of page) {
      if (seen.has(m.ts)) continue;
      seen.add(m.ts);
      out.push(m);
    }
  }
  return out;
}
