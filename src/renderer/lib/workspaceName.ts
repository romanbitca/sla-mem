/**
 * Slack workspace names as the UI shows them. The server may store a team domain as the bare
 * subdomain ("9h") or as the host ("9h.slack.com"); these accept either (and URLs).
 */

function hostOf(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '');
  s = s.split(/[/?#]/)[0] ?? '';
  return s;
}

/** "9h" | "9h.slack.com" | "https://9h.slack.com/…" → "9h.slack.com". Null when empty. */
export function workspaceHost(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const host = hostOf(domain);
  if (!host) return null;
  return host.includes('.') ? host : `${host}.slack.com`;
}

/** "9h.slack.com" → "9h" (for file names and CLI examples). Null when empty. */
export function workspaceSlug(domain: string | null | undefined): string | null {
  const host = workspaceHost(domain);
  if (!host) return null;
  return host.endsWith('.slack.com') ? host.slice(0, -'.slack.com'.length) : host;
}
