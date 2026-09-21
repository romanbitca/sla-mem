import { memo, useState } from 'react';
import clsx from 'clsx';
import { remoteImageSrc } from '../../lib/remoteImage';

/** Muted hues that keep white initials legible in both themes. */
const PALETTE = ['#5b6fd6', '#2f8f83', '#b0603a', '#8a5bb5', '#3f7fb5', '#a64d6d', '#5f8a3c', '#7a6a4f'];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initialsFor(label: string): string {
  const words = label
    .replace(/[^\p{L}\p{N}\s._-]/gu, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...words[0]][0] ?? '';
  const second = words.length > 1 ? ([...words[words.length - 1]][0] ?? '') : '';
  return (first + second).toUpperCase();
}

export interface AvatarProps {
  /** Seed for the fallback color (user id / bot id); defaults to the label. */
  seed?: string | null;
  label: string;
  src?: string | null;
  size?: number;
  className?: string;
  /** Rendered as decoration next to a visible name by default. */
  decorative?: boolean;
}

/**
 * Image avatar that falls back to colored initials when missing or when the remote image fails
 * (offline, or a proxy refusing it). Sources go through Slack's hosts or proxy only.
 */
export const Avatar = memo(function Avatar({ seed, label, src, size = 36, className, decorative = true }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const safeSrc = remoteImageSrc(src);
  const showImage = safeSrc && failedSrc !== safeSrc;
  const radius = Math.max(4, Math.round(size * 0.22));
  const style = { width: size, height: size, borderRadius: radius };

  if (showImage) {
    return (
      <img
        src={safeSrc}
        alt={decorative ? '' : label}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(safeSrc)}
        className={clsx('shrink-0 bg-inset object-cover', className)}
        style={style}
      />
    );
  }

  const color = PALETTE[hashString(seed || label) % PALETTE.length];
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center font-semibold text-white select-none',
        className,
      )}
      style={{ ...style, backgroundColor: color, fontSize: Math.max(9, Math.round(size * 0.38)) }}
    >
      {initialsFor(label)}
    </span>
  );
});
