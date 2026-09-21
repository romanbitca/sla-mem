/**
 * "Export conversation" (PLAN §11 Stage 8): one conversation as a Markdown file that reads well in
 * any text editor or Markdown viewer, without the app. Messages are in order under day headings;
 * each thread follows its parent as a quote; edits, deletions, attachments and reactions are
 * noted. The file is written page by page to a temporary name and renamed into place, so a failed
 * or cancelled export never leaves half a file behind.
 */
import fs from 'node:fs';
import type { ConversationDTO, MessageDTO } from '../shared/types';
import {
  blocksToMrkdwn,
  getConversation,
  getMessages,
  getThread,
  listConversations,
  listUsers,
  unescapeEntities,
  type DB,
  type NormalizeResolvers,
} from './db';
import { notFound } from './errors';
import { renameReplacing } from './fsx';
import { sanitizeFileName } from './slack/files';
import type { SlackBlock } from './slack/types';

export interface ExportOptions {
  /** BCP 47 locale and IANA time zone for dates and times; default: the computer's. */
  locale?: string;
  timeZone?: string;
  now?: Date;
  signal?: AbortSignal;
}

export interface ExportResult {
  path: string;
  /** Messages written, thread replies included. */
  messages: number;
}

const PAGE = 200;

/** A file name for the export of `conversation`, safe on every OS. */
export function exportFileName(conversation: ConversationDTO): string {
  return sanitizeFileName(`${conversationTitle(conversation)} (Slack).md`, 'conversation.md');
}

