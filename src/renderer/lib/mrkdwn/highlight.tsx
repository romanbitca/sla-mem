import { Fragment, type ReactNode } from 'react';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One case-insensitive alternation; longest terms first so "foobar" wins over "foo". */
export function buildHighlightRegex(terms: readonly string[] | undefined): RegExp | null {
  const cleaned = [...new Set((terms ?? []).map((t) => t.trim()).filter(Boolean))];
  if (cleaned.length === 0) return null;
  cleaned.sort((a, b) => b.length - a.length);
  return new RegExp(cleaned.map(escapeRegExp).join('|'), 'giu');
}

/** Splits text into strings and <mark> elements. Plain string when nothing matches. */
export function highlightText(text: string, re: RegExp | null): ReactNode {
  if (!re || !text) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (!m[0]) continue;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <mark key={start} className="md-highlight">
        {m[0]}
      </mark>,
    );
    last = start + m[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <Fragment>{parts}</Fragment>;
}
