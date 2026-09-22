/**
 * Slack workspace addresses as the UI shows them. A team domain may arrive as the bare
 * subdomain ("9h") or as the host ("9h.slack.com"); this accepts either (and URLs).
 */

function hostOf(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.split(/[/?#]/)[0] ?? '';
  return s;
}

/** Letters, digits and hyphens, dot-separated: no port, credentials or stray characters. */
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * "9h" | "9h.slack.com" | "https://9h.slack.com/…" → "9h.slack.com". Null when empty or not a
 * plain host name on slack.com: it ends up in "Open in Slack" and copied links, and an imported
 * backup could name any site, so "evil.example", "evil.example:8080" or "a@b" are refused.
 */
export function workspaceHost(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const host = hostOf(domain);
  if (!host || host.length > 253 || !DNS_NAME.test(host)) return null;
  if (!host.includes('.')) return `${host}.slack.com`;
  return host.endsWith('.slack.com') ? host : null;
}
