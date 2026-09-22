/**
 * What Claude can do with the archive while answering an Ask AI question: search it, open a
 * message with its thread or surroundings, read a conversation over a period, and see where
 * the activity was. Everything runs here against the local database; only the compact text these
 * tools return is sent to Anthropic, and only while answering a question the reader asked.
 *
 * Every message a tool shows is numbered, and keeps its number for the whole chat ([12]). The
 * answer cites those numbers, and the window gets the messages behind them as sources.
 *
 * The text is written to be cheap to read: one line per message, whitespace collapsed, long
 * messages shortened, local dates without seconds.
 */
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  AiScopeDTO,
  AiSourceDTO,
  AiStepDTO,
  ConversationDTO,
  MessageDTO,
  SearchSort,
  UserDTO,
} from '../../shared/types';
import {
  addDays,
  conversationActivity,
  getMessages,
  getMeta,
  getThread,
  hydrateMessages,
  listConversations,
  listUsers,
  loadSearchResolvers,
  localDayStartSeconds,
  messageRowIds,
  parseDay,
  plainTexts,
  search,
  threadReplies,
  topLevelInRange,
  tsAtSecond,
  type DB,
} from '../db';

// ─── tool definitions (what Claude reads; stable, so the prompt cache keeps them) ────────────────

export const TOOLS: BetaTool[] = [
  {
    name: 'search_messages',
    description:
      'Search the archive. Use it first for anything about what was said, and again with other words when the results miss. ' +
      'Slack search syntax: words are prefix-matched and all must appear (test finds tests, testing), so put ' +
      'alternatives in any_words; "exact phrase"; -word; ' +
      'from:name or from:me; in:#channel; in:@name (DMs with that person); in:<conversation id>; ' +
      'after:/before:/on:YYYY-MM-DD; during:YYYY-MM; has:link|file|image|reaction|thread; is:thread. ' +
      'Returns numbered messages.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'e.g. "test from:ana after:2026-03-01"' },
        any_words: {
          type: 'array',
          items: { type: 'string' },
          description:
            'At least one of these must appear too (prefix-matched): the ways the author may have put the key ' +
            'word, synonyms and translations, as short stems, e.g. ["distribut", "assign", "gave", "hand", "transfer"]',
        },
        sort: { type: 'string', enum: ['relevance', 'newest', 'oldest'], description: 'Default relevance' },
        limit: { type: 'integer', description: '1-50, default 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_message',
    description:
      'Read a numbered message in full with what surrounds it: its whole thread when it is in one, otherwise the ' +
      'messages just before and after it. Use it to check a search result or to see the discussion around it.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'The message number, e.g. 12 for [12]' },
        context: {
          type: 'integer',
          description: 'Messages before and after it when it is not in a thread, 0-20, default 5',
        },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_conversation',
    description:
      'Read a conversation in order, thread replies included, for summaries and recaps. Without dates you get its ' +
      'latest messages.',
    input_schema: {
      type: 'object',
      properties: {
        conversation: {
          type: 'string',
          description: '#channel, @person (your DMs with them), or a conversation id from list_conversations',
        },
        after: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        before: { type: 'string', description: 'YYYY-MM-DD, exclusive' },
        limit: { type: 'integer', description: 'Messages, 1-200, default 80' },
      },
      required: ['conversation'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_conversations',
    description:
      'List conversations by how many messages they had, busiest first, optionally in a date range or by name. ' +
      'Use it for recaps ("what happened this week") and to look up a conversation or person.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Only conversations whose name or DM partner contains this' },
        after: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        before: { type: 'string', description: 'YYYY-MM-DD, exclusive' },
        limit: { type: 'integer', description: '1-50, default 20' },
      },
      additionalProperties: false,
    },
  },
];

// ─── numbering ───────────────────────────────────────────────────────────────────────────────

/** Numbers for the messages a chat has shown Claude, stable for the whole chat. */
export class SourceRefs {
  private readonly numbers = new Map<string, number>();
  private readonly messages = new Map<number, Pick<MessageDTO, 'conversationId' | 'ts'>>();
  private next = 1;

