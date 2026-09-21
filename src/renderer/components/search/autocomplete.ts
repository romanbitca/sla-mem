/**
 * Slack-style modifier autocomplete for the search box, as pure functions of (text, caret).
 *
 * - Empty box: a cheat sheet of modifiers.
 * - A bare word that starts a modifier name (`fr`): the modifier (`from:`).
 * - Inside a modifier: its values. People for `from:`, conversations for `in:`, fixed values
 *   for `has:`/`is:`, and date shortcuts for `before:`/`after:`/`on:`/`during:`.
 *
 * Inserted references are chosen so search (in main) resolves them to exactly the suggested item:
 * `@handle` / `#channel` when that name is unambiguous, otherwise the Slack id.
 */
import type { ConversationDTO, UserDTO } from '../../../shared/types';
import { FREE_PLAN_WINDOW_DAYS } from '../../lib/format';
import { tokenizeQuery, type ModifierKey, type QueryToken } from './queryText';
import { addDays, localDay } from './resolve';

export type SuggestionKind = 'modifier' | 'user' | 'conversation' | 'value';

export interface Suggestion {
  /** Stable key (React key and option id). */
  id: string;
  kind: SuggestionKind;
  /** Replaces the active token. */
  insert: string;
  label: string;
  detail?: string;
  /** Complete tokens get a trailing space; `from:` keeps the caret there for the value. */
  complete: boolean;
  userId?: string;
  conversationId?: string;
}

export interface Autocomplete {
  /** Range of the input text an accepted suggestion replaces. */
  start: number;
  end: number;
  title: string;
  suggestions: Suggestion[];
  /** Pre-select the first suggestion so Enter/Tab accepts it (otherwise Enter searches). */
  autoSelect: boolean;
}

export interface AutocompleteSource {
  users: readonly UserDTO[];
  conversations: readonly ConversationDTO[];
  selfUserId: string | null;
  now?: Date;
}

export const MAX_SUGGESTIONS = 8;
/** Bare words shorter than this don't pop modifier hints ("a", "i" are too common). */
const MIN_HINT_PREFIX = 2;

interface ModifierHint {
  insert: string;
  detail: string;
  complete: boolean;
}

export const MODIFIER_HINTS: readonly ModifierHint[] = [
  { insert: 'from:', detail: 'Messages from a person', complete: false },
  { insert: 'in:', detail: 'In a channel or conversation', complete: false },
  { insert: 'has:', detail: 'With a file, link, image, reaction or thread', complete: false },
  { insert: 'before:', detail: 'Before a date', complete: false },
  { insert: 'after:', detail: 'On or after a date', complete: false },
  { insert: 'on:', detail: 'On one day', complete: false },
  { insert: 'during:', detail: 'During a month or year', complete: false },
  { insert: 'is:thread', detail: 'Thread parents and replies', complete: true },
];

function hintSuggestion(hint: ModifierHint): Suggestion {
  return {
    id: `mod:${hint.insert}`,
    kind: 'modifier',
    insert: hint.insert,
    label: hint.insert,
    detail: hint.detail,
    complete: hint.complete,
  };
}

export function getAutocomplete(q: string, caret: number, source: AutocompleteSource): Autocomplete | null {
  if (q.trim() === '') {
    return {
      start: 0,
      end: q.length,
      title: 'Narrow your search',
      suggestions: MODIFIER_HINTS.map(hintSuggestion),
      autoSelect: false,
    };
  }
  const token = tokenizeQuery(q).find((t) => t.start < caret && caret <= t.end);
  // Quoted text is literal; negated modifiers aren't supported by search.
  if (!token || token.quoted || token.negated) return null;
  return token.key ? valueCompletions(token, token.key, source) : keyCompletions(token);
}

function keyCompletions(token: QueryToken): Autocomplete | null {
  const word = token.value.toLowerCase();
  if (word.length < MIN_HINT_PREFIX || word.includes(':')) return null;
  const suggestions = MODIFIER_HINTS.filter((h) => h.insert.startsWith(word) && h.insert !== word).map(hintSuggestion);
  if (!suggestions.length) return null;
  return { start: token.start, end: token.end, title: 'Search modifiers', suggestions, autoSelect: false };
}

