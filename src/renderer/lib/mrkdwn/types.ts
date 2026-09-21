/**
 * AST produced by `parseMrkdwn`. All text is already entity-unescaped (`&lt;` → `<`) and every
 * `url` has passed `safeHref` (http, https or mailto only), so renderers can use nodes as-is.
 *
 * Line breaks are explicit `br` nodes. `pre` and `quote` are block-level; the parser drops the
 * line break that directly follows a block (the block already ends the line), so a renderer that
 * turns `br` into `<br>` gets Slack's spacing without extra blank lines.
 */

export interface TextNode {
  type: 'text';
  text: string;
}

export interface BreakNode {
  type: 'br';
}

export interface BoldNode {
  type: 'bold';
  children: MrkdwnNode[];
}

export interface ItalicNode {
  type: 'italic';
  children: MrkdwnNode[];
}

export interface StrikeNode {
  type: 'strike';
  children: MrkdwnNode[];
}

/** Inline `code`. No formatting or emoji inside; Slack's `<…>` references still resolve. */
export interface CodeNode {
  type: 'code';
  children: CodeChildNode[];
}

/** ``` preformatted block. Text children keep their `\n`s. */
export interface PreNode {
  type: 'pre';
  children: CodeChildNode[];
}

export interface QuoteNode {
  type: 'quote';
  children: MrkdwnNode[];
}

export interface LinkNode {
  type: 'link';
  /** Normalized, safe href (http:, https: or mailto:). */
  url: string;
  /** Text to show: the explicit label, else the URL as written (mailto: prefix removed). */
  label: string;
}

export interface UserMentionNode {
  type: 'user';
  id: string;
  /** Legacy inline label (`<@U123|name>`), used when the context doesn't know the user. */
  label: string | null;
}

export interface ChannelMentionNode {
  type: 'channel';
  id: string;
  /** Channel name at posting time (`<#C123|general>`), without '#'. */
  label: string | null;
}

export interface BroadcastNode {
  type: 'broadcast';
  target: 'here' | 'channel' | 'everyone';
}

export interface UsergroupMentionNode {
  type: 'usergroup';
  id: string;
  /** Handle as sent by Slack, normally including the '@'. */
  label: string | null;
}

export interface DateNode {
  type: 'date';
  /** Unix seconds. */
  timestamp: number;
  /** Slack date template, e.g. `{date_short} at {time}`. */
  format: string;
  /** Optional safe link target. */
  url: string | null;
  /** Text Slack asks clients to show when they can't format; we display it. */
  fallback: string;
}

export interface EmojiNode {
  type: 'emoji';
  /** Shortcode without colons, e.g. `+1`. */
  name: string;
  /** `"2"`..`"6"`, or `"2-4"` for two-person emoji; null when none. */
  skinTone: string | null;
}

export type ReferenceNode =
  | LinkNode
  | UserMentionNode
  | ChannelMentionNode
  | BroadcastNode
  | UsergroupMentionNode
  | DateNode;

export type CodeChildNode = TextNode | ReferenceNode;

export type MrkdwnNode =
  | TextNode
  | BreakNode
  | BoldNode
  | ItalicNode
  | StrikeNode
  | CodeNode
  | PreNode
  | QuoteNode
  | EmojiNode
  | ReferenceNode;

export type BlockNode = PreNode | QuoteNode;

export function isBlockNode(node: MrkdwnNode): node is BlockNode {
  return node.type === 'pre' || node.type === 'quote';
}
