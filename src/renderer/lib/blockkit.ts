/**
 * Block Kit (PLAN §7, pitfalls 15/16) → the mrkdwn AST, so app and bot messages render with the
 * same mentions, links, emoji and dates as ordinary messages. Pure functions over loosely typed
 * JSON: Slack adds fields over time and stored payloads are untrusted, so every field is checked
 * and anything unexpected is skipped rather than trusted. Links still pass `safeHref` twice
 * (here and in the renderer).
 *
 * Text objects: `mrkdwn` text is parsed as mrkdwn; `plain_text` is literal text in which only
 * `:emoji:` shortcodes are drawn (when `emoji` isn't false). It is never parsed as mrkdwn, which
 * is what escaping it before parsing achieves in main's search text (normalize.ts).
 */
import type { BlockDTO } from '../../shared/types';
import type { BreakNode, CodeChildNode, EmojiNode, LinkNode, MrkdwnNode, PreNode, QuoteNode, TextNode } from './mrkdwn';
import { safeHref } from './mrkdwn';

export type Loose = Record<string, unknown>;

export const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const objects = (v: unknown): Loose[] => arr(v).filter(isObj);

// ---------------------------------------------------------------------------------------------
// Text objects

export type TextObject = { kind: 'mrkdwn'; text: string } | { kind: 'plain'; text: string; emoji: boolean };

/** A Block Kit text object, or null when it isn't one (or is empty). */
export function textObject(value: unknown): TextObject | null {
  if (!isObj(value)) return null;
  const text = str(value.text);
  if (!text.trim()) return null;
  if (value.type === 'mrkdwn') return { kind: 'mrkdwn', text };
  if (value.type === 'plain_text') return { kind: 'plain', text, emoji: value.emoji !== false };
  return null;
}

const SHORTCODE_RE = /:([\p{Ll}\p{Lo}\p{Nd}_+'-]{1,100}):(?::skin-tone-([2-6](?:-[2-6])?):)?/gu;

function pushText(out: MrkdwnNode[], text: string): void {
  if (!text) return;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (i > 0) out.push({ type: 'br' } satisfies BreakNode);
    if (!line) return;
    const prev = out[out.length - 1];
    if (prev?.type === 'text') prev.text += line;
    else out.push({ type: 'text', text: line } satisfies TextNode);
  });
}

/** Literal text with line breaks and (optionally) `:emoji:` shortcodes drawn as emoji. */
export function plainTextNodes(text: string, emoji = true): MrkdwnNode[] {
  const out: MrkdwnNode[] = [];
  if (!emoji) {
    pushText(out, text);
    return out;
  }
  let last = 0;
  for (const m of text.matchAll(SHORTCODE_RE)) {
    const start = m.index ?? 0;
    pushText(out, text.slice(last, start));
    out.push({ type: 'emoji', name: m[1], skinTone: m[2] ?? null } satisfies EmojiNode);
    last = start + m[0].length;
  }
  pushText(out, text.slice(last));
  return out;
}

// ---------------------------------------------------------------------------------------------
// rich_text

interface RichStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

function styleOf(el: Loose): RichStyle {
  const s = isObj(el.style) ? el.style : {};
  return { bold: s.bold === true, italic: s.italic === true, strike: s.strike === true, code: s.code === true };
}

/** Wraps nodes in Slack's style order: code innermost, then strike, italic, bold. */
function applyStyle(nodes: MrkdwnNode[], style: RichStyle): MrkdwnNode[] {
  if (nodes.length === 0) return nodes;
  let out = nodes;
  if (style.code) {
    // Code can't hold line breaks: one code span per line.
    const styled: MrkdwnNode[] = [];
    for (const node of out) {
      if (node.type === 'text' || node.type === 'link') styled.push({ type: 'code', children: [node] });
      else styled.push(node);
    }
    out = styled;
  }
  if (style.strike) out = [{ type: 'strike', children: out }];
  if (style.italic) out = [{ type: 'italic', children: out }];
  if (style.bold) out = [{ type: 'bold', children: out }];
  return out;
}

const BROADCASTS: Record<string, 'here' | 'channel' | 'everyone'> = {
  here: 'here',
  channel: 'channel',
  everyone: 'everyone',
};

function linkNode(el: Loose): LinkNode | TextNode {
  const url = str(el.url);
  const label = str(el.text) || url;
  const href = safeHref(url);
  return href ? { type: 'link', url: href, label } : { type: 'text', text: label };
}