function valueCompletions(token: QueryToken, key: ModifierKey, source: AutocompleteSource): Autocomplete | null {
  const typed = token.value;
  let title: string;
  let suggestions: Suggestion[];
  switch (key) {
    case 'from':
      title = 'People';
      suggestions = userSuggestions(typed.replace(/^@/, ''), source);
      break;
    case 'in':
      title = 'Conversations';
      suggestions = conversationSuggestions(typed, source);
      break;
    case 'has':
      title = 'Has';
      suggestions = fixedSuggestions('has', HAS_OPTIONS, typed);
      break;
    case 'is':
      title = 'Is';
      suggestions = fixedSuggestions('is', IS_OPTIONS, typed);
      break;
    case 'during':
      title = 'Month or year';
      suggestions = fixedSuggestions('during', duringOptions(source.now ?? new Date()), typed);
      break;
    default:
      title = 'Dates (YYYY-MM-DD)';
      suggestions = fixedSuggestions(key, dayOptions(source.now ?? new Date()), typed);
  }
  if (!suggestions.length) return null;
  const alreadyComplete = suggestions.some((s) => s.insert.toLowerCase() === token.raw.toLowerCase());
  return {
    start: token.start,
    end: token.end,
    title,
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
    autoSelect: typed.length > 0 && !alreadyComplete,
  };
}

// ---------------------------------------------------------------------------------------------
// Fixed values

interface ValueOption {
  value: string;
  detail: string;
}

const HAS_OPTIONS: ValueOption[] = [
  { value: 'file', detail: 'Messages with files' },
  { value: 'link', detail: 'Messages with links' },
  { value: 'image', detail: 'Messages with images' },
  { value: 'reaction', detail: 'Messages with reactions' },
  { value: 'thread', detail: 'Thread parents with replies' },
];

const IS_OPTIONS: ValueOption[] = [{ value: 'thread', detail: 'Thread parents and replies' }];

function dayOptions(now: Date): ValueOption[] {
  const today = localDay(now);
  return [
    { value: 'today', detail: today },
    { value: 'yesterday', detail: addDays(today, -1) },
    { value: addDays(today, -7), detail: 'A week ago' },
    { value: addDays(today, -30), detail: '30 days ago' },
    { value: addDays(today, -FREE_PLAN_WINDOW_DAYS), detail: `${FREE_PLAN_WINDOW_DAYS} days ago · Slack Free cutoff` },
  ];
}

function duringOptions(now: Date): ValueOption[] {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const month = (year: number, mon: number) => `${year}-${String(mon).padStart(2, '0')}`;
  const [lastY, lastM] = m === 1 ? [y - 1, 12] : [y, m - 1];
  return [
    { value: month(y, m), detail: 'This month' },
    { value: month(lastY, lastM), detail: 'Last month' },
    { value: String(y), detail: 'This year' },
    { value: String(y - 1), detail: 'Last year' },
  ];
}

function fixedSuggestions(key: ModifierKey, options: ValueOption[], typed: string): Suggestion[] {
  const prefix = typed.toLowerCase();
  return options
    .filter((o) => o.value.toLowerCase().startsWith(prefix))
    .map((o) => ({
      id: `${key}:${o.value}`,
      kind: 'value' as const,
      insert: `${key}:${o.value}`,
      label: `${key}:${o.value}`,
      detail: o.detail,
      complete: true,
    }));
}

// ---------------------------------------------------------------------------------------------
// People and conversations

