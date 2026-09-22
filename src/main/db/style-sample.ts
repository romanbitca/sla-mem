/**
 * Your own recent messages, as a review of your writing reads them (Claude's review on My style):
 * newest first, as they read in Slack (names for mentions, labels for links), notes to yourself,
 * code and quotes left out. Nobody else's words are included.
 */
import { listUsers } from './read';
import { stmt } from './stmt';
import { hasWords, prose, readable } from './style-text';
import type { DB } from './types';

export interface SampleMessage {
  text: string;
  /** 'dm', 'group' (group DM) or 'channel'. */
  where: 'dm' | 'group' | 'channel';
  time: number;
  conversationId: string;
  ts: string;
  threadTs: string | null;
  isReply: boolean;
}

/** Each message is cut to this, so one long post can't crowd out the rest. */
const MAX_MESSAGE_CHARS = 600;

export function styleSample(db: DB, self: string, opts: { limit: number; maxChars: number }): SampleMessage[] {
  const labels = new Map(listUsers(db).map((u) => [u.id, u.label]));
  const out: SampleMessage[] = [];
  let chars = 0;
  for (const m of stmt<{
    conversation_id: string;
    ts: string;
    time: number;
    thread_ts: string | null;
    is_reply: number;
    text: string;
    type: string;
  }>(
    db,
    `SELECT m.conversation_id, m.ts, m.time, m.thread_ts, m.is_reply, m.text, c.type
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.user_id = ? AND (m.subtype IS NULL OR m.subtype = 'thread_broadcast') AND m.is_deleted = 0
       AND NOT (c.type = 'im' AND c.dm_user_id IS ?)
     ORDER BY m.time DESC LIMIT ?`,
  ).all(self, self, opts.limit * 3)) {
    if (!hasWords(prose(m.text))) continue;
    const withoutCode = m.text
      .replace(/```[\s\S]*?```/g, ' [code] ')
      .replace(/`[^`\n]*`/g, '[code]')
      .replace(/^(?:>|&gt;).*$/gm, '');
    let text = readable(withoutCode, labels);
    if (!text) continue;
    if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}…`;
    if (chars + text.length > opts.maxChars) break;
    chars += text.length;
    out.push({
      text,
      where: m.type === 'im' ? 'dm' : m.type === 'mpim' ? 'group' : 'channel',
      time: m.time,
      conversationId: m.conversation_id,
      ts: m.ts,
      threadTs: m.thread_ts,
      isReply: m.is_reply === 1,
    });
    if (out.length >= opts.limit) break;
  }
  return out;
}
