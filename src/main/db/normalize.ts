import type { SlackAttachment, SlackBlock, SlackMessage } from '../slack/types';
import { segmentCjk } from './cjk';

/** Lookups used to turn `<@U…>` / `<#C…>` references into words people search for. */
export interface NormalizeResolvers {
  userLabel(id: string): string | undefined;
  channelName(id: string): string | undefined;
}

type Loose = Record<string, unknown>;

const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------------------------
// Display text
// ---------------------------------------------------------------------------------------------

/**
 * The mrkdwn to show for a message: its `text`, or — for bot/app messages that only carry Block
 * Kit or legacy attachments — mrkdwn derived from `blocks`, then from attachments' `fallback`.
 */
export function displayTextFromMessage(msg: SlackMessage): string {
  const text = msg.text ?? '';
  if (text.trim()) return text;
  const fromBlocks = blocksToMrkdwn(msg.blocks);
  if (fromBlocks.trim()) return fromBlocks;
  return (msg.attachments ?? [])
    .map((a) => a.fallback ?? '')
    .filter((s) => s.trim())
    .join('\n');
}

/** Block types that carry a layout of their own (as opposed to rich_text, which mirrors `text`). */
const LAYOUT_BLOCKS = new Set([
  'section',
  'header',
  'context',
  'divider',
  'image',
  'actions',
  'video',
  'file',
  'input',
]);

/**
 * Blocks to render instead of `text`. App and bot messages put their real content in Block Kit
 * and a short notification fallback in `text` (PLAN §7, pitfall 15), so any layout block means
 * the blocks are the message. Plain user messages carry only rich_text blocks, which say the
 * same as `text`; for those the (well-tested) mrkdwn text is rendered and this returns [].
 */
export function displayBlocks(blocks: unknown): SlackBlock[] {
  const list = arr(blocks).filter(isObj) as SlackBlock[];
  return list.some((b) => LAYOUT_BLOCKS.has(String(b.type))) ? list : [];
}

/** Escapes the three characters mrkdwn requires escaped in literal text. */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function blocksToMrkdwn(blocks: SlackBlock[] | undefined): string {
  return (blocks ?? [])
    .map((b) => blockToMrkdwn(b))
    .filter((s) => s.trim())
    .join('\n');
}

function blockToMrkdwn(block: Loose): string {
  switch (block.type) {
    case 'rich_text':
      return arr(block.elements).filter(isObj).map(richBlockElement).join('\n');
    case 'section':
      return [textObject(block.text), ...arr(block.fields).map(textObject)].filter(Boolean).join('\n');
    case 'context':
      return arr(block.elements).map(textObject).filter(Boolean).join(' ');
    case 'header': {
      const text = textObject(block.text);
      return text ? `*${text}*` : '';
    }
    case 'image':
    case 'video':
      return textObject(block.title) || (block.type === 'image' ? escapeMrkdwn(str(block.alt_text)) : '');
    default:
      return '';
  }
}

/** A Block Kit text object (`plain_text` needs escaping to become valid mrkdwn). */
function textObject(obj: unknown): string {
  if (!isObj(obj)) return '';
  if (obj.type === 'mrkdwn') return str(obj.text);
  if (obj.type === 'plain_text') return escapeMrkdwn(str(obj.text));
  return '';
}

function richBlockElement(el: Loose): string {
  const children = arr(el.elements).filter(isObj);
  switch (el.type) {
    case 'rich_text_section':
      return children.map((c) => richInline(c, true)).join('');
    case 'rich_text_quote':
      return children
        .map((c) => richInline(c, true))
        .join('')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    case 'rich_text_preformatted':
      return '```\n' + children.map((c) => richInline(c, false)).join('') + '\n```';
    case 'rich_text_list':
      return richList(el, children);
    default:
      return '';
  }
}

function richList(list: Loose, items: Loose[]): string {
  const indent = '    '.repeat(typeof list.indent === 'number' ? list.indent : 0);
  const offset = typeof list.offset === 'number' ? list.offset : 0;
  return items
    .map((item, i) => {
      const bullet = list.style === 'ordered' ? `${offset + i + 1}. ` : '• ';
      return (
        indent +
        bullet +
        arr(item.elements)
          .filter(isObj)
          .map((c) => richInline(c, true))
          .join('')
      );
    })
    .join('\n');
}

function richInline(el: Loose, styled: boolean): string {
  switch (el.type) {
    case 'text':
      return styled ? styleText(escapeMrkdwn(str(el.text)), el.style) : escapeMrkdwn(str(el.text));
    case 'link': {
      const url = str(el.url);
      const label = str(el.text);
      return label ? `<${url}|${escapeMrkdwn(label)}>` : `<${url}>`;
    }
    case 'user':
      return `<@${str(el.user_id)}>`;
    case 'channel':
      return `<#${str(el.channel_id)}>`;
    case 'usergroup':
      return `<!subteam^${str(el.usergroup_id)}>`;
    case 'broadcast':
      return `<!${str(el.range)}>`;
    case 'emoji': {
      const tone = typeof el.skin_tone === 'number' ? `:skin-tone-${el.skin_tone}:` : '';
      return `:${str(el.name)}:${tone}`;
    }
    case 'date': {
      const fallback = str(el.fallback) || str(el.format);
      return `<!date^${String(el.timestamp ?? '')}^${str(el.format)}|${fallback}>`;
    }
    case 'color':
      return str(el.value);
    default:
      return str(el.text);
  }
}

