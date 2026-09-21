/** Mrkdwn → plain text, for `title` attributes, document titles and notifications. */
import type { MrkdwnContext } from './context';
import { BROADCAST_LABEL, channelMentionLabel, dateLabel, userMentionLabel, usergroupLabel } from './labels';
import { parseMrkdwn } from './parse';
import { resolveEmoji, shortcodeWithTone } from './resolveEmoji';
import { isBlockNode, type MrkdwnNode } from './types';

type PlainContext = Partial<MrkdwnContext>;

/**
 * `*Hi* <@U1>, see <#C1> :+1:` → `Hi @Roman, see #general 👍` (emoji as Unicode once the emoji
 * map is loaded, `:name:` otherwise). Blocks go on their own lines; ends are trimmed.
 */
export function mrkdwnToPlainText(text: string, ctx: PlainContext = {}): string {
  return nodesToPlainText(parseMrkdwn(text), ctx);
}

export function nodesToPlainText(nodes: readonly MrkdwnNode[], ctx: PlainContext = {}): string {
  const out: string[] = [];
  writeNodes(nodes, ctx, out);
  return out.join('').trim();
}

function endsWithNewline(out: string[]): boolean {
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]) return out[i].endsWith('\n');
  }
  return true; // start of output counts as a fresh line
}

function writeNodes(nodes: readonly MrkdwnNode[], ctx: PlainContext, out: string[]): void {
  for (const node of nodes) {
    // Blocks own their lines; the parser dropped the break after them, so put it back here.
    const block = isBlockNode(node);
    if (block && !endsWithNewline(out)) out.push('\n');
    writeNode(node, ctx, out);
    if (block) out.push('\n');
  }
}

function writeNode(node: MrkdwnNode, ctx: PlainContext, out: string[]): void {
  switch (node.type) {
    case 'text':
      out.push(node.text);
      return;
    case 'br':
      out.push('\n');
      return;
    case 'bold':
    case 'italic':
    case 'strike':
    case 'code':
    case 'pre':
    case 'quote':
      writeNodes(node.children, ctx, out);
      return;
    case 'link':
      out.push(node.label);
      return;
    case 'user':
      out.push(`@${userMentionLabel(node, ctx)}`);
      return;
    case 'channel':
      out.push(`#${channelMentionLabel(node, ctx)}`);
      return;
    case 'broadcast':
      out.push(BROADCAST_LABEL[node.target]);
      return;
    case 'usergroup':
      out.push(usergroupLabel(node));
      return;
    case 'date':
      out.push(dateLabel(node));
      return;
    case 'emoji': {
      const resolved = resolveEmoji(node.name, node.skinTone, ctx.customEmojiUrl);
      out.push(resolved?.kind === 'unicode' ? resolved.native : `:${shortcodeWithTone(node.name, node.skinTone)}:`);
      return;
    }
  }
}