/** One inline element of a rich_text section/list item/quote. */
function richInline(el: Loose): MrkdwnNode[] {
  switch (el.type) {
    case 'text': {
      const nodes: MrkdwnNode[] = [];
      pushText(nodes, str(el.text));
      return applyStyle(nodes, styleOf(el));
    }
    case 'link':
      return applyStyle([linkNode(el)], styleOf(el));
    case 'user':
      return str(el.user_id) ? [{ type: 'user', id: str(el.user_id), label: null }] : [];
    case 'channel':
      return str(el.channel_id) ? [{ type: 'channel', id: str(el.channel_id), label: null }] : [];
    case 'usergroup':
      return str(el.usergroup_id) ? [{ type: 'usergroup', id: str(el.usergroup_id), label: null }] : [];
    case 'broadcast': {
      const target = BROADCASTS[str(el.range)];
      return target ? [{ type: 'broadcast', target }] : [];
    }
    case 'emoji': {
      const name = str(el.name);
      if (!name) return [];
      const tone =
        typeof el.skin_tone === 'number' && el.skin_tone >= 2 && el.skin_tone <= 6 ? String(el.skin_tone) : null;
      return [{ type: 'emoji', name, skinTone: tone }];
    }
    case 'date': {
      const timestamp = typeof el.timestamp === 'number' ? el.timestamp : Number(el.timestamp);
      if (!Number.isFinite(timestamp)) return str(el.fallback) ? [{ type: 'text', text: str(el.fallback) }] : [];
      return [
        {
          type: 'date',
          timestamp,
          format: str(el.format) || '{date_short_pretty} at {time}',
          url: safeHref(str(el.url)),
          fallback: str(el.fallback),
        },
      ];
    }
    case 'color':
      return str(el.value) ? [{ type: 'text', text: str(el.value) }] : [];
    default:
      return str(el.text) ? [{ type: 'text', text: str(el.text) }] : [];
  }
}

/** Inline nodes of a list of rich text elements, adjacent text merged. */
export function richInlineNodes(elements: unknown): MrkdwnNode[] {
  const out: MrkdwnNode[] = [];
  for (const el of objects(elements)) {
    for (const node of richInline(el)) {
      const prev = out[out.length - 1];
      if (node.type === 'text' && prev?.type === 'text') prev.text += node.text;
      else out.push(node);
    }
  }
  return out;
}

/** Preformatted text: literal, but links and mentions inside still resolve (as in mrkdwn). */
export function richPreformatted(elements: unknown): PreNode {
  const children: CodeChildNode[] = [];
  const push = (node: CodeChildNode) => {
    const prev = children[children.length - 1];
    if (node.type === 'text' && prev?.type === 'text') prev.text += node.text;
    else children.push(node);
  };
  for (const el of objects(elements)) {
    if (el.type === 'link') push(linkNode(el));
    else if (el.type === 'user' && str(el.user_id)) push({ type: 'user', id: str(el.user_id), label: null });
    else if (el.type === 'channel' && str(el.channel_id))
      push({ type: 'channel', id: str(el.channel_id), label: null });
    else if (el.type === 'emoji' && str(el.name)) push({ type: 'text', text: `:${str(el.name)}:` });
    else if (str(el.text)) push({ type: 'text', text: str(el.text) });
  }
  return { type: 'pre', children };
}

export function richQuote(elements: unknown): QuoteNode {
  return { type: 'quote', children: richInlineNodes(elements) };
}

/** One rich_text_list: its style, nesting level, first number and items' inline nodes. */
export interface RichList {
  ordered: boolean;
  indent: number;
  /** Number of the first item (ordered lists continue across interrupted runs via `offset`). */
  start: number;
  items: MrkdwnNode[][];
}

export function richList(el: Loose): RichList {
  const indent = typeof el.indent === 'number' && el.indent > 0 ? Math.min(Math.floor(el.indent), 8) : 0;
  const offset = typeof el.offset === 'number' && el.offset > 0 ? Math.floor(el.offset) : 0;
  return {
    ordered: el.style === 'ordered',
    indent,
    start: offset + 1,
    items: objects(el.elements).map((item) => richInlineNodes(item.elements)),
  };
}

/** Slack's marker styles cycle with the nesting level. */
export function listMarker(list: Pick<RichList, 'ordered' | 'indent'>): string {
  const styles = list.ordered ? ['decimal', 'lower-alpha', 'lower-roman'] : ['disc', 'circle', 'square'];
  return styles[list.indent % styles.length];
}

// ---------------------------------------------------------------------------------------------
// Blocks

export function isBlock(value: unknown): value is BlockDTO {
  return isObj(value) && typeof value.type === 'string';
}

/** Text of a button-like element (`text` is a plain_text object; selects have placeholders). */
export function elementLabel(el: Loose): string {
  for (const key of ['text', 'placeholder'] as const) {
    const t = textObject(el[key]);
    if (t) return t.text;
  }
  const initial = isObj(el.initial_option) ? textObject(el.initial_option.text) : null;
  return initial?.text ?? '';
}
