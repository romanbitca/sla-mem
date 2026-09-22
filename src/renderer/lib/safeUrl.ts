/**
 * Only http(s) and mailto links are ever rendered as hrefs. Message content and unfurls are
 * untrusted: a `javascript:` or `data:` URL must render as inert text. (Main opens clicked links
 * in the system browser and refuses any other scheme too; this keeps them from looking like
 * links at all.) Images go through `remoteImageSrc` in ./remoteImage.
 */
import { safeHref as normalizedSafeHref } from './mrkdwn/url';

export { linkTitle } from './mrkdwn/url';

export function safeHref(url: string | null | undefined): string | undefined {
  return normalizedSafeHref(url) ?? undefined;
}

/** Slack attachment colors are hex without '#', or the legacy names good/warning/danger. */
export function attachmentColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  const named: Record<string, string> = { good: '#2eb67d', warning: '#ecb22e', danger: '#e01e5a' };
  if (named[color]) return named[color];
  const hex = color.startsWith('#') ? color.slice(1) : color;
  return /^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? `#${hex}` : undefined;
}
