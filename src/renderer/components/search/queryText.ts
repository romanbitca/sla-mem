/**
 * Position-aware tokenizer for search queries.
 *
 * It follows main's grammar (src/main/db/search.ts `tokenizeSearchQuery`) so the UI and
 * main agree on what counts as a modifier, and adds source offsets so the UI can complete
 * the token under the caret or cut a modifier out of the query text.
 */

export const MODIFIER_KEYS = ['from', 'in', 'has', 'is', 'before', 'after', 'on', 'during'] as const;
export type ModifierKey = (typeof MODIFIER_KEYS)[number];

const MODIFIER_SET: ReadonlySet<string> = new Set(MODIFIER_KEYS);

export function isModifierKey(value: string): value is ModifierKey {
  return MODIFIER_SET.has(value);
}

export interface QueryToken {
  /** Offset of the first character (including a leading `-`). */
  start: number;
  /** Offset just past the last character. */
  end: number;
  raw: string;
  negated: boolean;
  /** Lower-cased modifier key, or null for words and phrases. */
  key: ModifierKey | null;
  /** Word, phrase content, or modifier value (without quotes). */
  value: string;
  quoted: boolean;
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** Splits `q` into words, `"phrases"`, `-exclusions` and `key:value` / `key:"value"` modifiers. */
export function tokenizeQuery(q: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let i = 0;
  while (i < q.length) {
    while (isSpace(q[i])) i++;
    if (i >= q.length) break;
    const start = i;
    const negated = q[i] === '-' && i + 1 < q.length && !isSpace(q[i + 1]);
    if (negated) i++;

    if (q[i] === '"') {
      const { value, end } = readQuoted(q, i);
      tokens.push({ start, end, raw: q.slice(start, end), negated, key: null, value, quoted: true });
      i = end;
      continue;
    }

    let j = i;
    let quotedKey: ModifierKey | null = null;
    while (j < q.length && !isSpace(q[j])) {
      const candidate = q.slice(i, j).toLowerCase();
      if (q[j] === ':' && q[j + 1] === '"' && isModifierKey(candidate)) {
        quotedKey = candidate;
        break;
      }
      j++;
    }
    if (quotedKey) {
      const { value, end } = readQuoted(q, j + 1);
      tokens.push({ start, end, raw: q.slice(start, end), negated, key: quotedKey, value, quoted: true });
      i = end;
      continue;
    }

    const word = q.slice(i, j);
    const colon = word.indexOf(':');
    const key = colon > 0 ? word.slice(0, colon).toLowerCase() : '';
    tokens.push(
      isModifierKey(key)
        ? { start, end: j, raw: q.slice(start, j), negated, key, value: word.slice(colon + 1), quoted: false }
        : { start, end: j, raw: q.slice(start, j), negated, key: null, value: word, quoted: false },
    );
    i = j;
  }
  return tokens;
}

/** Reads `"…"` from the opening quote; an unbalanced quote runs to the end (as in main). */
function readQuoted(q: string, openIndex: number): { value: string; end: number } {
  const close = q.indexOf('"', openIndex + 1);
  if (close === -1) return { value: q.slice(openIndex + 1), end: q.length };
  return { value: q.slice(openIndex + 1, close), end: close + 1 };
}

/** Removes every token matching `drop` and tidies the whitespace left behind. */
export function removeTokens(q: string, drop: (token: QueryToken) => boolean): string {
  const tokens = tokenizeQuery(q);
  // One predicate call per token: callers may be stateful (e.g. "only the first match").
  const kept = tokens.filter((t) => !drop(t));
  return kept.length === tokens.length ? q : kept.map((t) => t.raw).join(' ');
}

/** Removes the first token whose raw text is exactly `raw` (e.g. an unresolved modifier). */
export function removeRawToken(q: string, raw: string): string {
  let removed = false;
  return removeTokens(q, (t) => {
    if (removed || t.raw !== raw) return false;
    removed = true;
    return true;
  });
}

/** Whether the query contains any modifier token at all. */
export function hasModifierTokens(q: string): boolean {
  return tokenizeQuery(q).some((t) => t.key !== null);
}
