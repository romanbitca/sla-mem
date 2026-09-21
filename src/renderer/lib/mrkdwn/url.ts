/**
 * URL and entity helpers shared by the parser and renderers. Message text is untrusted:
 * anything that isn't http(s)/mailto must never become an href.
 */

const ENTITY_RE = /&(amp|lt|gt);/g;
const ENTITY_CHARS: Record<string, string> = { amp: '&', lt: '<', gt: '>' };

/**
 * Slack escapes exactly `&`, `<` and `>` in message text. A single pass means `&amp;lt;`
 * becomes the literal text `&lt;` (as the author typed it), not `<`.
 */
export function unescapeEntities(s: string): string {
  return s.indexOf('&') === -1 ? s : s.replace(ENTITY_RE, (_, name: string) => ENTITY_CHARS[name]);
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Normalized href when the URL is absolute http(s) with a host, or mailto; otherwise null. */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (url.protocol !== 'mailto:' && !url.hostname) return null;
  return url.href;
}

/**
 * Image sources for custom emoji: Slack's emoji CDN, other http(s) images through Slack's image
 * proxy, and inline raster data URIs. Never `javascript:` or SVG data (see ../remoteImage).
 */
export { remoteImageSrc as safeImageSrc } from '../remoteImage';

/** Text to show for a link without a label: mailto links show just the address. */
export function displayUrl(url: string): string {
  return /^mailto:/i.test(url) ? url.slice('mailto:'.length) : url;
}

const TRAILING_PUNCTUATION = new Set(['.', ',', ':', ';', '!', '?', "'", '"', '*', '_', '~']);
const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = s.indexOf(ch); i !== -1; i = s.indexOf(ch, i + 1)) n++;
  return n;
}

/**
 * Length of a bare URL candidate after dropping what is almost certainly sentence punctuation:
 * `see https://x.com/a.` → no dot; `(https://x.com/a_(b))` keeps the balanced `)`;
 * `*https://x.com*` leaves the `*` for the bold parser.
 */
export function trimBareUrl(raw: string): number {
  // `<`/`>` can't be part of a URL; in escaped Slack text they appear as entities.
  let end = raw.length;
  const entity = raw.search(/&(lt|gt);/);
  if (entity !== -1) end = entity;

  const body = raw.slice(0, end);
  const unbalanced: Record<string, number> = {};
  for (const [close, open] of Object.entries(CLOSER_TO_OPENER)) {
    unbalanced[close] = countChar(body, close) - countChar(body, open);
  }
  while (end > 0) {
    // A trailing escaped `&` is punctuation too; drop the whole entity, not just its `;`.
    if (raw.endsWith('&amp;', end)) {
      end -= 5;
      continue;
    }
    const ch = raw[end - 1];
    if (TRAILING_PUNCTUATION.has(ch)) {
      end--;
    } else if (ch in CLOSER_TO_OPENER && unbalanced[ch] > 0) {
      unbalanced[ch]--;
      end--;
    } else {
      break;
    }
  }
  return end;
}
