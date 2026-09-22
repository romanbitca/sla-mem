import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import type { MessageDTO } from '../../../shared/types';
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
import { Button } from '../ui/Button';
import { EmptyState, ErrorState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { LoadingState } from '../ui/Spinner';

export interface ThreadPanelProps {
  conversationId: string;
  threadTs: string;
  /** A reply to scroll to and highlight (deep link `?thread=…&ts=…`). */
  highlightTs?: string | null;
  onClose: () => void;
  /** 'fill': takes all the space it's given (the search preview) instead of being a side panel. */
  variant?: 'panel' | 'fill';
}

const HIGHLIGHT_MS = 3000;

/**
 * Replies drawn at once (PLAN Stage 8, very large threads): a thread of thousands of replies
 * opens as fast as a short one, and shows more in steps of this size.
 */
export const THREAD_WINDOW = 200;

/** The replies to draw first: the start of the thread, or a window around the linked reply. */
function initialRange(replies: MessageDTO[], highlightTs: string | null): [number, number] {
  if (replies.length <= THREAD_WINDOW) return [0, replies.length];
  const i = highlightTs ? replies.findIndex((r) => r.ts === highlightTs) : -1;
  if (i < 0) return [0, THREAD_WINDOW];
  const start = Math.max(0, Math.min(i - THREAD_WINDOW / 2, replies.length - THREAD_WINDOW));
  return [start, start + THREAD_WINDOW];
}

/** Right-hand panel: thread parent plus all archived replies. Esc or the close button dismisses it. */
export function ThreadPanel({
  conversationId,
  threadTs,
  highlightTs = null,
  onClose,
  variant = 'panel',
}: ThreadPanelProps) {
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
  // The drawn range belongs to one thread and link; anything else starts from its initial range.
  const rangeKey = `${threadTs}|${highlightTs ?? ''}|${replies?.length ?? 0}`;
  const [shown, setShown] = useState<{ key: string; range: [number, number] } | null>(null);
  const [start, end] = shown?.key === rangeKey ? shown.range : replies ? initialRange(replies, highlightTs) : [0, 0];
  const visible = useMemo(() => (replies ?? []).slice(start, end), [replies, start, end]);
  const days = useMemo(() => groupByDay(visible), [visible]);
  const parentDay = data?.parent ? localDayKey(tsToMs(data.parent.ts)) : null;
  const total = replies?.length ?? 0;

  // Drawing earlier replies above must not move what the reader is looking at.
  const heightBeforeEarlier = useRef<number | null>(null);
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || heightBeforeEarlier.current == null) return;
    container.scrollTop += container.scrollHeight - heightBeforeEarlier.current;
    heightBeforeEarlier.current = null;
  }, [start]);
  const showEarlier = () => {
    heightBeforeEarlier.current = scrollRef.current?.scrollHeight ?? null;
    setShown({ key: rangeKey, range: [Math.max(0, start - THREAD_WINDOW), end] });
  };
  const showLater = () => setShown({ key: rangeKey, range: [start, Math.min(total, end + THREAD_WINDOW)] });

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
      className={
        variant === 'fill'
          ? 'flex min-h-0 min-w-0 flex-1 animate-fade-in flex-col bg-canvas'
          : 'absolute inset-y-0 right-0 z-30 flex w-full max-w-[440px] animate-slide-in-right flex-col border-l border-line bg-canvas shadow-pop lg:static lg:z-auto lg:w-[400px] lg:shrink-0 lg:shadow-none xl:w-[440px]'
      }
    >
      <header
        className={clsx(
          'flex shrink-0 items-center gap-2 border-b border-line pr-2 pl-5',
          variant === 'fill' ? 'h-11' : 'h-14',
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] leading-tight font-semibold text-ink">Thread</h2>
          {/* Filling the preview, the conversation's name is already in the header above. */}
          {conversation && variant === 'panel' && (
            <p className="truncate text-xs text-ink-muted">{conversationTitle(conversation)}</p>
          )}
        </div>
        {variant === 'fill' ? (
          <Button size="sm" variant="ghost" onClick={onClose}>
            Show conversation
          </Button>
        ) : (
          <IconButton label="Close thread" icon={<CloseIcon size={18} />} onClick={onClose} />
        )}
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
            {start > 0 && (
              <MoreReplies onClick={showEarlier}>
                Show {pluralize(Math.min(start, THREAD_WINDOW), 'earlier reply', 'earlier replies')}
              </MoreReplies>
            )}
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
            {end < total && (
              <MoreReplies onClick={showLater}>
                Show {pluralize(Math.min(total - end, THREAD_WINDOW), 'more reply', 'more replies')}
              </MoreReplies>
            )}
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

function MoreReplies({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <div className="px-5 py-2">
      <button
        type="button"
        onClick={onClick}
        className="focus-ring w-full rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-accent-text transition-colors duration-150 hover:border-line-strong hover:bg-hover"
      >
        {children}
      </button>
    </div>
  );
}