/** Wraps text in mrkdwn markers, keeping edge whitespace outside (markers must hug words). */
function styleText(text: string, style: unknown): string {
  if (!isObj(style) || !text.trim()) return text;
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [lead, core, trail] = match ? [match[1], match[2], match[3]] : ['', text, ''];
  let out = core;
  if (style.code) out = `\`${out}\``;
  if (style.bold) out = `*${out}*`;
  if (style.italic) out = `_${out}_`;
  if (style.strike) out = `~${out}~`;
  return lead + out + trail;
}

// ---------------------------------------------------------------------------------------------
// Search text
// ---------------------------------------------------------------------------------------------

/**
 * Plain text indexed by FTS: mrkdwn with references resolved to names, entities unescaped and
 * formatting markers removed, plus Block Kit, attachment and file text so app notifications,
 * unfurls and uploads are findable. Layout blocks are indexed even when `text` is set: `text` is
 * then only the notification fallback (pitfall 15).
 */
export function normalizeForSearch(msg: SlackMessage, r: NormalizeResolvers): string {
  const parts: string[] = [];
  const text = msg.text ?? '';
  parts.push(text.trim() ? text : blocksToMrkdwn(msg.blocks));
  if (text.trim() && displayBlocks(msg.blocks).length) parts.push(blocksToMrkdwn(msg.blocks));
  for (const a of msg.attachments ?? []) parts.push(...attachmentTexts(a));
  const plain = parts.map((p) => mrkdwnToPlain(p, r));
  for (const f of msg.files ?? []) {
    plain.push(f.name ?? '');
    if (f.title && f.title !== f.name) plain.push(f.title);
  }
  return segmentCjk(dedupe(plain.map(tidy).filter(Boolean)).join('\n'));
}

function attachmentTexts(a: SlackAttachment): string[] {
  const fields = (a.fields ?? []).flatMap((f) => [f.title ?? '', f.value ?? '']);
  // Newer apps put Block Kit inside attachments (for the colour bar); pitfall 16.
  const blocks = blocksToMrkdwn(arr(a.blocks).filter(isObj) as SlackBlock[]);
  return [a.pretext, a.author_name, a.title, a.text, blocks, a.fallback, ...fields, a.from_url ?? a.original_url].map(
    (s) => s ?? '',
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function tidy(s: string): string {
  return (
    s
      // \u0002/\u0003 are the search snippet highlight markers; they must never come from content.
      .replace(/[\u0002\u0003]/g, '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** mrkdwn → plain text. References first (their `|` labels may contain markers), entities last. */
export function mrkdwnToPlain(mrkdwn: string, r: NormalizeResolvers): string {
  const resolved = mrkdwn.replace(/<([^<>\n]*)>/g, (_m, body: string) => resolveReference(body, r));
  return unescapeEntities(stripFormatting(resolved));
}

function resolveReference(body: string, r: NormalizeResolvers): string {
  const pipe = body.indexOf('|');
  const target = pipe >= 0 ? body.slice(0, pipe) : body;
  const label = pipe >= 0 ? body.slice(pipe + 1) : '';
  if (target.startsWith('@')) {
    const id = target.slice(1);
    return '@' + (r.userLabel(id) || label || id);
  }
  if (target.startsWith('#')) {
    const id = target.slice(1);
    return '#' + (r.channelName(id) || label || id);
  }
  if (target.startsWith('!')) return specialMention(target.slice(1), label);
  return label && label !== target ? `${label} ${target}` : target;
}

function specialMention(command: string, label: string): string {
  const [kind, id = ''] = command.split('^');
  if (kind === 'here' || kind === 'channel' || kind === 'everyone') return `@${kind}`;
  if (kind === 'subteam') return label || `@${id}`;
  if (kind === 'date') return label;
  return label || `@${kind}`;
}

/** `&lt; &gt; &amp;` → `< > &`, exactly once (so `&amp;lt;` becomes `&lt;`). */
export function unescapeEntities(s: string): string {
  return s.replace(/&(lt|gt|amp);/g, (_m, name: string) => (name === 'lt' ? '<' : name === 'gt' ? '>' : '&'));
}

// A marker pair must hug non-space text and sit on word boundaries, which is Slack's rule and
// what keeps `snake_case_word` and `2*3*4` intact.
const FORMAT_PAIR = /(^|[^\p{L}\p{N}])([*_~])(?=\S)([^\n]*?\S)\2(?![\p{L}\p{N}])/gu;

function stripFormatting(s: string): string {
  let out = s.replace(/```/g, '\n').replace(/`([^`\n]+)`/g, '$1');
  for (let i = 0; i < 3; i++) {
    const next = out.replace(FORMAT_PAIR, '$1$3');
    if (next === out) break;
    out = next;
  }
  return out;
}
