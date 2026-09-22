/**
 * Slack mrkdwn → React elements. Never injects raw HTML; only http(s)/mailto hrefs are emitted.
 *
 * Usage:
 *   <MrkdwnProvider value={{ userLabel, channelLabel, customEmojiUrl, channelHref, highlight?, navigate? }}>
 *     <Mrkdwn text={message.text} />
 *   </MrkdwnProvider>
 *
 * `navigate` (optional, beyond the SPEC interface) lets mention clicks use the router
 * instead of a full page load. The Unicode emoji map (~60 KB) is a lazy chunk that starts loading
 * when this module is imported in a browser; components re-render when it lands. Await
 * `loadEmojiMap()` before the first render to avoid a brief `:smile:` → 😄 swap.
 *
 * Stable class names for styling (elements carry only minimal Tailwind utilities; theme colours
 * belong in app CSS, e.g. via CSS variables):
 *
 *   md-root              root element of every <Mrkdwn>; plus one of:
 *     md-block           <div>, `white-space: pre-wrap` (default)
 *     md-inline          <span>, breaks rendered as spaces (`inline` prop)
 *   md-jumbo             on the root when the message is only 1–23 emoji (rendered at 32px)
 *   md-bold              <strong>          *bold*
 *   md-italic            <em>              _italic_
 *   md-strike            <s>               ~strike~
 *   md-code              <code>            `inline code` (also ``` blocks in inline mode, + md-pre-inline)
 *   md-pre               <pre><code>       ``` blocks
 *   md-quote             <blockquote>      > quotes (a <span> + md-quote-inline in inline mode)
 *   md-link              <a target=_blank rel="noopener noreferrer">  external links
 *   md-mention           every mention chip, plus one of:
 *     md-mention-user        <a href=userHref(id) data-user-id title> (a <span> without userHref)  <@U123>
 *     md-mention-channel     <a href=channelHref(id) data-channel-id> (a <span> if not archived)
 *     md-mention-broadcast   <span>            <!here> <!channel> <!everyone>
 *     md-mention-usergroup   <span data-usergroup-id>          <!subteam^S123|@team>
 *   md-date              <time datetime title=formatted>   <!date^…|fallback>
 *   md-emoji             Unicode emoji <span role=img title=":name:">
 *   md-emoji-custom      custom emoji <img> (also has md-emoji)
 *   md-emoji-missing     <Emoji> with an unknown name, shown as literal ":name:" (inside <Mrkdwn>
 *                        unknown shortcodes are plain text, so "10:30:45" reads normally)
 *   md-highlight         <mark> around search terms from context.highlight
 */
export { Mrkdwn, MrkdwnNodes, type MrkdwnProps, type MrkdwnNodesProps } from './Mrkdwn';
export { MrkdwnProvider, useMrkdwnContext, defaultMrkdwnContext, type MrkdwnContext } from './context';
export { parseMrkdwn } from './parse';
export { mrkdwnToPlainText, nodesToPlainText } from './plain';
export { Emoji, type EmojiProps } from './Emoji';
export { formatSlackDate } from './date';
export { safeHref } from './url';
export { isJumbo, emojiOnlyCount, JUMBO_EMOJI_MAX } from './jumbo';
export { emojiFromShortcode, loadEmojiMap, isEmojiMapLoaded, useEmojiMapReady } from '../emoji';
export type {
  MrkdwnNode,
  TextNode,
  BreakNode,
  BoldNode,
  ItalicNode,
  StrikeNode,
  CodeNode,
  PreNode,
  QuoteNode,
  LinkNode,
  UserMentionNode,
  ChannelMentionNode,
  BroadcastNode,
  UsergroupMentionNode,
  DateNode,
  EmojiNode,
  ReferenceNode,
  CodeChildNode,
} from './types';