  /** The message's number, and whether it was given one just now. */
  number(message: MessageDTO): { ref: number; fresh: boolean } {
    const key = `${message.conversationId}:${message.ts}`;
    const known = this.numbers.get(key);
    if (known != null) return { ref: known, fresh: false };
    const ref = this.next++;
    this.numbers.set(key, ref);
    this.messages.set(ref, { conversationId: message.conversationId, ts: message.ts });
    return { ref, fresh: true };
  }

  lookup(ref: number): Pick<MessageDTO, 'conversationId' | 'ts'> | null {
    return this.messages.get(ref) ?? null;
  }
}

// ─── running a tool ──────────────────────────────────────────────────────────────────────────

export interface ToolContext {
  db: DB;
  refs: SourceRefs;
  now: Date;
  /** What the reader limited the question to; the tools never look outside it. */
  scope?: AiScopeDTO | null;
}

export interface ToolOutcome {
  /** What Claude reads. */
  content: string;
  isError: boolean;
  /** The line shown above the answer; null for a call that was only a mistake. */
  step: AiStepDTO | null;
  /** Messages numbered for the first time by this call. */
  sources: AiSourceDTO[];
}

/** Invalid input from the model: explained back to it, never shown as a step. */
class ToolInputError extends Error {}

export function runTool(ctx: ToolContext, name: string, input: unknown): ToolOutcome {
  try {
    const args = isRecord(input) ? input : {};
    switch (name) {
      case 'search_messages':
        return searchMessages(ctx, args);
      case 'open_message':
        return openMessage(ctx, args);
      case 'read_conversation':
        return readConversation(ctx, args);
      case 'list_conversations':
        return listActivity(ctx, args);
      default:
        throw new ToolInputError(`There is no tool called ${name}.`);
    }
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, isError: true, step: null, sources: [] };
    throw err;
  }
}

// ─── search_messages ─────────────────────────────────────────────────────────────────────────

const SEARCH_TEXT_MAX = 400;

function searchMessages(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const query = text(args.query, 'query', 500).trim();
  const anyWords = words(args.any_words, 'any_words');
  if (!query && !anyWords.length) throw new ToolInputError('query is empty.');
  const sort = oneOf<SearchSort>(args.sort, ['relevance', 'newest', 'oldest'], 'sort') ?? 'relevance';
  const limit = integer(args.limit, 'limit', 1, 50) ?? 20;
  const response = search(
    ctx.db,
    { q: query, sort, limit },
    { now: ctx.now, within: activeScope(ctx) ?? undefined, anyOf: anyWords },
  );
  const alternatives = anyWords.length ? `one of ${clip(anyWords.join(', '), 60)}` : '';
  const step: AiStepDTO = {
    kind: 'search',
    label: query
      ? `Searched “${clip(query, 80)}”${alternatives ? ` + ${alternatives}` : ''}`
      : `Searched for ${alternatives}`,
    detail: null,
  };

  if (response.parsed.unresolved.length) {
    step.detail = 'no match for a name or date';
    return {
      content: unresolvedHelp(ctx.db, response.parsed.unresolved),
      isError: false,
      step,
      sources: [],
    };
  }
  step.detail = response.total === 0 ? 'nothing found' : plural(response.total, 'result');
  if (response.total === 0) {
    const limits = describeScope(ctx.db, activeScope(ctx));
    return {
      content: limits
        ? `No messages match within the user's limits (${limits}). Try other or fewer words; nothing outside the limits can be searched.`
        : 'No messages match. Try other or fewer words, or fewer filters.',
      isError: false,
      step,
      sources: [],
    };
  }

  const names = namesOf(ctx.db);
  const shown = new Shown(ctx);
  const texts = textsOf(
    ctx.db,
    response.hits.map((h) => h.message),
  );
  const lines = [
    `${plural(response.total, 'match', 'matches')}${response.total > response.hits.length ? `, showing ${response.hits.length}` : ''} (${SORT_LABEL[sort]}):`,
  ];
  for (const hit of response.hits) {
    const m = hit.message;
    const full = oneLine(texts.get(m) ?? '');
    const body =
      full.length <= SEARCH_TEXT_MAX ? full : `${oneLine(hit.snippet.replace(/[\u0002\u0003]/g, ''))} [long message]`;
    const about = [names.place(m.conversationId), names.author(m), dateTime(m.ts), threadNote(m)].filter(Boolean);
    lines.push(`[${shown.add(m)}] ${about.join(' · ')}`, body || '(no text)');
  }
  return { content: lines.join('\n'), isError: false, step, sources: shown.sources };
}

