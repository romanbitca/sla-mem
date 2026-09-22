import { useId, useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import type { StyleCheckDTO, StyleExampleDTO } from '../../../shared/types';
import { messagePath } from '../../lib/links';
import { checkCopy } from '../../lib/style';
import { CheckIcon, ChevronDownIcon, PenNibIcon } from '../icons';
import { Card } from '../ui/Card';

/**
 * The writing checks: what to work on first, then the habits you already have. Each row folds out
 * to what it means and, for a tip, one of your messages as you wrote it and as it could read.
 */
export function WritingCard({ checks, englishCount }: { checks: StyleCheckDTO[]; englishCount: number }) {
  return (
    <Card
      title="How you write"
      icon={<PenNibIcon size={15} />}
      aside={<span className="text-xs text-ink-faint">Rules, worked out on this computer</span>}
    >
      {checks.length ? (
        <ul className="-mx-2 flex flex-col gap-px">
          {checks.map((c) => (
            <li key={c.id}>
              <CheckRow check={c} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-ink-muted">
          {englishCount
            ? 'Too few messages to judge yet.'
            : 'These checks read English messages, and there aren’t enough of yours in English yet.'}
        </p>
      )}
    </Card>
  );
}

function CheckRow({ check }: { check: StyleCheckDTO }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const copy = checkCopy(check);
  return (
    <div className={clsx('rounded-lg', open && 'bg-hover/50')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="focus-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13.5px] transition-colors hover:bg-hover"
      >
        {check.good ? (
          <CheckIcon size={15} className="shrink-0 text-success" aria-label="A habit you have" role="img" />
        ) : (
          <span aria-label="Worth working on" role="img" className="mx-[3.5px] size-2 shrink-0 rounded-full bg-warn" />
        )}
        <span className="min-w-0 flex-1 truncate text-ink">{copy.title}</span>
        <span className={clsx('shrink-0 text-xs tabular-nums', check.good ? 'text-ink-faint' : 'text-ink-muted')}>
          {copy.stat}
        </span>
        <ChevronDownIcon
          size={14}
          className={clsx('shrink-0 text-ink-faint transition-transform duration-150', !open && '-rotate-90')}
        />
      </button>
      {open && (
        <div id={panelId} className="flex flex-col gap-2.5 px-2 pt-0.5 pb-3 pl-8">
          <p className="text-[13px] leading-relaxed text-ink-muted">{copy.detail}</p>
          {check.example && <Example example={check.example} />}
        </div>
      )}
    </div>
  );
}

/** One of your messages, as you wrote it and as it could read, and a way to open it. */
export function Example({
  example,
}: {
  example: Pick<StyleExampleDTO, 'before' | 'after'> & Partial<StyleExampleDTO>;
}) {
  return (
    <figure className="flex flex-col gap-2 rounded-xl border border-line bg-raised px-3.5 py-3 text-[13px] leading-relaxed">
      <div>
        <figcaption className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">You wrote</figcaption>
        <p className="whitespace-pre-line text-ink-muted">{example.before}</p>
      </div>
      {example.after && (
        <div>
          <p className="text-[11px] font-semibold tracking-wide text-success uppercase">Could read</p>
          <p className="whitespace-pre-line text-ink">{example.after}</p>
        </div>
      )}
      {example.conversationId && example.ts && (
        <Link
          to={messagePath({
            conversationId: example.conversationId,
            ts: example.ts,
            threadTs: example.threadTs ?? null,
            isReply: example.isReply ?? false,
          })}
          className="focus-ring self-start rounded-sm text-xs font-medium text-accent-text hover:underline"
        >
          Open the message
        </Link>
      )}
    </figure>
  );
}
