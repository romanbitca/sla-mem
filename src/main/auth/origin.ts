/**
 * Where the Slack *web* client lives. Production is always https://app.slack.com; tests and the
 * development mock Slack point it at a local fake (never honoured by packaged builds, see
 * main/index.ts), so the whole sign-in flow can run without Slack.
 */

export const DEFAULT_WEB_ORIGIN = 'https://app.slack.com';

/** Normalized origin (no trailing slash) from an explicit value, or the default. */
export function resolveWebOrigin(explicit?: string): string {
  const raw = explicit?.trim() || DEFAULT_WEB_ORIGIN;
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_WEB_ORIGIN;
  }
}

export function isDefaultWebOrigin(origin: string): boolean {
  return origin === DEFAULT_WEB_ORIGIN;
}

/** `*.slack.com` (and slack.com itself). */
export function isSlackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'slack.com' || h.endsWith('.slack.com');
}

/**
 * Hosts we may send the session cookie to: Slack itself, plus the overridden web origin's host
 * when SLACK_WEB_ORIGIN points at a local fake.
 */
export function isTrustedSessionHost(hostname: string, webOrigin: string): boolean {
  if (isSlackHost(hostname)) return true;
  return !isDefaultWebOrigin(webOrigin) && hostname.toLowerCase() === new URL(webOrigin).hostname.toLowerCase();
}

/**
 * Does a cookie `domain` (as reported by CDP, e.g. ".slack.com" or "127.0.0.1") belong to the
 * session's origin? Slack scopes `d` to `.slack.com`.
 */
export function isSessionCookieDomain(domain: string, webOrigin: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  if (isDefaultWebOrigin(webOrigin)) return d === 'slack.com' || d.endsWith('.slack.com');
  const host = new URL(webOrigin).hostname.toLowerCase();
  return d === host || host.endsWith(`.${d}`);
}

/** Is `url` a page of the Slack web client (where `localStorage.localConfig_v2` lives)? */
export function isWebClientUrl(url: string, webOrigin: string): boolean {
  try {
    return new URL(url).origin === webOrigin;
  } catch {
    return false;
  }
}

/**
 * URL of a workspace's web pages. With the default origin that's the workspace's own host
 * (`https://9h.slack.com/`); a fake SLACK_WEB_ORIGIN serves every workspace itself.
 */
export function workspaceBaseUrl(workspaceUrl: string, webOrigin: string): string {
  return isDefaultWebOrigin(webOrigin) ? workspaceUrl : `${webOrigin}/`;
}