const SORT_LABEL: Record<SearchSort, string> = {
  relevance: 'most relevant first',
  newest: 'newest first',
  oldest: 'oldest first',
};

/** Modifiers the search couldn't resolve, with the names that come closest. */
function unresolvedHelp(db: DB, unresolved: readonly string[]): string {
  const lines = [`Nothing matches ${unresolved.join(', ')}, so the search found nothing.`];
  for (const raw of unresolved) {
    const colon = raw.indexOf(':');
    const key = raw.slice(0, colon).toLowerCase();
    const value = raw.slice(colon + 1).replace(/^["#@]|"$/g, '');
    if (key.startsWith('-')) {
      lines.push(`Leaving out with ${key}: isn’t supported; search without it.`);
    } else if (key === 'from' || (key === 'in' && raw.includes('@'))) {
      const people = similarPeople(db, value);
      lines.push(
        people.length
          ? `People with a similar name: ${people.join(', ')}.`
          : `No person is called anything like “${value}”.`,
      );
    } else if (key === 'in') {
      const places = similarConversations(db, value);
      lines.push(
        places.length
          ? `Conversations with a similar name: ${places.join(', ')}.`
          : `No conversation is called anything like “${value}”.`,
      );
    } else if (['after', 'before', 'on', 'during'].includes(key)) {
      lines.push('Dates are YYYY-MM-DD (or today, yesterday); during: also takes YYYY-MM or YYYY.');
    } else if (key === 'has') {
      lines.push('has: takes link, file, image, reaction or thread.');
    } else if (key === 'is') {
      lines.push('is: takes only thread.');
    }
  }
  return lines.join('\n');
}

function similarPeople(db: DB, value: string): string[] {
  return listUsers(db)
    .filter((u) => !u.deleted && isSimilar(value, [u.name, u.displayName, u.realName]))
    .slice(0, 6)
    .map((u) => `${u.label} (from:${u.name})`);
}

function similarConversations(db: DB, value: string): string[] {
  return listConversations(db)
    .filter((c) => c.type !== 'im' && isSimilar(value, [c.rawName, c.label]))
    .slice(0, 6)
    .map((c) => (c.type === 'mpim' ? `group DM with ${c.label} (in:${c.id})` : `#${c.rawName ?? c.label}`));
}

/**
 * Close enough to suggest: one contains the other, or a word of the name starts like the value
 * ("alicia" → alice, ali; "gen" → general).
 */
function isSimilar(value: string, names: readonly (string | null)[]): boolean {
  const v = value.toLowerCase();
  if (v.length < 2) return false;
  return names.some((name) => {
    if (!name) return false;
    const n = name.toLowerCase();
    if (n.includes(v)) return true;
    return n
      .split(/[\s._-]+/)
      .some((word) => word.length >= 3 && (v.includes(word) || word.slice(0, 3) === v.slice(0, 3)));
  });
}

// ─── open_message ────────────────────────────────────────────────────────────────────────────

/** A thread longer than this shows its first reply, the numbered one, and those around it. */
const THREAD_MAX = 60;

function openMessage(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const ref = integer(args.ref, 'ref', 1, Number.MAX_SAFE_INTEGER);
  if (ref == null) throw new ToolInputError('ref is required: the number of a message you were shown, e.g. 12.');
  const context = integer(args.context, 'context', 0, 20) ?? 5;
  const target = ctx.refs.lookup(ref);
  if (!target) throw new ToolInputError(`No message has the number ${ref}. Use a number you were shown.`);
  const [message] = hydrateMessages(ctx.db, messageRowIds(ctx.db, [target]));
  if (!message) throw new ToolInputError(`Message ${ref} is no longer in the archive.`);

  const names = namesOf(ctx.db);
  const shown = new Shown(ctx);
  const place = names.place(message.conversationId);
  const threadTs = message.threadTs && (message.isReply || message.replyCount > 0) ? message.threadTs : null;
  let lines: string[];
  let label: string;
  if (threadTs) {
    const thread = getThread(ctx.db, message.conversationId, threadTs);
    let replies = thread.replies;
    let note = '';
    if (replies.length > THREAD_MAX) {
      const at = Math.max(
        0,
        replies.findIndex((r) => r.ts === message.ts),
      );
      const start = Math.max(1, Math.min(at - THREAD_MAX / 2, replies.length - THREAD_MAX + 1));
      note = `, showing the first and ${THREAD_MAX - 1} around [${ref}]`;
      replies = [replies[0], ...replies.slice(start, start + THREAD_MAX - 1)];
    }
    const parent = thread.parent;
    const starter = parent ? `, started by ${names.author(parent)}` : '';
    lines = [`Thread in ${place}${starter} (${plural(thread.replies.length, 'reply', 'replies')}${note}):`];
    lines.push(...messageLines(ctx, shown, names, parent ? [parent, ...replies] : replies, { indentReplies: true }));
    label = `Read a thread in ${place}`;
  } else {
    const page = getMessages(ctx.db, {
      conversationId: message.conversationId,
      around: message.ts,
      limit: context * 2 + 1,
    });
    lines = [`${capitalize(place)}, around [${ref}]:`, ...messageLines(ctx, shown, names, page.messages)];
    label = `Read around a message in ${place}`;
  }
  return {
    content: lines.join('\n'),
    isError: false,
    step: { kind: 'read', label, detail: null },
    sources: shown.sources,
  };
}

// ─── read_conversation ───────────────────────────────────────────────────────────────────────

/** Replies shown under each thread parent when reading a whole stretch of a conversation. */
const REPLIES_PER_THREAD = 30;
/** Roughly 8k tokens: past this a read stops and says how to see the rest. */
const READ_MAX_CHARS = 32_000;

function readConversation(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const conversation = resolveConversation(ctx.db, text(args.conversation, 'conversation', 200));
  const scope = activeScope(ctx);
  if (scope?.conversationIds.length && !scope.conversationIds.includes(conversation.id)) {
    throw new ToolInputError(
      `The user limited this question to ${describeConversations(ctx.db, scope.conversationIds)}; ${namesOf(ctx.db).place(conversation.id)} isn’t one of them.`,
    );
  }
  const range = narrowRange(dayRange(args, ctx.now), scope);
  const limit = integer(args.limit, 'limit', 1, 200) ?? 80;
  const names = namesOf(ctx.db);
  const shown = new Shown(ctx);
  const place = names.place(conversation.id);
  const latest = range.after == null;
  const top = topLevelInRange(ctx.db, conversation.id, {
    after: range.after == null ? null : tsAtSecond(localDayStartSeconds(range.after)),
    before: range.before == null ? null : tsAtSecond(localDayStartSeconds(range.before)),
    limit,
    latest,
  });

  // Whole threads are kept together, within a message count and a text budget. Reading the
  // latest messages, the newest win the budget; reading from a date, the oldest do.
  const parents = hydrateMessages(
    ctx.db,
    top.rows.map((r) => r.id),
  );
  const picked: Line[][] = [];
  let count = 0;
  let chars = 0;
  let cut = false;
  for (const parent of latest ? [...parents].reverse() : parents) {
    if (count >= limit || chars > READ_MAX_CHARS) {
      cut = true;
      break;
    }
    const group: Line[] = [parent];
    if (parent.replyCount > 0 && !parent.isReply) {
      const replies = threadReplies(ctx.db, conversation.id, parent.ts, REPLIES_PER_THREAD);
      group.push(...hydrateMessages(ctx.db, replies.ids));
      const more = replies.total - replies.ids.length;
      if (more > 0)
        group.push({ note: `(${plural(more, 'more reply', 'more replies')}: open_message [{ref}])`, about: parent });
    }
    const messages = group.filter((l): l is MessageDTO => !('note' in l));
    for (const text of textsOf(ctx.db, messages).values()) chars += Math.min(text.length, READ_TEXT_MAX) + 40;
    count += messages.length;
    picked.push(group);
  }
  if (latest) picked.reverse();
  const days: DayState = { last: '' };
  const lines = picked.flatMap((group) => messageLines(ctx, shown, names, group, { indentReplies: true, days }));

  const period = describeRange(range);
  const detail = count === 0 ? 'no messages' : plural(count, 'message');
  const head =
    count === 0
      ? `${capitalize(place)} has no messages${period ? ` ${period}` : ''}.`
      : `${capitalize(place)}${period ? `, ${period}` : ''}: ${plural(count, 'message')}` +
        (cut || top.more
          ? latest
            ? ' (the latest ones; give dates for earlier messages).'
            : ' (the first ones; read from a later date for the rest).'
          : '.');
  return {
    content: [head, ...lines].join('\n'),
    isError: false,
    step: { kind: 'read', label: `Read ${place}${period ? `, ${period}` : ''}`, detail },
    sources: shown.sources,
  };
}

function resolveConversation(db: DB, raw: string): ConversationDTO {
  const value = raw.trim();
  if (!value) throw new ToolInputError('conversation is empty.');
  const resolvers = loadSearchResolvers(db);
  let ids: string[];
  if (value.startsWith('@')) ids = resolvers.dmConversations(resolvers.resolveUsers(value.slice(1)));
  else if (value.startsWith('#')) ids = resolvers.resolveConversations(value.slice(1));
  else {
    ids = resolvers.resolveConversations(value);
    if (!ids.length) ids = resolvers.dmConversations(resolvers.resolveUsers(value));
  }
  const all = listConversations(db);
  const found = all.filter((c) => ids.includes(c.id));
  if (found.length === 1) return found[0];
  const names = namesOf(db);
  if (found.length > 1) {
    const options = found.slice(0, 8).map((c) => `${names.place(c.id)} (${c.id})`);
    throw new ToolInputError(`Several conversations match “${value}”: ${options.join(', ')}. Pass the id.`);
  }
  const similar = similarConversations(db, value.replace(/^[#@]/, ''));
  throw new ToolInputError(
    `No conversation matches “${value}”.${similar.length ? ` Similar: ${similar.join(', ')}.` : ''} list_conversations shows them all.`,
  );
}

// ─── list_conversations ──────────────────────────────────────────────────────────────────────

function listActivity(ctx: ToolContext, args: Record<string, unknown>): ToolOutcome {
  const needle = args.name == null ? '' : text(args.name, 'name', 200).trim().toLowerCase().replace(/^[#@]/, '');
  const scope = activeScope(ctx);
  const range = narrowRange(dayRange(args, ctx.now), scope);
  const limit = integer(args.limit, 'limit', 1, 50) ?? 20;
  const names = namesOf(ctx.db);
  const byId = new Map(listConversations(ctx.db).map((c) => [c.id, c]));
  const only = scope?.conversationIds.length ? new Set(scope.conversationIds) : null;
  const activity = conversationActivity(ctx.db, {
    after: range.after == null ? null : localDayStartSeconds(range.after),
    before: range.before == null ? null : localDayStartSeconds(range.before),
    userIds: scope?.userIds,
    limit: needle || only ? 10_000 : limit,
  }).filter((a) => {
    const c = byId.get(a.conversationId);
    if (!c || (only && !only.has(c.id))) return false;
    return !needle || `${c.rawName ?? ''} ${c.label}`.toLowerCase().includes(needle);
  });
  const rows = activity.slice(0, limit);
  const period = describeRange(range);
  const head = rows.length
    ? `Conversations${period ? ` ${period}` : ''}${needle ? ` matching “${needle}”` : ''}, busiest first:`
    : `No conversations${needle ? ` matching “${needle}”` : ''} have messages${period ? ` ${period}` : ''}.`;
  const lines = rows.map(
    (a) =>
      `${capitalize(names.place(a.conversationId))} (${a.conversationId}): ${plural(a.messages, 'message')}` +
      (a.latestTs ? `, latest ${dateOnly(a.latestTs)}` : ''),
  );
  return {
    content: [head, ...lines].join('\n'),
    isError: false,
    step: {
      kind: 'list',
      label: `Looked at the busiest conversations${period ? ` ${period}` : ''}`,
      detail: plural(rows.length, 'conversation'),
    },
    sources: [],
  };
}

// ─── writing messages for Claude ─────────────────────────────────────────────────────────────

/** Message text is shortened past this in reads (long pastes, logs). */
const READ_TEXT_MAX = 1_500;

/** Numbers messages as they are shown, collecting the new ones for the window. */
class Shown {
  readonly sources: AiSourceDTO[] = [];
  constructor(private readonly ctx: ToolContext) {}
  add(message: MessageDTO): number {
    const { ref, fresh } = this.ctx.refs.number(message);
    if (fresh) this.sources.push({ ref, message });
    return ref;
  }
}

/** A message, or a note ("12 more replies"); `{ref}` in a note becomes the number of `about`. */
type Line = MessageDTO | { note: string; about?: MessageDTO };

/** Plain text of each message (mentions resolved, no markup), by message. */
function textsOf(db: DB, messages: readonly MessageDTO[]): Map<MessageDTO, string> {
  const ids = messages.map((m) => messageRowIds(db, [m])[0]);
  const texts = plainTexts(
    db,
    ids.filter((id): id is number => id != null),
  );
  const out = new Map<MessageDTO, string>();
  messages.forEach((m, i) => {
    const id = ids[i];
    if (id != null) out.set(m, texts.get(id) ?? '');
  });
  return out;
}

/** The last date written, so a date is only repeated when it changes (across calls, too). */
interface DayState {
  last: string;
}

/** One line per message: `[n] date time Author: text`, the date only when it changes. */
function messageLines(
  ctx: ToolContext,
  shown: Shown,
  names: Names,
  lines: readonly Line[],
  opts: { indentReplies?: boolean; days?: DayState } = {},
): string[] {
  const messages = lines.filter((l): l is MessageDTO => !('note' in l));
  const texts = textsOf(ctx.db, messages);
  const days = opts.days ?? { last: '' };
  return lines.map((m) => {
    if ('note' in m) return `  ${m.about ? m.note.replace('{ref}', String(shown.add(m.about))) : m.note}`;
    const indent = opts.indentReplies && m.isReply ? '  ' : '';
    const day = dateOnly(m.ts);
    const when = day === days.last ? timeOnly(m.ts) : dateTime(m.ts);
    days.last = day;
    const body = shorten(oneLine(texts.get(m) ?? ''), READ_TEXT_MAX) || '(no text)';
    const extras = [
      !m.isReply && m.replyCount > 0 && !opts.indentReplies ? plural(m.replyCount, 'reply', 'replies') : null,
      m.files.length ? plural(m.files.length, 'file') : null,
      m.isDeleted ? 'deleted in Slack' : null,
    ].filter(Boolean);
    return `${indent}[${shown.add(m)}] ${when} ${names.author(m)}: ${body}${extras.length ? ` (${extras.join(', ')})` : ''}`;
  });
}

interface Names {
  author(message: MessageDTO): string;
  place(conversationId: string): string;
}

/** Who wrote a message and where, as Claude should read it: the reader themself is "You". */
function namesOf(db: DB): Names {
  const self = getMeta(db, 'self_user_id');
  const users = new Map<string, UserDTO>(listUsers(db).map((u) => [u.id, u]));
  const conversations = new Map(listConversations(db).map((c) => [c.id, c]));
  const person = (id: string) => (id === self ? 'You' : (users.get(id)?.label ?? id));
  return {
    author: (m) => (m.userId ? person(m.userId) : (m.username ?? 'an app')),
    place: (id) => {
      const c = conversations.get(id);
      if (!c) return id;
      switch (c.type) {
        case 'im':
          return c.dmUserId === self ? 'your notes to yourself' : `DM with ${c.label}`;
        case 'mpim':
          return `group DM with ${c.label}`;
        default:
          return `#${c.rawName ?? c.label}`;
      }
    },
  };
}

function threadNote(m: MessageDTO): string | null {
  if (m.isReply) return m.subtype === 'thread_broadcast' ? 'thread reply, also sent to the channel' : 'thread reply';
  return m.replyCount > 0 ? plural(m.replyCount, 'reply', 'replies') : null;
}

// ─── the reader's limits ─────────────────────────────────────────────────────────────────────

/** The scope when it limits anything, else null. */
function activeScope(ctx: ToolContext): AiScopeDTO | null {
  const s = ctx.scope;
  if (!s) return null;
  return s.conversationIds.length || s.userIds.length || s.after || s.before ? s : null;
}

/** "#eng, DM with Ana; messages by Ana Pop; 2026-09-14 to 2026-09-20", or null for none. */
export function describeScope(db: DB, scope: AiScopeDTO | null | undefined): string | null {
  if (!scope) return null;
  const parts: string[] = [];
  if (scope.conversationIds.length) parts.push(describeConversations(db, scope.conversationIds));
  if (scope.userIds.length) {
    const self = getMeta(db, 'self_user_id');
    const users = new Map(listUsers(db).map((u) => [u.id, u]));
    const who = scope.userIds.map((id) => (id === self ? 'the user' : (users.get(id)?.label ?? id)));
    parts.push(`messages by ${who.join(', ')}`);
  }
  const period = describeRange({ after: scope.after, before: scope.before });
  if (period) parts.push(period);
  return parts.length ? parts.join('; ') : null;
}

function describeConversations(db: DB, ids: readonly string[]): string {
  const names = namesOf(db);
  const places = ids.slice(0, 12).map((id) => names.place(id));
  return ids.length > 12 ? `${places.join(', ')} and ${ids.length - 12} more` : places.join(', ');
}

/** A requested range narrowed to the reader's dates. */
function narrowRange(range: DayRange, scope: AiScopeDTO | null): DayRange {
  if (!scope) return range;
  const after =
    [range.after, scope.after]
      .filter((d): d is string => !!d)
      .sort()
      .pop() ?? null;
  const before = [range.before, scope.before].filter((d): d is string => !!d).sort()[0] ?? null;
  if (after && before && after >= before) {
    throw new ToolInputError(
      `That period is outside the user's dates (${describeRange({ after: scope.after, before: scope.before })}).`,
    );
  }
  return { after, before };
}

// ─── small helpers ───────────────────────────────────────────────────────────────────────────

interface DayRange {
  after: string | null;
  before: string | null;
}

function dayRange(args: Record<string, unknown>, now: Date): DayRange {
  const day = (v: unknown, name: string): string | null => {
    if (v == null || v === '') return null;
    const parsed = typeof v === 'string' ? parseDay(v.trim(), now) : null;
    if (!parsed) throw new ToolInputError(`${name} must be a date like 2026-03-14.`);
    return parsed;
  };
  const range = { after: day(args.after, 'after'), before: day(args.before, 'before') };
  if (range.after && range.before && range.after >= range.before) {
    throw new ToolInputError('after must be earlier than before (before is exclusive).');
  }
  return range;
}

function describeRange(r: DayRange): string {
  if (r.after && r.before) return `${r.after} to ${addDays(r.before, -1)}`;
  if (r.after) return `since ${r.after}`;
  if (r.before) return `before ${r.before}`;
  return '';
}

const pad = (n: number) => String(n).padStart(2, '0');
const tsDate = (ts: string) => new Date(Math.round(parseFloat(ts) * 1000));

function dateOnly(ts: string): string {
  const d = tsDate(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeOnly(ts: string): string {
  const d = tsDate(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dateTime(ts: string): string {
  return `${dateOnly(ts)} ${timeOnly(ts)}`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** At most `max` code points, cut at a word when one is near. */
function shorten(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.8 ? cut.slice(0, space) : cut}… [cut]`;
}

/** A label no longer than `max` code points. */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string') throw new ToolInputError(`${name} must be text.`);
  if (v.length > max) throw new ToolInputError(`${name} is too long.`);
  return v.replace(/\0/g, '');
}

function integer(v: unknown, name: string, min: number, max: number): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ToolInputError(`${name} must be a whole number.`);
  return Math.min(max, Math.max(min, n));
}

/** A short list of short words (any_words). */
function words(v: unknown, name: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ToolInputError(`${name} must be a list of words.`);
  if (v.length > 30) throw new ToolInputError(`${name} takes at most 30 words.`);
  return [...new Set(v.map((w) => text(w, name, 60).trim()).filter(Boolean))];
}

function oneOf<T extends string>(v: unknown, values: readonly T[], name: string): T | null {
  if (v == null) return null;
  if (!values.includes(v as T)) throw new ToolInputError(`${name} must be one of ${values.join(', ')}.`);
  return v as T;
}