export async function exportConversationMarkdown(
  db: DB,
  conversationId: string,
  file: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const conversation = getConversation(db, conversationId);
  if (!conversation) throw notFound('That conversation isn’t in the archive');
  const writer = new MarkdownWriter(db, opts);
  const tmp = `${file}.${process.pid}.partial`;
  const out = await fs.promises.open(tmp, 'w');
  let messages = 0;
  try {
    await out.write(writer.header(conversation));
    let cursor = '0';
    for (;;) {
      opts.signal?.throwIfAborted();
      const page = getMessages(db, { conversationId, after: cursor, limit: PAGE });
      let chunk = '';
      for (const m of page.messages) {
        chunk += writer.message(m);
        // A reply also sent to the channel shows in both places, as in Slack; count it once.
        if (!m.isReply) messages += 1;
        if (m.threadTs === m.ts) {
          const { replies } = getThread(db, conversationId, m.ts);
          chunk += writer.thread(m, replies);
          messages += replies.length;
        }
      }
      await out.write(chunk);
      if (!page.hasMoreAfter || !page.messages.length) break;
      cursor = page.messages[page.messages.length - 1].ts;
    }
    // Replies whose thread start was never archived (it fell out of Slack's window first).
    const orphans = orphanThreads(db, conversationId);
    if (orphans.length) {
      await out.write('\n---\n\n## Replies to threads that aren’t in the archive\n');
      for (const root of orphans) {
        opts.signal?.throwIfAborted();
        const { replies } = getThread(db, conversationId, root);
        await out.write(writer.thread(null, replies));
        messages += replies.length;
      }
    }
    if (messages === 0) await out.write('_No messages archived yet._\n');
    await out.close();
    await renameReplacing(tmp, file);
    return { path: file, messages };
  } catch (err) {
    await out.close().catch(() => undefined);
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

function orphanThreads(db: DB, conversationId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.thread_ts AS root FROM messages r
       WHERE r.conversation_id = ? AND r.is_reply = 1 AND r.thread_ts IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.conversation_id = r.conversation_id AND p.ts = r.thread_ts)
       ORDER BY r.thread_ts`,
    )
    .all(conversationId) as { root: string }[];
  return rows.map((r) => r.root);
}

function conversationTitle(c: ConversationDTO): string {
  return c.type === 'channel' || c.type === 'private_channel' ? `#${c.label}` : c.label;
}

class MarkdownWriter {
  private readonly users: Map<string, string>;
  private readonly resolvers: NormalizeResolvers;
  private readonly day: Intl.DateTimeFormat;
  private readonly date: Intl.DateTimeFormat;
  private readonly time: Intl.DateTimeFormat;
  private lastDay = '';

  constructor(
    db: DB,
    private readonly opts: ExportOptions,
  ) {
    this.users = new Map(listUsers(db).map((u) => [u.id, u.label]));
    const channels = new Map(listConversations(db).map((c) => [c.id, c.label]));
    this.resolvers = {
      userLabel: (id) => this.users.get(id),
      channelName: (id) => channels.get(id),
    };
    const zone = { timeZone: opts.timeZone };
    this.day = new Intl.DateTimeFormat(opts.locale, {
      ...zone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    this.date = new Intl.DateTimeFormat(opts.locale, { ...zone, year: 'numeric', month: 'long', day: 'numeric' });
    this.time = new Intl.DateTimeFormat(opts.locale, { ...zone, hour: '2-digit', minute: '2-digit' });
  }

  header(c: ConversationDTO): string {
    const facts = [`Exported from Slack Archive on ${this.date.format(this.opts.now ?? new Date())}`];
    if (c.oldestTs && c.latestTs) {
      facts.push(`${this.date.format(tsDate(c.oldestTs))} – ${this.date.format(tsDate(c.latestTs))}`);
    }
    const lines = [`# ${conversationTitle(c)}`, '', facts.join(' · ')];
    const about = [];
    if (c.topic) about.push(`> **Topic:** ${this.inline(c.topic)}`);
    if (c.purpose) about.push(`> **Purpose:** ${this.inline(c.purpose)}`);
    if (about.length) lines.push('', about.join('\n>\n'));
    return lines.join('\n') + '\n';
  }

  message(m: MessageDTO): string {
    const when = tsDate(m.ts);
    const day = this.day.format(when);
    let out = '';
    if (day !== this.lastDay) {
      this.lastDay = day;
      out += `\n## ${day}\n`;
    }
    const intro = m.subtype === 'thread_broadcast' ? '_Replied to a thread:_ ' : '';
    return `${out}\n${this.heading(m, this.time.format(when))}\n\n${intro}${this.body(m)}`;
  }

  /** A thread's replies as a quote under its parent (or on their own when the parent is missing). */
  thread(parent: MessageDTO | null, replies: MessageDTO[]): string {
    if (!replies.length) return '';
    const parentDay = parent ? this.day.format(tsDate(parent.ts)) : '';
    const lines = [`**Thread: ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}**`];
    for (const r of replies) {
      const when = tsDate(r.ts);
      const day = this.day.format(when);
      // Replies on another day than the parent say which day.
      const stamp = day === parentDay ? this.time.format(when) : `${this.date.format(when)}, ${this.time.format(when)}`;
      lines.push('', this.heading(r, stamp), '', this.body(r).trimEnd());
    }
    return '\n' + quote(lines.join('\n')) + '\n';
  }

  private heading(m: MessageDTO, stamp: string): string {
    const notes = [];
    if (m.editedTs) notes.push('_edited_');
    if (m.isDeleted) notes.push('_deleted in Slack_');
    return [`**${this.author(m)}**`, stamp, ...notes].join(' · ');
  }

  private author(m: MessageDTO): string {
    if (m.userId) return this.users.get(m.userId) ?? m.username ?? m.userId;
    return m.username ?? 'App';
  }

  private body(m: MessageDTO): string {
    const mrkdwn = (m.blocks.length ? blocksToMrkdwn(m.blocks as SlackBlock[]) : '') || m.text;
    const parts = [mrkdwnToMarkdown(mrkdwn, this.resolvers)];
    for (const a of m.attachments) {
      const lines: string[] = [];
      if (a.pretext) lines.push(mrkdwnToMarkdown(a.pretext, this.resolvers));
      if (a.title) lines.push(a.titleLink ? `**[${a.title}](${a.titleLink})**` : `**${a.title}**`);
      const text = a.text || (!a.title && !a.pretext ? a.fallback : null);
      if (text) lines.push(mrkdwnToMarkdown(text, this.resolvers));
      for (const f of a.fields) lines.push(`**${f.title}:** ${mrkdwnToMarkdown(f.value, this.resolvers)}`);
      if (lines.length) parts.push(quote(lines.join('\n\n')));
    }
    if (m.files.length) {
      parts.push(
        m.files
          .map((f) => `📎 ${f.name ?? f.title ?? 'file'} (${f.available ? 'archived' : 'not archived'})`)
          .join('  \n'),
      );
    }
    if (m.reactions.length) {
      parts.push('Reactions: ' + m.reactions.map((r) => `:${r.name}: ${r.count}`).join(' · '));
    }
    return (
      parts
        .filter((p) => p.trim())
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n') + '\n'
    );
  }

  private inline(mrkdwn: string): string {
    return mrkdwnToMarkdown(mrkdwn, this.resolvers).replace(/\s*\n\s*/g, ' ');
  }
}

function tsDate(ts: string): Date {
  return new Date(Math.floor(Number(ts) * 1000));
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

// ─── mrkdwn → Markdown ─────────────────────────────────────────────────────────────────────────

const CODE = /(```[\s\S]*?```|`[^`\n]+`)/g;
// Slack's rule for a marker pair (see normalize.ts): it hugs non-space text on word boundaries,
// which keeps snake_case_words and 2*3*4 intact.
const FORMAT_PAIR = /(^|[^\p{L}\p{N}])([*_~])(?=\S)([^\n]*?\S)\2(?![\p{L}\p{N}])/gu;
const MARKDOWN_MARKER: Record<string, string> = { '*': '**', _: '_', '~': '~~' };

/**
 * Slack mrkdwn → Markdown: references resolved to names and links, `*bold*` → `**bold**`,
 * `~strike~` → `~~strike~~`, code kept verbatim (block code on its own fenced lines), entities
 * unescaped, and Slack's single line breaks kept as Markdown hard breaks.
 */
export function mrkdwnToMarkdown(mrkdwn: string, r: NormalizeResolvers): string {
  const out = mrkdwn
    .split(CODE)
    .map((part, i) => {
      if (i % 2 === 0) return textToMarkdown(part, r);
      if (part.startsWith('```')) {
        const code = unescapeEntities(part.slice(3, -3)).replace(/^\n+|\n+$/g, '');
        return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
      }
      return unescapeEntities(part);
    })
    .join('');
  return out
    .replace(/ +(\n\n```)/g, '$1')
    .replace(/(```\n\n) +/g, '$1')
    .replace(/^\n+|\n+$/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

function textToMarkdown(text: string, r: NormalizeResolvers): string {
  const resolved = text.replace(/<([^<>\n]*)>/g, (_m, body: string) => referenceToMarkdown(body, r));
  const formatted = resolved.replace(
    FORMAT_PAIR,
    (_m, before: string, marker: string, inner: string) =>
      `${before}${MARKDOWN_MARKER[marker]}${inner}${MARKDOWN_MARKER[marker]}`,
  );
  // A lone newline is a line break in Slack but not in Markdown: end the line with two spaces.
  return unescapeEntities(formatted).replace(/([^\n])\n(?=[^\n])/g, '$1  \n');
}

function referenceToMarkdown(body: string, r: NormalizeResolvers): string {
  const pipe = body.indexOf('|');
  const target = pipe >= 0 ? body.slice(0, pipe) : body;
  const label = pipe >= 0 ? body.slice(pipe + 1) : '';
  if (target.startsWith('@')) return '@' + (r.userLabel(target.slice(1)) || label || target.slice(1));
  if (target.startsWith('#')) return '#' + (r.channelName(target.slice(1)) || label || target.slice(1));
  if (target.startsWith('!')) {
    const [kind, id = ''] = target.slice(1).split('^');
    if (kind === 'here' || kind === 'channel' || kind === 'everyone') return `@${kind}`;
    if (kind === 'subteam') return label || `@${id}`;
    if (kind === 'date') return label;
    return label || `@${kind}`;
  }
  if (!/^(https?:|mailto:)/i.test(target)) return label || target;
  return label && label !== target ? `[${label}](${target})` : `<${target}>`;
}
