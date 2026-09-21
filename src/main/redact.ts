/**
 * Secret redaction, applied centrally to everything that is logged, stored as a run log/error,
 * returned over IPC or shown in the UI (PLAN §3.5, pitfall 20). Slack web sessions are an
 * `xoxc-` token plus the `d` cookie (`xoxd-…`, usually URL-encoded, so `%2F`/`%3D` appear in it).
 */

// xoxc-, xoxd-, xoxp-, xoxb-, xoxe- … and xapp- tokens, including URL-encoding and base64 characters.
const SLACK_SECRET_RE = /\b(xox[a-z]|xapp)-[A-Za-z0-9%._~+/=-]+/gi;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/%=-]+/gi;
const COOKIE_HEADER_RE = /(\bCookie:\s*)[^\r\n]+/gi;
const COOKIE_D_RE = /(\bd(?:-s)?=)[^;\s"']+/g;

/** Go's url.QueryEscape, which is how the `d` cookie value is usually stored. */
function queryEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}

/**
 * Masks the given secrets (and their URL-encoded/decoded forms), and anything shaped like a Slack
 * token, a bearer credential or a cookie value.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = String(text);
  const variants = new Set<string>();
  for (const s of secrets) {
    if (!s || s.length < 6) continue;
    variants.add(s);
    variants.add(queryEscape(s));
    try {
      variants.add(decodeURIComponent(s));
    } catch {
      // Not valid percent-encoding: the raw value is enough.
    }
  }
  // Longest first, so a decoded form never leaves the tail of an encoded one behind.
  for (const v of [...variants].sort((a, b) => b.length - a.length)) {
    if (v.length >= 6) out = out.split(v).join('[redacted]');
  }
  return out
    .replace(BEARER_RE, '$1[redacted]')
    .replace(COOKIE_HEADER_RE, '$1[redacted]')
    .replace(COOKIE_D_RE, '$1[redacted]')
    .replace(SLACK_SECRET_RE, (_m, prefix: string) => `${prefix}-[redacted]`);
}

/** The message of any thrown value, redacted. */
export function safeErrorMessage(err: unknown, secrets: readonly (string | null | undefined)[] = []): string {
  const raw = err instanceof Error ? err.message || err.name : String(err);
  return redactSecrets(raw, secrets);
}

/** `true` when `text` still contains something that looks like a Slack secret (for tests/asserts). */
export function containsSlackSecret(text: string): boolean {
  return /\bxox[a-z]-(?!\[redacted\])[A-Za-z0-9]/i.test(text);
}
