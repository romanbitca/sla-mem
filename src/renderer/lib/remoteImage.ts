/**
 * Image sources for anything that doesn't come from the archive's own files: unfurl images,
 * service/author icons, avatars, bot icons, custom emoji, Block Kit images.
 *
 * The app talks to Slack and nothing else (PLAN §1.2), and the window's CSP only allows images
 * from `archive:`, `data:`, `blob:`, `https://*.slack-edge.com`, `https://*.slack.com` and
 * `https://slack-imgs.com`. So:
 *  - `archive:` URLs (our own downloaded files and thumbnails) pass through;
 *  - raster `data:` images pass through (never SVG: it can carry script);
 *  - https URLs on Slack's own image hosts pass through;
 *  - any other http(s) image goes through Slack's image proxy, exactly as Slack's clients do;
 *  - anything else (javascript:, relative paths, other schemes) gets no image at all.
 * Callers still hide the image on load errors: remote images disappear and proxies refuse.
 */

export const SLACK_IMAGE_PROXY = 'https://slack-imgs.com/';

const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp)[;,]/i;

/** Hosts the CSP allows as-is (subdomains only for the wildcards, like CSP matching). */
function isSlackImageHost(hostname: string): boolean {
  return hostname === 'slack-imgs.com' || hostname.endsWith('.slack-edge.com') || hostname.endsWith('.slack.com');
}

export function slackProxyUrl(url: string): string {
  return `${SLACK_IMAGE_PROXY}?c=1&o1=ro&url=${encodeURIComponent(url)}`;
}

export function remoteImageSrc(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const src = raw.trim();
  if (/^archive:\/\//i.test(src)) return src;
  if (RASTER_DATA_URL.test(src)) return src;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return null;
  // A port or credentials would not match the CSP's host sources: the proxy can still fetch it.
  const direct = url.protocol === 'https:' && !url.port && !url.username && !url.password;
  return direct && isSlackImageHost(url.hostname) ? url.href : slackProxyUrl(url.href);
}
