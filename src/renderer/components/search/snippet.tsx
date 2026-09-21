/**
 * Search snippets arrive as plain text with FTS5 highlight markers: U+0002 opens a match and
 * U+0003 closes it. They are rendered as React text and <mark> nodes, never as HTML, so message
 * content can't inject markup. Emoji shortcodes in them are drawn as emoji.
 */
import clsx from 'clsx';
import { useEmojiMapReady } from '../../lib/emoji';
import { Emoji, useMrkdwnContext } from '../../lib/mrkdwn';
import { resolveEmoji, shortcodeWithTone } from '../../lib/mrkdwn/resolveEmoji';

export const MATCH_START = '\u0002';
export const MATCH_END = '\u0003';

export interface SnippetPart {
  text: string;
  match: boolean;
}

// Other C0 controls (except the markers) have no business in rendered text.
const STRAY_CONTROLS = /[\u0000\u0001\u0004-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Splits a snippet into plain and matched parts. Whitespace runs collapse to one space (results
 * are one compact paragraph); unbalanced markers degrade gracefully instead of throwing.
 */
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let match = false;
  let buffer = '';
  const flush = () => {
    if (!buffer) return;
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += buffer;
    else parts.push({ text: buffer, match });
    buffer = '';
  };
  const clean = snippet.replace(STRAY_CONTROLS, '').replace(/\s+/g, ' ');
  for (const ch of clean) {
    if (ch === MATCH_START || ch === MATCH_END) {
      const next = ch === MATCH_START;
      if (next !== match) {
        flush();
        match = next;
      }
      continue;
    }
    buffer += ch;
  }
  flush();
  // Trim the outer edges only; spaces next to a highlight are meaningful.
  if (parts.length) {
    parts[0].text = parts[0].text.trimStart();
    parts[parts.length - 1].text = parts[parts.length - 1].text.trimEnd();
  }
  return parts.filter((p) => p.text !== '');
}

/** Plain text of a snippet (markers removed), e.g. for titles and tests. */
export function snippetText(snippet: string): string {
  return parseSnippet(snippet)
    .map((p) => p.text)
    .join('');
}

/** A run of snippet text, or an `:emoji:` shortcode that can be drawn; either may be highlighted. */
export type SnippetPiece =
  | { kind: 'text'; text: string; match: boolean }
  | { kind: 'emoji'; text: string; match: boolean; name: string; skinTone: string | null };

const SHORTCODE = /:([\p{Ll}\p{Lo}\p{Nd}_+'-]{1,100}):(?::skin-tone-([2-6](?:-[2-6])?):)?/gu;

/**
 * Splits snippet parts further so shortcodes render as emoji (PLAN §6.2). FTS indexes `:tada:`
 * as the word "tada", so a match usually sits inside the colons: shortcodes are found in the
 * text without markers, and one that was (partly) matched is highlighted as a whole.
 * `canDraw` decides which shortcodes are real emoji; the rest stay text ("10:30:45").
 */
export function snippetPieces(
  parts: readonly SnippetPart[],
  canDraw: (name: string, skinTone: string | null) => boolean,
): SnippetPiece[] {
  const text = parts.map((p) => p.text).join('');
  const matched = new Uint8Array(text.length);
  let offset = 0;
  for (const part of parts) {
    if (part.match) matched.fill(1, offset, offset + part.text.length);
    offset += part.text.length;
  }

  const pieces: SnippetPiece[] = [];
  const pushText = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const match = matched[i] === 1;
      let j = i + 1;
      while (j < to && (matched[j] === 1) === match) j++;
      pieces.push({ kind: 'text', text: text.slice(i, j), match });
      i = j;
    }
  };

  const re = new RegExp(SHORTCODE.source, SHORTCODE.flags);
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    const skinTone = m[2] ?? null;
    if (!canDraw(m[1], skinTone)) {
      // Not an emoji ("10:30:"): its closing colon may open a real one, as in "10:30:tada:".
      re.lastIndex = start + 1;
      continue;
    }
    pushText(last, start);
    pieces.push({ kind: 'emoji', text: m[0], match: matched.subarray(start, end).includes(1), name: m[1], skinTone });
    last = end;
  }
  pushText(last, text.length);
  return pieces;
}

export function Snippet({ text, className }: { text: string; className?: string }) {
  const ctx = useMrkdwnContext();
  useEmojiMapReady(); // redraw once shortcodes can be resolved
  const pieces = snippetPieces(
    parseSnippet(text),
    (name, tone) => resolveEmoji(name, tone, ctx.customEmojiUrl) !== null,
  );
  return (
    <p className={clsx('break-words', className)}>
      {pieces.map((piece, i) => {
        const content =
          piece.kind === 'emoji' ? <Emoji name={shortcodeWithTone(piece.name, piece.skinTone)} /> : piece.text;
        return piece.match ? <mark key={i}>{content}</mark> : <span key={i}>{content}</span>;
      })}
    </p>
  );
}
