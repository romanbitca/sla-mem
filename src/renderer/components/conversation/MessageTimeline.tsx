import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import clsx from 'clsx';
import type { MessageDTO } from '../../../shared/types';
import { groupByDay } from '../../lib/grouping';
import { useStableCallback } from '../../lib/hooks';
import { ArrowDownIcon } from '../icons';
import { MessageItem } from '../message/MessageItem';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { DayDivider } from './DayDivider';
import { findMessageElement, isNearBottom, useScrollAnchor } from './scrollAnchor';

export type ScrollTarget =
  | { kind: 'bottom' }
  | {
      kind: 'message';
      ts: string;
      /** Scrolled to instead when `ts` isn't in the list (a reply → its thread parent). */
      fallbackTs?: string | null;
      highlight: boolean;
    };

/** A one-shot instruction to scroll; `id` distinguishes repeated requests for the same target. */
export interface ScrollRequest {
  id: number;
  target: ScrollTarget;
}

export interface MessageTimelineProps {
  messages: MessageDTO[];
  hasOlder: boolean;
  hasNewer: boolean;
  isFetchingOlder: boolean;
  isFetchingNewer: boolean;
  /** Any fetch in flight for this window; paging waits so requests never cancel each other. */
  isFetching: boolean;
  olderFailed?: boolean;
  newerFailed?: boolean;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onJumpToLatest: () => void;
  onOpenThread: (threadTs: string) => void;
  request: ScrollRequest | null;
  /** Shown above the first message once the beginning of the archive is reached. */
  intro?: ReactNode;
}

const HIGHLIGHT_MS = 3000;
/** Distance from the bottom after which "Jump to latest" appears. */
const FAR_FROM_BOTTOM_PX = 1200;
/** Start loading this far before the reader reaches either end. */
const PREFETCH_MARGIN = '900px 0px 900px 0px';

/** Scrolls `el` so `target` is vertically centered, without touching ancestor scrollers. */
function centerInContainer(container: HTMLElement, target: HTMLElement): void {
  const c = container.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const offset = t.top - c.top - Math.max(0, (container.clientHeight - t.height) / 2);
  container.scrollTop += offset;
}

function useLoadSentinel(
  rootRef: RefObject<HTMLElement | null>,
  targetRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onVisible: () => void,
): void {
  const callback = useStableCallback(onVisible);
  useEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    const target = targetRef.current;
    if (!root || !target || typeof IntersectionObserver === 'undefined') return;
    // A fresh observer reports the current state immediately, so after each page lands we
    // re-check and keep loading while the sentinel is still within the prefetch margin.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) callback();
      },
      { root, rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, rootRef, targetRef, callback]);
}

/**
 * The scrolling list of day sections. Owns everything DOM-related: executing scroll requests,
 * keeping the reading position stable while pages load, infinite loading and highlight.
 */
export function MessageTimeline(props: MessageTimelineProps) {
  const { messages, hasOlder, hasNewer, isFetching, request, onOpenThread } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const [handledId, setHandledId] = useState<number | null>(null);
  const [highlightTs, setHighlightTs] = useState<string | null>(null);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const { capture, restore } = useScrollAnchor(scrollRef, contentRef, !hasNewer);

  const groups = useMemo(() => groupByDay(messages), [messages]);
  const pending = request != null && request.id !== handledId;

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (!request || request.id === handledId) {
      restore();
      return;
    }
    const target = request.target;
    if (target.kind === 'bottom') {
      if (messages.length === 0 && isFetching) return;
      container.scrollTop = container.scrollHeight;
      setHandledId(request.id);
      capture();
      return;
    }
    const found =
      findMessageElement(container, target.ts) ??
      (target.fallbackTs ? findMessageElement(container, target.fallbackTs) : null);
    if (!found) return; // Wait for the window that contains it.
    centerInContainer(container, found);
    setHandledId(request.id);
    // A fallback (thread parent) is only scrolled to; the thread panel highlights the reply.
    if (target.highlight && found.dataset.msgTs === target.ts) setHighlightTs(target.ts);
    capture();
  }, [messages, request, handledId, isFetching, capture, restore]);

  useEffect(() => {
    if (!highlightTs) return;
    const timer = setTimeout(() => setHighlightTs(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightTs]);

  const canPage = !pending && messages.length > 0 && !isFetching;
  useLoadSentinel(scrollRef, topSentinel, canPage && hasOlder && !props.olderFailed, props.onLoadOlder);
  useLoadSentinel(scrollRef, bottomSentinel, canPage && hasNewer && !props.newerFailed, props.onLoadNewer);

  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    capture();
    const far = !isNearBottom(container, FAR_FROM_BOTTOM_PX);
    if (far !== farFromBottom) setFarFromBottom(far);
  };

  const showJump = !pending && messages.length > 0 && (hasNewer || farFromBottom);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
        role="region"
        aria-label="Messages"
        aria-busy={isFetching || undefined}
        data-testid="message-scroller"
      >
        <div ref={contentRef} className="flex min-h-full flex-col justify-end pb-3">
          <div ref={topSentinel} aria-hidden="true" data-testid="sentinel-older" />
          {hasOlder ? (
            <PagingRow
              loading={props.isFetchingOlder}
              failed={props.olderFailed}
              onRetry={props.onLoadOlder}
              label="Loading older messages…"
            />
          ) : (
            messages.length > 0 && props.intro
          )}
          {groups.map((group) => (
            <section key={group.key} aria-labelledby={`day-${group.key}`} className="relative">
              <DayDivider id={`day-${group.key}`} date={group.date} />
              {group.rows.map(({ message, continuation }) => (
                <MessageItem
                  key={message.ts}
                  message={message}
                  continuation={continuation}
                  highlighted={message.ts === highlightTs}
                  onOpenThread={onOpenThread}
                />
              ))}
            </section>
          ))}
          {hasNewer && (
            <PagingRow
              loading={props.isFetchingNewer}
              failed={props.newerFailed}
              onRetry={props.onLoadNewer}
              label="Loading newer messages…"
            />
          )}
          <div ref={bottomSentinel} aria-hidden="true" data-testid="sentinel-newer" />
        </div>
      </div>
      {showJump && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <Button
            size="sm"
            className="pointer-events-auto animate-pop-in rounded-full shadow-pop"
            icon={<ArrowDownIcon size={14} />}
            onClick={props.onJumpToLatest}
          >
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}

/** Fixed-height row so its spinner appearing/disappearing never shifts the content. */
function PagingRow({
  loading,
  failed,
  onRetry,
  label,
}: {
  loading: boolean;
  failed?: boolean;
  onRetry: () => void;
  label: string;
}) {
  return (
    <div className={clsx('flex h-12 items-center justify-center gap-2 text-xs text-ink-faint')}>
      {failed && !loading ? (
        <>
          <span>Couldn’t load messages.</span>
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        </>
      ) : (
        loading && (
          <>
            <Spinner size={13} />
            <span>{label}</span>
          </>
        )
      )}
    </div>
  );
}