const SAFE_NAME = /^[^\s"]+$/;
const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

/** How well any of `keys` matches `q`: 0 exact, 1 prefix, 2 word prefix, 3 substring; null = no match. */
function matchScore(keys: readonly string[], q: string): number | null {
  if (!q) return 0;
  const ks = keys.map(lower).filter(Boolean);
  if (ks.some((k) => k === q)) return 0;
  if (ks.some((k) => k.startsWith(q))) return 1;
  if (ks.some((k) => k.split(/[\s._-]+/).some((w) => w.startsWith(q)))) return 2;
  if (ks.some((k) => k.includes(q))) return 3;
  return null;
}

/** `@handle` when search's exact match would find only this user, else the id. */
export function userRef(user: UserDTO, users: readonly UserDTO[]): string {
  const handle = user.name;
  if (!handle || !SAFE_NAME.test(handle)) return user.id;
  const h = handle.toLowerCase();
  const holders = users.filter(
    (u) => u.id.toLowerCase() === h || [u.name, u.displayName, u.realName].some((k) => lower(k) === h),
  );
  return holders.length === 1 ? `@${handle}` : user.id;
}

/** Value for `in:` that resolves to exactly this conversation. */
export function conversationRef(conv: ConversationDTO, source: AutocompleteSource): string {
  if (conv.type === 'im') {
    const user = source.users.find((u) => u.id === conv.dmUserId);
    const ref = user ? userRef(user, source.users) : conv.id;
    const dmCount = source.conversations.filter((c) => c.type === 'im' && c.dmUserId === conv.dmUserId).length;
    return ref.startsWith('@') && dmCount === 1 ? ref : conv.id;
  }
  if (conv.type === 'mpim' || !conv.rawName || !SAFE_NAME.test(conv.rawName)) return conv.id;
  const name = conv.rawName.toLowerCase();
  const holders = source.conversations.filter(
    (c) => c.id.toLowerCase() === name || (c.type !== 'im' && lower(c.rawName) === name),
  );
  return holders.length === 1 ? `#${conv.rawName}` : conv.id;
}

function userSuggestions(typed: string, source: AutocompleteSource): Suggestion[] {
  const q = typed.toLowerCase();
  const scored = source.users.flatMap((u) => {
    const score = matchScore([u.name, u.displayName ?? '', u.realName ?? '', u.label, u.id], q);
    return score == null ? [] : [{ u, score }];
  });
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      Number(a.u.deleted) - Number(b.u.deleted) ||
      Number(a.u.isBot) - Number(b.u.isBot) ||
      a.u.label.localeCompare(b.u.label),
  );
  return scored.slice(0, MAX_SUGGESTIONS).map(({ u }) => ({
    id: `user:${u.id}`,
    kind: 'user' as const,
    insert: `from:${userRef(u, source.users)}`,
    label: u.label,
    detail: userDetail(u, source.selfUserId),
    complete: true,
    userId: u.id,
  }));
}

function userDetail(u: UserDTO, selfUserId: string | null): string {
  const parts = [u.name ? `@${u.name}` : u.id];
  if (u.id === selfUserId) parts.push('you');
  if (u.isBot) parts.push('app');
  if (u.deleted) parts.push('deactivated');
  return parts.join(' · ');
}

const TYPE_ORDER: Record<ConversationDTO['type'], number> = { channel: 0, private_channel: 0, im: 1, mpim: 2 };
const TYPE_LABEL: Record<ConversationDTO['type'], string> = {
  channel: 'Channel',
  private_channel: 'Private channel',
  im: 'Direct message',
  mpim: 'Group DM',
};

function conversationKeys(c: ConversationDTO, source: AutocompleteSource): string[] {
  const keys = [c.label, c.rawName ?? '', c.id];
  if (c.type === 'im') {
    const user = source.users.find((u) => u.id === c.dmUserId);
    if (user) keys.push(user.name, user.displayName ?? '', user.realName ?? '');
  }
  return keys;
}

function conversationSuggestions(typed: string, source: AutocompleteSource): Suggestion[] {
  const sigil = typed.startsWith('#') ? '#' : typed.startsWith('@') ? '@' : '';
  const q = typed.slice(sigil.length).toLowerCase();
  const candidates = source.conversations.filter((c) =>
    sigil === '#' ? c.type === 'channel' || c.type === 'private_channel' : sigil === '@' ? c.type === 'im' : true,
  );
  const scored = candidates.flatMap((c) => {
    const score = matchScore(conversationKeys(c, source), q);
    return score == null ? [] : [{ c, score }];
  });
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      TYPE_ORDER[a.c.type] - TYPE_ORDER[b.c.type] ||
      Number(a.c.isArchived) - Number(b.c.isArchived) ||
      a.c.label.localeCompare(b.c.label),
  );
  return scored.slice(0, MAX_SUGGESTIONS).map(({ c }) => ({
    id: `conv:${c.id}`,
    kind: 'conversation' as const,
    insert: `in:${conversationRef(c, source)}`,
    label: c.type === 'channel' || c.type === 'private_channel' ? `#${c.label}` : c.label,
    detail: c.isArchived ? `${TYPE_LABEL[c.type]} · archived` : TYPE_LABEL[c.type],
    complete: true,
    conversationId: c.id,
  }));
}

// ---------------------------------------------------------------------------------------------
// Applying a suggestion

/** Replaces the active token; complete suggestions get exactly one space after them. */
export function applySuggestion(
  q: string,
  range: Pick<Autocomplete, 'start' | 'end'>,
  suggestion: Suggestion,
): { value: string; caret: number } {
  const head = q.slice(0, range.start);
  const tail = q.slice(range.end);
  const caret = head.length + suggestion.insert.length;
  if (!suggestion.complete) return { value: head + suggestion.insert + tail, caret };
  if (/^\s/.test(tail)) return { value: head + suggestion.insert + tail, caret: caret + 1 };
  return { value: `${head}${suggestion.insert} ${tail}`, caret: caret + 1 };
}
