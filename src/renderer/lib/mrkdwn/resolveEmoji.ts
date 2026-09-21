/** Resolves a shortcode to something drawable: a Unicode emoji or a custom workspace image. */
import { emojiFromShortcode } from '../emoji';
import { safeImageSrc } from './url';

export type ResolvedEmoji = { kind: 'unicode'; native: string } | { kind: 'image'; src: string };

type CustomLookup = ((name: string) => string | undefined) | undefined;

/** `+1` + `3` → `+1::skin-tone-3`, the form Slack uses in text and reaction names. */
export function shortcodeWithTone(name: string, skinTone: string | null): string {
  return skinTone ? `${name}::skin-tone-${skinTone}` : name;
}

/**
 * Standard emoji first: Slack forbids custom emoji that shadow standard names, so the order only
 * matters for speed. Custom values of the form `alias:target` are followed (bounded, to survive
 * alias cycles), including aliases that point at standard emoji.
 */
export function resolveEmoji(
  name: string,
  skinTone: string | null,
  customEmojiUrl: CustomLookup,
): ResolvedEmoji | null {
  const native = emojiFromShortcode(shortcodeWithTone(name, skinTone));
  if (native) return { kind: 'unicode', native };
  return resolveCustom(name, customEmojiUrl, 0);
}

function resolveCustom(name: string, lookup: CustomLookup, depth: number): ResolvedEmoji | null {
  const value = depth < 4 ? lookup?.(name) : undefined;
  if (!value) return null;
  if (value.startsWith('alias:')) {
    const target = value.slice('alias:'.length);
    const native = emojiFromShortcode(target);
    return native ? { kind: 'unicode', native } : resolveCustom(target, lookup, depth + 1);
  }
  const src = safeImageSrc(value);
  return src ? { kind: 'image', src } : null;
}
