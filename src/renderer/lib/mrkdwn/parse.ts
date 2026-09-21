/**
 * Block level of the mrkdwn parser: ``` blocks, `>` / `>>>` quotes and line breaks.
 * Inline formatting is delegated to inline.ts, one line at a time, because Slack's
 * bold/italic/strike/code never span a line break.
 */
import { parseCodeContent, parseInline } from './inline';
import { isBlockNode, type MrkdwnNode, type QuoteNode } from './types';

type Part = { kind: 'text'; raw: string } | { kind: 'pre'; raw: string };
/** One logical line. A ``` block is a single part, even when it spans several source lines. */
type Line = Part[];
type QuoteKind = 'line' | 'rest';

const FENCE = '```';

/**
 * Parses Slack mrkdwn (as stored: `&lt; &gt; &amp;` escaped, `<…>` references intact) into an
 * AST. Pure and linear-time; safe to call on every render but memoize for long texts.
 */
export function parseMrkdwn(text: string): MrkdwnNode[] {
  if (!text) return [];
  const src = text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
  return buildLines(splitLines(src), true);
}

/**
 * Splits into lines while cutting out ``` blocks first: they may start mid-line, span lines and
 * contain `>` or `*` that must stay literal. A fence pair with only whitespace between is text.
 */
function splitLines(src: string): Line[] {
  const lines: Line[] = [[]];
  const addText = (s: string) => {
    let start = 0;
    for (let nl = s.indexOf('\n'); nl !== -1; nl = s.indexOf('\n', start)) {
      if (nl > start) lines[lines.length - 1].push({ kind: 'text', raw: s.slice(start, nl) });
      lines.push([]);
      start = nl + 1;
    }
    if (start < s.length) lines[lines.length - 1].push({ kind: 'text', raw: s.slice(start) });
  };

  let pos = 0;
  while (pos < src.length) {
    const open = src.indexOf(FENCE, pos);
    if (open === -1) break;
    const close = src.indexOf(FENCE, open + FENCE.length);
    if (close === -1) break;
    const body = src.slice(open + FENCE.length, close);
    if (body.trim() === '') {
      addText(src.slice(pos, close + FENCE.length));
    } else {
      addText(src.slice(pos, open));
      lines[lines.length - 1].push({ kind: 'pre', raw: body });
    }
    pos = close + FENCE.length;
  }
  addText(src.slice(pos));
  return lines;
}

function quoteKind(line: Line): QuoteKind | null {
  const first = line[0];
  if (first?.kind !== 'text') return null;
  const s = first.raw;
  // Slack sends `>` escaped; text derived from blocks may carry it raw.
  if (s.startsWith('&gt;&gt;&gt;') || s.startsWith('>>>')) return 'rest';
  if (s.startsWith('&gt;') || s.startsWith('>')) return 'line';
  return null;
}

function stripQuoteMarker(line: Line, kind: QuoteKind): Line {
  const [first, ...rest] = line;
  const raw = first.raw;
  const escaped = raw.startsWith('&gt;');
  const markerLength = kind === 'rest' ? (escaped ? 12 : 3) : escaped ? 4 : 1;
  let body = raw.slice(markerLength);
  // `> quote` → "quote"; `>>> quote` also drops any further leading blanks.
  body = kind === 'rest' ? body.replace(/^[ \t]+/, '') : body.replace(/^[ \t]/, '');
  return body ? [{ kind: 'text', raw: body }, ...rest] : rest;
}

function isBlankLine(line: Line): boolean {
  return line.every((p) => p.kind === 'text' && p.raw.trim() === '');
}

function buildLines(lines: Line[], allowQuotes: boolean): MrkdwnNode[] {
  const out: MrkdwnNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (i > 0) out.push({ type: 'br' });
    const kind = allowQuotes ? quoteKind(lines[i]) : null;
    if (kind === 'rest') {
      appendQuote(out, lines.slice(i), restOfMessageQuote(lines.slice(i)));
      break;
    }
    if (kind === 'line') {
      let j = i + 1;
      while (j < lines.length && quoteKind(lines[j]) === 'line') j++;
      const original = lines.slice(i, j);
      appendQuote(out, original, original.map((l) => stripQuoteMarker(l, 'line')));
      i = j;
      continue;
    }
    appendLine(out, lines[i]);
    i++;
  }
  return tidyBlocks(out);
}

/** `>>>` quotes everything after it. `>>>` alone on its line quotes from the next line. */
function restOfMessageQuote(lines: Line[]): Line[] {
  const quoted = [stripQuoteMarker(lines[0], 'rest'), ...lines.slice(1)];
  if (quoted.length > 1 && quoted[0].length === 0) quoted.shift();
  return quoted;
}

/** A quote with no content at all (a lone `>`) is shown as the literal text. */
function appendQuote(out: MrkdwnNode[], original: Line[], quoted: Line[]): void {
  if (quoted.every(isBlankLine)) {
    original.forEach((line, k) => {
      if (k > 0) out.push({ type: 'br' });
      appendLine(out, line);
    });
    return;
  }
  const quote: QuoteNode = { type: 'quote', children: buildLines(quoted, false) };
  out.push(quote);
}

function appendLine(out: MrkdwnNode[], line: Line): void {
  for (const part of line) {
    if (part.kind === 'pre') {
      out.push({ type: 'pre', children: parseCodeContent(stripFenceNewlines(part.raw)) });
    } else {
      for (const node of parseInline(part.raw)) out.push(node);
    }
  }
}

/** "```\ncode\n```" shows just `code`, like Slack. */
function stripFenceNewlines(raw: string): string {
  const start = raw.startsWith('\n') ? 1 : 0;
  const end = raw.length > start && raw.endsWith('\n') ? raw.length - 1 : raw.length;
  return raw.slice(start, end);
}

/**
 * Blocks already start and end a line, so: drop the spaces that touched a block on its own line
 * (`text ```x``` more`), and drop the one line break right after a block — rendered as `<br>`
 * after a block element it would add an empty line Slack doesn't show.
 */
function tidyBlocks(nodes: MrkdwnNode[]): MrkdwnNode[] {
  const out: MrkdwnNode[] = [];
  let afterBlock = false;
  for (const node of nodes) {
    if (isBlockNode(node)) {
      trimTrailingBlanks(out);
      out.push(node);
      afterBlock = true;
      continue;
    }
    if (afterBlock && node.type === 'br') {
      afterBlock = false;
      continue;
    }
    if (afterBlock && node.type === 'text') {
      const text = node.text.replace(/^[ \t]+/, '');
      if (!text) continue;
      out.push({ type: 'text', text });
      afterBlock = false;
      continue;
    }
    afterBlock = false;
    out.push(node);
  }
  return out;
}

function trimTrailingBlanks(out: MrkdwnNode[]): void {
  const last = out[out.length - 1];
  if (last?.type !== 'text') return;
  const text = last.text.replace(/[ \t]+$/, '');
  if (text) out[out.length - 1] = { type: 'text', text };
  else out.pop();
}
