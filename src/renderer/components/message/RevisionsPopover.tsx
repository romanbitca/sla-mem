import { format } from 'date-fns';
import { Mrkdwn } from '../../lib/mrkdwn';
import { usePopover } from '../../lib/hooks';
import { useRevisions } from '../../lib/queries';
import { formatFullDateTime } from '../../lib/format';
import { tsToDate } from '../../lib/ts';
import { describeError } from '../../lib/api';
import { Spinner } from '../ui/Spinner';

export interface RevisionsPopoverProps {
  conversationId: string;
  ts: string;
  editedTs: string | null;
  revisionCount: number;
}

function editedTitle(editedTs: string | null): string {
  return editedTs ? `Edited ${formatFullDateTime(tsToDate(editedTs))}` : 'Edited';
}

/**
 * The "(edited)" marker. When the archive saw earlier versions it opens a popover listing them
 * (fetched lazily, since most readers never open it).
 */
export function RevisionsPopover({ conversationId, ts, editedTs, revisionCount }: RevisionsPopoverProps) {
  const { open, toggle, containerRef } = usePopover<HTMLSpanElement>();
  const revisions = useRevisions(conversationId, ts, open);

  if (revisionCount === 0) {
    return (
      <span className="text-xs text-ink-faint" title={editedTitle(editedTs)}>
        (edited)
      </span>
    );
  }

  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${editedTitle(editedTs)} · show ${revisionCount} earlier version${revisionCount === 1 ? '' : 's'}`}
        className="focus-ring rounded text-xs text-ink-faint underline decoration-dotted underline-offset-2 hover:text-ink-muted"
      >
        (edited)
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Edit history"
          className="absolute top-full left-0 z-40 mt-1.5 w-[min(420px,80vw)] animate-pop-in rounded-xl border border-line bg-raised p-1 shadow-pop"
        >
          <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">Earlier versions</p>
          <div className="scroll-thin max-h-80 overflow-y-auto">
            {revisions.isPending && (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-ink-muted">
                <Spinner size={14} /> Loading…
              </div>
            )}
            {revisions.isError && <p className="px-3 py-3 text-sm text-danger">{describeError(revisions.error)}</p>}
            {revisions.data?.length === 0 && (
              <p className="px-3 py-3 text-sm text-ink-muted">No earlier versions stored.</p>
            )}
            {revisions.data && revisions.data.length > 0 && (
              <ol className="flex flex-col">
                {[...revisions.data]
                  .sort((a, b) => b.seenAt - a.seenAt)
                  .map((rev, i) => (
                  <li key={`${rev.seenAt}:${i}`} className="rounded-lg px-3 py-2 hover:bg-hover">
                    <p className="mb-0.5 text-xs text-ink-faint">
                      {rev.editedTs
                        ? `Version from ${format(tsToDate(rev.editedTs), 'MMM d, yyyy h:mm a')}`
                        : 'Original version'}
                      {' · '}
                      archived {format(new Date(rev.seenAt), 'MMM d, yyyy')}
                    </p>
                    <div className="msg-text text-sm text-ink">
                      <Mrkdwn text={rev.text} />
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
