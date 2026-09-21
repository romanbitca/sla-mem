/**
 * Inline mrkdwn for a single line (no `\n`, no ``` blocks — parse.ts splits those out first).
 *
 * Two passes, both linear:
 *  1. tokenize: atoms that formatting can never cut into (`<…>` references, `code`, bare URLs,
 *     `:emoji:`), literal text runs, and candidate `*` `_` `~` markers annotated with whether
 *     Slack's boundary rules let them open/close.
 *  2. pair: an opener pairs with the *next* marker of the same kind if that one can close;
 *     otherwise the opener is literal. Content therefore never contains its own marker, which
 *     is Slack's rule (`*a *b*` bolds only `b`), and different markers nest freely.
 */
import type { CodeChildNode, EmojiNode, LinkNode, MrkdwnNode, TextNode } from './types';
import { parseReference } from './refs';
import { safeHref, trimBareUrl, unescapeEntities } from './url';

type MarkerChar = '*' | '_' | '~';

type Token =
  | { kind: 'text'; raw: string }
  | { kind: 'atom'; node: MrkdwnNode }
  | { kind: 'marker'; ch: MarkerChar; canOpen: boolean; canClose: boolean };

interface Match<N extends MrkdwnNode = MrkdwnNode> {
  node: N;
  end: number;
}

const FORMAT_TYPE = { '*': 'bold', _: 'italic', '~': 'strike' } as const;

const CH_LT = 60; // <
const CH_BACKTICK = 96; // `
const CH_COLON = 58; // :
const CH_STAR = 42; // *
const CH_UNDERSCORE = 95; // _
const CH_TILDE = 126; // ~
const CH_H = 104; // h (bare URLs; case folded with | 32)

// Slack shortcodes: lowercase ASCII plus letters from caseless scripts (custom emoji in e.g.
// Japanese workspaces). Bounded so a colon followed by a huge word can't cost much.
const EMOJI_RE = /:([\p{Ll}\p{Lo}\p{Nd}_+'-]{1,100}):/uy;
const SKIN_TONE_RE = /:skin-tone-([2-6](?:-[2-6])?):/y;
const BARE_URL_RE = /https?:\/\/[^\s<>`]{1,4096}/iy;
const WORD_NON_ASCII_RE = /[\p{L}\p{N}]/u;
const SPACE_RE = /\s/;

/** Letters and digits in any script: markers touching them are part of a word (snake_case, 2*3). */
function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 122);
  return WORD_NON_ASCII_RE.test(ch);
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && SPACE_RE.test(ch);
}

/**
 * Forward-only `indexOf` with a cached answer. The tokenizer asks for "the next `>` after i" with
 * non-decreasing i, so the total work is linear even for input like `<<<<<<…`.
 */
function forwardFinder(src: string, ch: string): (from: number) => number {
  let cached = -2;
  return (from) => {
    if (cached === -1) return -1;
    if (cached < from) cached = src.indexOf(ch, from);
    return cached;
  };
}

function makeMarker(src: string, i: number, ch: MarkerChar): Token {
  const prev = i > 0 ? src[i - 1] : undefined;
  const next = src[i + 1];
  return {
    kind: 'marker',
    ch,
    // Opening needs a non-word char before it and real (non-space) content after it.
    canOpen: !isWordChar(prev) && next !== undefined && !isSpace(next) && next !== ch,
    // Closing needs non-space content before it and must not run into a word.
    canClose: prev !== undefined && !isSpace(prev) && !isWordChar(next),
  };
}

function matchEmoji(src: string, i: number): Match | null {
  EMOJI_RE.lastIndex = i;
  const m = EMOJI_RE.exec(src);
  if (!m) return null;
  const node: EmojiNode = { type: 'emoji', name: m[1], skinTone: null };
  let end = EMOJI_RE.lastIndex;
  if (!m[1].startsWith('skin-tone-')) {
    SKIN_TONE_RE.lastIndex = end;
    const tone = SKIN_TONE_RE.exec(src);
    if (tone) {
      node.skinTone = tone[1];
      end = SKIN_TONE_RE.lastIndex;
    }
  }
  return { node, end };
}

function matchBareUrl(src: string, i: number): Match | null {
  if (isWordChar(src[i - 1])) return null;
  BARE_URL_RE.lastIndex = i;
  const m = BARE_URL_RE.exec(src);
  if (!m) return null;
  const raw = m[0].slice(0, trimBareUrl(m[0]));
  const url = unescapeEntities(raw);
  const href = /^https?:\/\/./i.test(url) ? safeHref(url) : null;
  if (!href) return null;
  const node: LinkNode = { type: 'link', url: href, label: url };
  return { node, end: i + raw.length };
}

interface Finders {
  nextLt: (from: number) => number;
  nextGt: (from: number) => number;
  nextBacktick: (from: number) => number;
}

function matchReference(src: string, i: number, f: Finders): Match<CodeChildNode> | null {
  const gt = f.nextGt(i + 1);
  if (gt === -1) return null;
  const lt = f.nextLt(i + 1);
  if (lt !== -1 && lt < gt) return null; // `<` inside: the first one is literal text
  const node = parseReference(src.slice(i + 1, gt));
  return node ? { node, end: gt + 1 } : null;
}

function matchCode(src: string, i: number, f: Finders): Match | null {
  const close = f.nextBacktick(i + 1);
  if (close === -1) return null;
  const body = src.slice(i + 1, close);
  if (body.trim() === '') return null;
  return { node: { type: 'code', children: parseCodeContent(body) }, end: close + 1 };
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const finders: Finders = {
    nextLt: forwardFinder(src, '<'),
    nextGt: forwardFinder(src, '>'),
    nextBacktick: forwardFinder(src, '`'),
  };
  let textStart = 0;
  let i = 0;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    let match: Match | null = null;
    let marker: Token | null = null;
    if (c === CH_LT) match = matchReference(src, i, finders);
    else if (c === CH_BACKTICK) match = matchCode(src, i, finders);
    else if (c === CH_COLON) match = matchEmoji(src, i);
    else if ((c | 32) === CH_H) match = matchBareUrl(src, i);
    else if (c === CH_STAR || c === CH_UNDERSCORE || c === CH_TILDE) marker = makeMarker(src, i, src[i] as MarkerChar);

    if (!match && !marker) {
      i++;
      continue;
    }
    if (i > textStart) tokens.push({ kind: 'text', raw: src.slice(textStart, i) });
    if (match) {
      tokens.push({ kind: 'atom', node: match.node });
      i = match.end;
    } else {
      tokens.push(marker as Token);
      i++;
    }
    textStart = i;
  }
  if (textStart < src.length) tokens.push({ kind: 'text', raw: src.slice(textStart) });
  return tokens;
}

