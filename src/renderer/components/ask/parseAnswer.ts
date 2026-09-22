/**
 * Claude's answers are a little Markdown: paragraphs, bullet and numbered lists, **bold**,
 * *italic*, `code`, the odd heading, and citations like [12] or [3, 7]. This parses exactly that
 * into a small tree the answer view turns into React nodes (never HTML), so text still being
 * written, or anything else, shows as plain text.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; children: Inline[] }
  | { kind: 'italic'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'cite'; refs: number[] };

export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; content: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'code'; text: string };

export interface ListItem {
  content: Inline[];
  /** Deeper items under this one. */
  children: ListItem[];
}

const BULLET = /^(\s*)(?:[-*•]|(\d{1,3})[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const FENCE = /^\s*```/;

export function parseAnswer(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', lines: paragraph.map(parseInline) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      endParagraph();
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) {
      endParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ kind: 'heading', content: parseInline(heading[1]) });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      endParagraph();
      const items: { indent: number; number: number | null; text: string }[] = [];
      for (; i < lines.length; i++) {
        const m = BULLET.exec(lines[i]);
        if (m) {
          items.push({ indent: m[1].length, number: m[2] ? Number(m[2]) : null, text: m[3] });
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          // A wrapped line of the item above.
          items[items.length - 1].text += ` ${lines[i].trim()}`;
        } else {
          i--;
          break;
        }
      }
      blocks.push(buildList(items));
      continue;
    }
    paragraph.push(line);
  }
  endParagraph();
  return blocks;
}

/** Nests items by indentation (two or more spaces deeper than their parent). */
function buildList(items: { indent: number; number: number | null; text: string }[]): Block {
  const base = items[0].indent;
  const top: ListItem[] = [];
  let parent: ListItem | null = null;
  for (const item of items) {
    const node: ListItem = { content: parseInline(item.text), children: [] };
    if (item.indent >= base + 2 && parent) parent.children.push(node);
    else {
      top.push(node);
      parent = node;
    }
  }
  return { kind: 'list', ordered: items[0].number != null, start: items[0].number ?? 1, items: top };
}

// Order matters: code first (nothing inside it is markup), then links (shown as their text only:
// answers link nothing but the messages they cite), citations, bold, italic.
const INLINE = new RegExp(
  [
    '`(?<code>[^`\\n]+)`',
    '\\[(?<label>[^\\]\\n]+)\\]\\([^)\\s]+\\)',
    '\\[(?<cite>\\d{1,4}(?:\\s*,\\s*\\d{1,4})*)\\]',
    '\\*\\*(?<bold>.+?)\\*\\*',
    '__(?<bold2>.+?)__',
    '(?<![\\w*])\\*(?!\\s)(?<italic>[^*\\n]+?)\\*(?![\\w*])',
    '(?<![\\w_])_(?!\\s)(?<italic2>[^_\\n]+?)_(?![\\w_])',
  ].join('|'),
  'g',
);

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const pushText = (s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev?.kind === 'text') prev.text += s;
    else out.push({ kind: 'text', text: s });
  };
  for (const m of text.matchAll(INLINE)) {
    const g = m.groups ?? {};
    const index = m.index ?? 0;
    const between = text.slice(last, index);
    last = index + m[0].length;
    const prev = out[out.length - 1];
    if (g.cite != null && prev?.kind === 'cite' && /^[\s,]*$/.test(between)) {
      // "[3][7]" and "[3], [7]" read as one group.
      prev.refs.push(...refsOf(g.cite));
      continue;
    }
    pushText(between);
    if (g.code != null) out.push({ kind: 'code', text: g.code });
    else if (g.label != null) pushText(g.label);
    else if (g.cite != null) out.push({ kind: 'cite', refs: refsOf(g.cite) });
    else if (g.bold != null || g.bold2 != null) out.push({ kind: 'bold', children: parseInline(g.bold ?? g.bold2) });
    else out.push({ kind: 'italic', children: parseInline(g.italic ?? g.italic2) });
  }
  pushText(text.slice(last));
  return out;
}

function refsOf(list: string): number[] {
  return list.split(',').map((n) => Number(n.trim()));
}

/** The numbers an answer cites, each once, in the order they first appear. */
export function citedRefs(source: string): number[] {
  const seen = new Set<number>();
  const visit = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.kind === 'cite') node.refs.forEach((r) => seen.add(r));
      else if (node.kind === 'bold' || node.kind === 'italic') visit(node.children);
    }
  };
  const visitItems = (items: ListItem[]) => {
    for (const item of items) {
      visit(item.content);
      visitItems(item.children);
    }
  };
  for (const block of parseAnswer(source)) {
    if (block.kind === 'paragraph') block.lines.forEach(visit);
    else if (block.kind === 'heading') visit(block.content);
    else if (block.kind === 'list') visitItems(block.items);
  }
  return [...seen];
}
