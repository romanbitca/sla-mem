/**
 * Slack's angle-bracket references: `<@U1>`, `<#C1|name>`, `<!here>`, `<!subteam^S1|@team>`,
 * `<!date^ts^format^link|fallback>`, `<https://…|label>`, `<mailto:…>`.
 */
import type { ReferenceNode, TextNode } from './types';
import { displayUrl, safeHref, unescapeEntities } from './url';

const ID_RE = /^[A-Z0-9]{2,}$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const BROADCASTS: Record<string, 'here' | 'channel' | 'everyone'> = {
  here: 'here',
  channel: 'channel',
  everyone: 'everyone',
  group: 'channel', // legacy spelling of @channel
};

/**
 * Parses the inside of `<…>` (still entity-escaped). Returns null when it isn't a Slack
 * reference at all (e.g. text that merely contains `<`), so the caller keeps it literal.
 * Unsafe links (javascript:, data:, …) come back as plain text, never as a link.
 */
export function parseReference(inner: string): ReferenceNode | TextNode | null {
  if (!inner || inner.includes('\n')) return null;
  const bar = inner.indexOf('|');
  const target = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? null : unescapeEntities(inner.slice(bar + 1));
  switch (target[0]) {
    case '@':
      return ID_RE.test(target.slice(1)) ? { type: 'user', id: target.slice(1), label: label || null } : null;
    case '#':
      return ID_RE.test(target.slice(1)) ? { type: 'channel', id: target.slice(1), label: label || null } : null;
    case '!':
      return parseSpecial(target.slice(1), label);
    default:
      return parseLink(target, label);
  }
}

function parseSpecial(command: string, label: string | null): ReferenceNode | TextNode | null {
  const parts = command.split('^');
  const head = parts[0];
  if (head in BROADCASTS) return { type: 'broadcast', target: BROADCASTS[head] };
  if (head === 'subteam' && parts[1]) return { type: 'usergroup', id: parts[1], label: label || null };
  if (head === 'date') return parseDate(parts, label);
  if (!head) return null;
  // Unknown command (future Slack syntax): show what Slack would show as fallback.
  return { type: 'text', text: label || `@${unescapeEntities(head)}` };
}

function parseDate(parts: string[], label: string | null): ReferenceNode | TextNode {
  const [, ts, format, link] = parts;
  const fallback = label ?? '';
  if (!ts || !/^-?\d{1,12}$/.test(ts)) return { type: 'text', text: fallback };
  return {
    type: 'date',
    timestamp: Number(ts),
    format: unescapeEntities(format ?? ''),
    url: link ? safeHref(unescapeEntities(link)) : null,
    fallback,
  };
}

function parseLink(target: string, label: string | null): ReferenceNode | TextNode | null {
  const url = unescapeEntities(target);
  if (!SCHEME_RE.test(url)) return null;
  const href = safeHref(url);
  const text = label || displayUrl(url);
  if (!href) return { type: 'text', text };
  return { type: 'link', url: href, label: text };
}