/** nextSame[i] = index of the next marker token with the same char, or -1. */
function nextSameMarker(tokens: Token[]): Int32Array {
  const next = new Int32Array(tokens.length).fill(-1);
  const last: Partial<Record<MarkerChar, number>> = {};
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind !== 'marker') continue;
    next[i] = last[t.ch] ?? -1;
    last[t.ch] = i;
  }
  return next;
}

function appendText(out: MrkdwnNode[], text: string): void {
  if (!text) return;
  const prev = out[out.length - 1];
  if (prev?.type === 'text') prev.text += text;
  else out.push({ type: 'text', text });
}

function pair(tokens: Token[], lo: number, hi: number, nextSame: Int32Array): MrkdwnNode[] {
  const out: MrkdwnNode[] = [];
  let i = lo;
  while (i < hi) {
    const t = tokens[i];
    if (t.kind === 'marker') {
      const j = t.canOpen ? nextSame[i] : -1;
      const closer = j !== -1 && j < hi ? tokens[j] : null;
      if (closer?.kind === 'marker' && closer.canClose) {
        out.push({ type: FORMAT_TYPE[t.ch], children: pair(tokens, i + 1, j, nextSame) });
        i = j + 1;
        continue;
      }
      appendText(out, t.ch);
    } else if (t.kind === 'text') {
      appendText(out, unescapeEntities(t.raw));
    } else if (t.node.type === 'text') {
      appendText(out, t.node.text); // e.g. the label of a rejected javascript: link
    } else {
      out.push(t.node);
    }
    i++;
  }
  return out;
}

/** Parses one line of text (no newlines, no ``` blocks) into inline nodes. */
export function parseInline(src: string): MrkdwnNode[] {
  if (!src) return [];
  const tokens = tokenize(src);
  return pair(tokens, 0, tokens.length, nextSameMarker(tokens));
}

/**
 * Content of `code` / ``` blocks: literal text, except that Slack still sends its `<…>`
 * references in there (it auto-wraps URLs and mentions server-side), which we resolve.
 */
export function parseCodeContent(src: string): CodeChildNode[] {
  const out: CodeChildNode[] = [];
  const finders: Finders = {
    nextLt: forwardFinder(src, '<'),
    nextGt: forwardFinder(src, '>'),
    nextBacktick: () => -1,
  };
  let textStart = 0;
  let i = src.indexOf('<');
  while (i !== -1) {
    const match = matchReference(src, i, finders);
    if (match) {
      appendCodeText(out, src.slice(textStart, i));
      out.push(match.node);
      textStart = match.end;
      i = src.indexOf('<', match.end);
    } else {
      i = src.indexOf('<', i + 1);
    }
  }
  appendCodeText(out, src.slice(textStart));
  return out;
}

function appendCodeText(out: CodeChildNode[], raw: string): void {
  if (!raw) return;
  const text = unescapeEntities(raw);
  const prev = out[out.length - 1];
  if (prev?.type === 'text') prev.text += text;
  else out.push({ type: 'text', text } satisfies TextNode);
}
