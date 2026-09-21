import { AlertIcon } from '../icons';
import { Button } from '../ui/Button';
import { tokenizeQuery } from './queryText';

/** Why the server couldn't use a modifier, in words the reader can act on. */
export function unresolvedReason(raw: string): string {
  const token = tokenizeQuery(raw)[0];
  if (!token?.key) return 'This filter wasn’t understood.';
  if (token.negated) return 'Only words can be excluded with “-”, not filters.';
  if (!token.value.trim()) return 'This filter is missing a value.';
  switch (token.key) {
    case 'from':
      return 'No one in the archive matches this name.';
    case 'in':
      return 'No channel or conversation in the archive matches this.';
    case 'has':
      return 'Use has:file, has:link, has:image, has:reaction or has:thread.';
    case 'is':
      return 'Only is:thread is supported.';
    case 'during':
      return 'Use a month like 2026-03 or a year like 2026.';
    default:
      return 'Use a date like 2026-03-01, “today” or “yesterday”.';
  }
}

export function UnresolvedNotice({ unresolved, onRemove }: { unresolved: string[]; onRemove: (raw: string) => void }) {
  return (
    <div role="alert" className="rounded-xl border border-warn/35 bg-warn-soft px-4 py-3 text-[13px]">
      <p className="flex items-center gap-2 font-semibold text-warn">
        <AlertIcon size={15} className="shrink-0" />
        {unresolved.length === 1 ? 'A filter couldn’t be applied' : 'Some filters couldn’t be applied'}, so nothing is
        shown
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {unresolved.map((raw, i) => (
          <li key={`${raw}:${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-muted">
            <code className="rounded border border-line bg-raised px-1.5 py-px font-mono text-xs text-ink">{raw}</code>
            <span className="min-w-0 flex-1">{unresolvedReason(raw)}</span>
            <Button size="sm" variant="secondary" onClick={() => onRemove(raw)} aria-label={`Remove ${raw}`}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Tip {
  example: string;
  /** What clicking the example puts in the search box. */
  insert: string;
  description: string;
}

const TIPS: Tip[] = [
  { example: 'from:@name', insert: 'from:', description: 'Messages from a person (from:me works too)' },
  { example: 'in:#channel', insert: 'in:#', description: 'In a channel; in:@name for a direct message' },
  { example: 'has:file', insert: 'has:', description: 'With files, links, images, reactions or threads' },
  { example: 'after:2026-01-31', insert: 'after:', description: 'Dates: before:, after:, on:, today, yesterday' },
  { example: 'during:2026-03', insert: 'during:', description: 'A whole month or year' },
  { example: '"exact phrase"', insert: '"', description: 'Words in this exact order' },
  { example: '-word', insert: '-', description: 'Leave out messages with a word' },
  { example: 'is:thread', insert: 'is:thread', description: 'Only thread parents and replies' },
];

/** Shown before the first search: a cheat sheet whose examples start a query. */
export function SearchTips({ onInsert }: { onInsert: (text: string) => void }) {
  return (
    <div className="mx-auto max-w-2xl py-10">
      <h2 className="text-center text-[15px] font-semibold text-ink">Search everything you’ve archived</h2>
      <p className="mx-auto mt-1 max-w-md text-center text-sm leading-relaxed text-ink-muted">
        Including history that Slack Free no longer shows. Words match as prefixes, so “deplo” finds “deployment”.
      </p>
      <ul className="mt-6 grid gap-2 sm:grid-cols-2">
        {TIPS.map((tip) => (
          <li key={tip.example}>
            <button
              type="button"
              onClick={() => onInsert(tip.insert)}
              className="focus-ring flex h-full w-full flex-col items-start gap-1 rounded-xl border border-line bg-raised px-3.5 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-hover"
            >
              <code className="font-mono text-[13px] font-semibold text-accent-text">{tip.example}</code>
              <span className="text-xs leading-snug text-ink-muted">{tip.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
