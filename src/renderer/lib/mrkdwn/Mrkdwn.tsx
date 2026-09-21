import { Fragment, useMemo, type JSX, type MouseEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { loadEmojiMap, useEmojiMapReady } from '../emoji';
import { useMrkdwnContext, type MrkdwnContext } from './context';
import { renderEmoji } from './Emoji';
import { buildHighlightRegex, highlightText } from './highlight';
import { isJumbo, JUMBO_EMOJI_SIZE } from './jumbo';
import { BROADCAST_LABEL, channelMentionLabel, dateLabel, userMentionLabel, usergroupLabel } from './labels';
import { slackDateTitle } from './date';
import { parseMrkdwn } from './parse';
import { resolveEmoji, shortcodeWithTone } from './resolveEmoji';
import { isBlockNode, type CodeChildNode, type DateNode, type MrkdwnNode } from './types';
import { safeHref } from './url';

// Start fetching the emoji chunk as soon as the renderer is part of the page, in parallel with
// the first API calls, so the first messages rarely flash `:smile:` before the glyph arrives.
if (typeof document !== 'undefined') loadEmojiMap().catch(() => undefined);

export interface MrkdwnProps {
  text: string;
  className?: string;
  /** Single-line contexts (topics, previews): a <span> root, breaks become spaces, no jumbomoji. */
  inline?: boolean;
}

interface RenderEnv {
  ctx: MrkdwnContext;
  inline: boolean;
  highlight: RegExp | null;
  /** Set for jumbomoji messages. */
  emojiSize: number | undefined;
}

/** The context's search terms as one regex, rebuilt only when the terms change. */
function useHighlightRegex(ctx: MrkdwnContext): RegExp | null {
  // Callers often pass a fresh array each render; key the regex on its contents instead.
  const highlightKey = ctx.highlight?.length ? JSON.stringify(ctx.highlight) : '';
  return useMemo(
    () => buildHighlightRegex(highlightKey ? (JSON.parse(highlightKey) as string[]) : undefined),
    [highlightKey],
  );
}

export function Mrkdwn({ text, className, inline = false }: MrkdwnProps): JSX.Element {
  const ctx = useMrkdwnContext();
  useEmojiMapReady(); // re-render once shortcodes can be resolved
  const nodes = useMemo(() => parseMrkdwn(text), [text]);
  const highlight = useHighlightRegex(ctx);
  const jumbo = !inline && isJumbo(nodes, (n) => resolveEmoji(n.name, n.skinTone, ctx.customEmojiUrl) !== null);
  const env: RenderEnv = { ctx, inline, highlight, emojiSize: jumbo ? JUMBO_EMOJI_SIZE : undefined };

  const classes = clsx(
    'md-root',
    inline ? 'md-inline' : 'md-block whitespace-pre-wrap wrap-anywhere',
    jumbo && 'md-jumbo',
    className,
  );
  return inline ? (
    <span className={classes}>{renderNodes(nodes, env)}</span>
  ) : (
    <div className={classes}>{renderNodes(nodes, env)}</div>
  );
}

export interface MrkdwnNodesProps {
  /** An AST built elsewhere (Block Kit rich text); links in it are re-checked when rendered. */
  nodes: readonly MrkdwnNode[];
  className?: string;
  inline?: boolean;
}

/**
 * Renders an already-built AST exactly like parsed mrkdwn (mentions, links, emoji, dates and
 * search highlights), so Block Kit rich text and message text look the same. Never jumbo.
 */
export function MrkdwnNodes({ nodes, className, inline = false }: MrkdwnNodesProps): JSX.Element {
  const ctx = useMrkdwnContext();
  useEmojiMapReady();
  const highlight = useHighlightRegex(ctx);
  const env: RenderEnv = { ctx, inline, highlight, emojiSize: undefined };
  const classes = clsx('md-root', inline ? 'md-inline' : 'md-block whitespace-pre-wrap wrap-anywhere', className);
  return inline ? (
    <span className={classes}>{renderNodes(nodes, env)}</span>
  ) : (
    <div className={classes}>{renderNodes(nodes, env)}</div>
  );
}

function renderNodes(nodes: readonly MrkdwnNode[], env: RenderEnv): ReactNode[] {
  const out: ReactNode[] = [];
  nodes.forEach((node, i) => {
    const spaced = env.inline && isBlockNode(node);
    // Inline mode flattens blocks, so keep them from gluing to their neighbours.
    if (spaced && i > 0) out.push(' ');
    out.push(renderNode(node, i, env));
    if (spaced && i < nodes.length - 1) out.push(' ');
  });
  return out;
}

function renderText(text: string, key: number, env: RenderEnv): ReactNode {
  if (env.emojiSize && text.trim()) {
    // Only reachable for jumbomoji messages: this text is raw Unicode emoji.
    return (
      <span key={key} className="md-emoji" style={{ fontSize: env.emojiSize, lineHeight: 1 }}>
        {text}
      </span>
    );
  }
  return <Fragment key={key}>{highlightText(text, env.highlight)}</Fragment>;
}

function renderNode(node: MrkdwnNode, key: number, env: RenderEnv): ReactNode {
  switch (node.type) {
    case 'text':
      return renderText(node.text, key, env);
    case 'br':
      return env.inline ? ' ' : <br key={key} />;
    case 'bold':
      return (
        <strong key={key} className="md-bold font-bold">
          {renderNodes(node.children, env)}
        </strong>
      );
    case 'italic':
      return (
        <em key={key} className="md-italic italic">
          {renderNodes(node.children, env)}
        </em>
      );
    case 'strike':
      return (
        <s key={key} className="md-strike line-through">
          {renderNodes(node.children, env)}
        </s>
      );
    case 'code':
      return (
        <code key={key} className="md-code font-mono">
          {renderNodes(node.children, env)}
        </code>
      );
    case 'pre':
      if (env.inline) {
        return (
          <code key={key} className="md-code md-pre-inline font-mono">
            {renderNodes(node.children, env)}
          </code>
        );
      }
      return (
        <pre key={key} className="md-pre font-mono whitespace-pre-wrap wrap-anywhere">
          <code>{renderNodes(node.children, env)}</code>
        </pre>
      );
    case 'quote':
      if (env.inline) {
        return (
          <span key={key} className="md-quote md-quote-inline">
            {renderNodes(node.children, env)}
          </span>
        );
      }
      return (
        <blockquote key={key} className="md-quote border-l-4 pl-3">
          {renderNodes(node.children, env)}
        </blockquote>
      );
    case 'emoji': {
      const drawn = renderEmoji(node.name, node.skinTone, env.ctx.customEmojiUrl, env.emojiSize);
      if (drawn) return <Fragment key={key}>{drawn}</Fragment>;
      return (
        <Fragment key={key}>
          {highlightText(`:${shortcodeWithTone(node.name, node.skinTone)}:`, env.highlight)}
        </Fragment>
      );
    }
    default:
      return renderReference(node, key, env);
  }
}

function renderReference(node: CodeChildNode, key: number, env: RenderEnv): ReactNode {
  switch (node.type) {
    case 'text':
      return renderText(node.text, key, env);
    case 'link': {
      // Re-checked here so hand-built ASTs can't smuggle in a javascript: URL.
      const href = safeHref(node.url);
      if (!href) return renderText(node.label, key, env);
      return (
        <a key={key} className="md-link" href={href} target="_blank" rel="noopener noreferrer">
          {highlightText(node.label, env.highlight)}
        </a>
      );
    }
    case 'user': {
      const label = userMentionLabel(node, env.ctx);
      const known = env.ctx.userLabel(node.id) !== undefined;
      return (
        <span
          key={key}
          className="md-mention md-mention-user rounded px-0.5"
          title={known ? `@${label}` : `@${label} (${node.id})`}
          data-user-id={node.id}
        >
          @{highlightText(label, env.highlight)}
        </span>
      );
    }
    case 'channel':
      return renderChannel(node.id, channelMentionLabel(node, env.ctx), key, env);
    case 'broadcast':
      return (
        <span key={key} className="md-mention md-mention-broadcast rounded px-0.5">
          {BROADCAST_LABEL[node.target]}
        </span>
      );
    case 'usergroup':
      return (
        <span key={key} className="md-mention md-mention-usergroup rounded px-0.5" data-usergroup-id={node.id}>
          {usergroupLabel(node)}
        </span>
      );
    case 'date':
      return renderDate(node, key, env);
  }
}

function renderChannel(id: string, label: string, key: number, env: RenderEnv): ReactNode {
  const text = <>#{highlightText(label, env.highlight)}</>;
  // Channels outside the archive have nowhere to go; show them without a link.
  if (env.ctx.channelLabel(id) === undefined) {
    return (
      <span key={key} className="md-mention md-mention-channel rounded px-0.5" data-channel-id={id} title={`#${label}`}>
        {text}
      </span>
    );
  }
  const href = env.ctx.channelHref(id);
  const navigate = env.ctx.navigate;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!navigate || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a
      key={key}
      className="md-mention md-mention-channel rounded px-0.5"
      href={href}
      onClick={onClick}
      data-channel-id={id}
    >
      {text}
    </a>
  );
}

function renderDate(node: DateNode, key: number, env: RenderEnv): ReactNode {
  const d = new Date(node.timestamp * 1000);
  const time = (
    <time
      className="md-date"
      dateTime={Number.isFinite(d.getTime()) ? d.toISOString() : undefined}
      title={slackDateTitle(node.timestamp, node.format)}
    >
      {highlightText(dateLabel(node), env.highlight)}
    </time>
  );
  const href = safeHref(node.url);
  if (!href) return <Fragment key={key}>{time}</Fragment>;
  return (
    <a key={key} className="md-link" href={href} target="_blank" rel="noopener noreferrer">
      {time}
    </a>
  );
}
