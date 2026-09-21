/** Slack shows messages that are only emoji ("jumbomoji") larger, up to this many emoji. */
import type { EmojiNode, MrkdwnNode } from './types';

export const JUMBO_EMOJI_MAX = 23;
/** Pixel size of jumbomoji. */
export const JUMBO_EMOJI_SIZE = 32;

// Emoji typed as raw Unicode (bots, or text derived from blocks): pictographs, skin-tone
// modifiers, flags, and the joiners inside sequences (ZWJ, VS16, keycap, tag characters).
// Keycap digits are left out on purpose: `\p{Emoji}` would make "123" count as three emoji.
const NATIVE_EMOJI_RE =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[\u{E0020}-\u{E007F}]|\s)+$/u;

function countGraphemes(s: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let n = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)) n++;
    return n;
  }
  return (s.match(/\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu) ?? []).length;
}

/**
 * Number of emoji if the message consists only of emoji and whitespace, else 0. Shortcodes the
 * renderer can't draw (`isKnown` false) show as `:text:`, so they disqualify the message.
 */
export function emojiOnlyCount(nodes: readonly MrkdwnNode[], isKnown: (node: EmojiNode) => boolean): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'br') continue;
    if (node.type === 'emoji') {
      if (!isKnown(node)) return 0;
      count++;
    } else if (node.type === 'text') {
      if (node.text.trim() === '') continue;
      if (!NATIVE_EMOJI_RE.test(node.text)) return 0;
      count += countGraphemes(node.text.replace(/\s+/g, ''));
    } else {
      return 0;
    }
    if (count > JUMBO_EMOJI_MAX) return count;
  }
  return count;
}

export function isJumbo(nodes: readonly MrkdwnNode[], isKnown: (node: EmojiNode) => boolean): boolean {
  const n = emojiOnlyCount(nodes, isKnown);
  return n > 0 && n <= JUMBO_EMOJI_MAX;
}
