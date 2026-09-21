import type { CSSProperties, JSX } from 'react';
import clsx from 'clsx';
import { splitShortcode, useEmojiMapReady } from '../emoji';
import { useMrkdwnContext } from './context';
import { resolveEmoji, shortcodeWithTone } from './resolveEmoji';

export interface EmojiProps {
  /** Shortcode with or without colons, optionally with a skin tone: `+1::skin-tone-3`. */
  name: string;
  /** Pixel size; defaults to the surrounding font size. */
  size?: number;
  className?: string;
}

/**
 * A single emoji: Unicode glyph, custom workspace image (from the MrkdwnProvider), or the literal
 * `:name:` when neither is known (or while the emoji map is still loading).
 */
export function Emoji({ name, size, className }: EmojiProps): JSX.Element {
  const ctx = useMrkdwnContext();
  useEmojiMapReady();
  const parsed = splitShortcode(name) ?? { name, skinTone: null };
  const drawn = renderEmoji(parsed.name, parsed.skinTone, ctx.customEmojiUrl, size, className);
  if (drawn) return drawn;
  return <span className={clsx('md-emoji-missing', className)}>{`:${shortcodeWithTone(parsed.name, parsed.skinTone)}:`}</span>;
}

/**
 * Shared by <Emoji> and <Mrkdwn> (which subscribes to the emoji map once for all its emoji).
 * Returns null for unknown shortcodes so each caller picks its literal fallback: inside message
 * text `:30:` in "10:30:45" must read as ordinary text.
 */
export function renderEmoji(
  name: string,
  skinTone: string | null,
  customEmojiUrl: ((name: string) => string | undefined) | undefined,
  size?: number,
  className?: string,
): JSX.Element | null {
  const title = `:${shortcodeWithTone(name, skinTone)}:`;
  const resolved = resolveEmoji(name, skinTone, customEmojiUrl);

  if (resolved?.kind === 'unicode') {
    const style: CSSProperties | undefined = size ? { fontSize: size, lineHeight: 1 } : undefined;
    return (
      <span className={clsx('md-emoji', className)} role="img" aria-label={name.replace(/_/g, ' ')} title={title} style={style}>
        {resolved.native}
      </span>
    );
  }
  if (resolved?.kind === 'image') {
    // Sized in em by default so custom emoji line up with text at any font size.
    const dim = size ? `${size}px` : '1.25em';
    const style: CSSProperties = {
      width: dim,
      height: dim,
      display: 'inline-block',
      objectFit: 'contain',
      verticalAlign: size ? 'middle' : '-0.25em',
    };
    return (
      <img
        className={clsx('md-emoji md-emoji-custom', className)}
        src={resolved.src}
        alt={title}
        title={title}
        loading="lazy"
        decoding="async"
        draggable={false}
        style={style}
      />
    );
  }
  return null;
}
