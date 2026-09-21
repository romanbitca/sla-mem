import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDirectory } from '../../lib/directory';
import { formatDate, formatDayLabel, pluralize } from '../../lib/format';
import { groupByDay, localDayKey } from '../../lib/grouping';
import { useKeydown } from '../../lib/hooks';
import { useThread } from '../../lib/queries';
import { tsToMs } from '../../lib/ts';
import { AlertIcon, CloseIcon } from '../icons';
import { conversationTitle } from '../conversation/ConversationIcon';
import { findMessageElement } from '../conversation/scrollAnchor';
import { MessageItem } from '../message/MessageItem';
import { EmptyState, ErrorState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { LoadingState } from '../ui/Spinner';

export interface ThreadPanelProps {
  conversationId: string;
  threadTs: string;
  /** A reply to scroll to and highlight (deep link `?thread=…&ts=…`). */
  highlightTs?: string | null;
  onClose: () => void;
}

const HIGHLIGHT_MS = 3000;

/** Right-hand panel: thread parent plus all archived replies. Esc or the close button dismisses it. */
export function ThreadPanel({ conversationId, threadTs, highlightTs = null, onClose }: ThreadPanelProps) {
  const thread = useThread(conversationId, threadTs);
  const conversation = useDirectory().conversations.get(conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [flashTs, setFlashTs] = useState<string | null>(null);

  useKeydown((e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    onClose();
  });

  const data = thread.data;
  const replies = data?.replies;
  const days = useMemo(() => groupByDay(replies ?? []), [replies]);
  const parentDay = data?.parent ? localDayKey(tsToMs(data.parent.ts)) : null;

  // Bring the linked reply into view once it's rendered.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!data || !container || !highlightTs) return;
    const el = findMessageElement(container, highlightTs);
    if (!el) return;
    const c = container.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    container.scrollTop += t.top - c.top - Math.max(0, (container.clientHeight - t.height) / 2);
    setFlashTs(highlightTs);
  }, [data, highlightTs]);

  useEffect(() => {
    if (!flashTs) return;
    const timer = setTimeout(() => setFlashTs(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [flashTs]);

  return (
    <aside
      aria-label="Thread"
      className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[440px] animate-fade-in flex-col border-l border-line bg-canvas shadow-pop lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:shadow-none xl:w-[440px]"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line pr-2 pl-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] leading-tight font-semibold text-ink">Thread</h2>
          {conversation && <p className="truncate text-xs text-ink-muted">{conversationTitle(conversation)}</p>}
        </div>
        <IconButton label="Close thread" icon={<CloseIcon size={18} />} onClick={onClose} />
      </header>

      <div ref={scrollRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-6" data-testid="thread-scroller">
        {thread.isPending && <LoadingState label="Loading thread…" />}
        {thread.isError && (
          <ErrorState
            error={thread.error}
            title="Couldn’t load this thread"
            onRetry={() => void thread.refetch()}
            compact
          />
        )}
        {data && !data.parent && data.replies.length === 0 && (
          <EmptyState compact title="Thread not found" description="This thread isn’t in the archive." />
        )}
        {data && (data.parent || data.replies.length > 0) && (
          <>
            {data.parent ? (
              <div className="pt-3 pb-1">
                <MessageItem message={data.parent} showThreadSummary={false} highlighted={flashTs === data.parent.ts} />
              </div>
            ) : (
              <p className="mx-5 mt-4 flex items-center gap-2 rounded-lg bg-inset px-3 py-2 text-xs text-ink-muted">
                <AlertIcon size={14} className="shrink-0" />
                The message that started this thread isn’t in the archive.
              </p>
            )}
            <div className="my-2 flex items-center gap-3 px-5 text-xs font-medium text-ink-faint">
              <span>{pluralize(data.replies.length, 'reply', 'replies')}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            {days.map((day) => (
              <section key={day.key} aria-label={formatDate(day.date, 'PPPP') || undefined}>
                {day.key !== parentDay && (
                  <p className="px-5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
                    {formatDayLabel(day.date)}
                  </p>
                )}
                {day.rows.map(({ message, continuation }) => (
                  <MessageItem
                    key={message.ts}
                    message={message}
                    continuation={continuation}
                    highlighted={flashTs === message.ts}
                    showThreadSummary={false}
                  />
                ))}
              </section>
            ))}
            {data.parent && data.replies.length < data.parent.replyCount && (
              <p className="mx-5 mt-3 text-xs text-ink-faint">
                {pluralize(data.parent.replyCount - data.replies.length, 'reply', 'replies')} in Slack weren’t archived.
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
