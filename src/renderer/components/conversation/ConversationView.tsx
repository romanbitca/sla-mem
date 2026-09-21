import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ConversationDTO, MessageDTO } from '../../../shared/types';
import { describeError, isApiError } from '../../lib/api';
import { Mrkdwn } from '../../lib/mrkdwn';
import { formatCount, formatTsRange, pluralize } from '../../lib/format';
import { guessThreadParent } from '../../lib/grouping';
import { useStableCallback } from '../../lib/hooks';
import { qk, useConversation, useExportConversation, useMessages } from '../../lib/queries';
import { compareTs, parseTsParam } from '../../lib/ts';
import { AlertIcon, ArchiveIcon, CheckIcon, CloseIcon, DownloadIcon, HashIcon } from '../icons';
import { SidebarToggle } from '../layout/shell';
import { EmptyState, ErrorState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { LoadingState } from '../ui/Spinner';
import { ConversationIcon, conversationTitle } from './ConversationIcon';
import { JumpToDate } from './JumpToDate';
import { MessageTimeline, type ScrollRequest, type ScrollTarget } from './MessageTimeline';

export interface ConversationViewProps {
  conversationId: string;
}

function initialTarget(ts: string | null, thread: string | null): ScrollTarget {
  if (ts) return { kind: 'message', ts, fallbackTs: thread, highlight: true };
  if (thread) return { kind: 'message', ts: thread, highlight: false };
  return { kind: 'bottom' };
}

function containsTs(messages: readonly MessageDTO[], ts: string | null | undefined): boolean {
  return ts != null && messages.some((m) => m.ts === ts);
}

/** The loaded message closest to (at or after) `ts`, for links to messages we don't have. */
function nearestMessage(messages: readonly MessageDTO[], ts: string): MessageDTO | undefined {
  return messages.find((m) => compareTs(m.ts, ts) >= 0) ?? messages[messages.length - 1];
}

/**
 * Main pane for `/c/:id`: header plus a bidirectional message window.
 *
 * URL contract: `?ts=` jumps to (and highlights) a message, `?thread=` opens a thread (the panel
 * lives in ConversationPage). The window is keyed by an anchor ts; when a jump target is already
 * loaded we only scroll, otherwise we load a fresh window `around` it.
 */
export function ConversationView({ conversationId }: ConversationViewProps) {
  const qc = useQueryClient();
  const conversation = useConversation(conversationId);
  const [searchParams, setSearchParams] = useSearchParams();
  const tsParam = parseTsParam(searchParams.get('ts'));
  const threadParam = parseTsParam(searchParams.get('thread'));

  const [anchor, setAnchor] = useState<string | null>(() => tsParam ?? threadParam);
  const nextRequestId = useRef(1);
  const [request, setRequest] = useState<ScrollRequest | null>(() => ({
    id: 0,
    target: initialTarget(tsParam, threadParam),
  }));
  const [missingTs, setMissingTs] = useState<string | null>(null);
  const exporter = useExportConversation();

  const query = useMessages(conversationId, anchor);
  const { messages } = query;
  const hasOlder = query.hasPreviousPage;
  const hasNewer = query.hasNextPage;

  const requestScroll = (target: ScrollTarget) => setRequest({ id: nextRequestId.current++, target });

  const jumpTo = useStableCallback((target: ScrollTarget) => {
    setMissingTs(null);
    requestScroll(target);
    if (target.kind === 'bottom') {
      if (anchor === null && !hasNewer && query.data) return; // Already showing the live end.
      void qc.resetQueries({ queryKey: qk.messages(conversationId, null), exact: true });
      setAnchor(null);
      return;
    }
    if (containsTs(messages, target.ts) || containsTs(messages, target.fallbackTs)) return;
    // A cached window for this anchor may have paged away from it: always start fresh.
    void qc.resetQueries({ queryKey: qk.messages(conversationId, target.ts), exact: true });
    setAnchor(target.ts);
  });

  // React to in-app navigation that changes ?ts / ?thread while this view stays mounted.
  const prevParams = useRef({ tsParam, threadParam });
  useEffect(() => {
    const prev = prevParams.current;
    prevParams.current = { tsParam, threadParam };
    if (tsParam && tsParam !== prev.tsParam) {
      const replyInOpenThread = threadParam != null && tsParam !== threadParam;
      // A reply highlighted inside the open thread: the channel list stays where it is.
      if (replyInOpenThread && containsTs(messages, threadParam) && !containsTs(messages, tsParam)) return;
      jumpTo({ kind: 'message', ts: tsParam, fallbackTs: threadParam, highlight: true });
    } else if (threadParam && threadParam !== prev.threadParam && !tsParam && !containsTs(messages, threadParam)) {
      jumpTo({ kind: 'message', ts: threadParam, highlight: false });
    }
  }, [tsParam, threadParam, messages, jumpTo]);

  // A window loaded around a ts that doesn't contain it: the ts is a thread reply (only parents
  // are top-level) or isn't archived. Open the thread when we can tell which one it belongs to.
  useEffect(() => {
    if (!request || request.target.kind !== 'message') return;
    if (!query.isSuccess || query.isFetching || messages.length === 0) return;
    const { ts, fallbackTs } = request.target;
    if (anchor !== ts || containsTs(messages, ts) || containsTs(messages, fallbackTs)) return;
    const parent = guessThreadParent(messages, ts);
    if (parent) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('thread', parent.ts);
          next.set('ts', ts);
          return next;
        },
        { replace: true },
      );
      requestScroll({ kind: 'message', ts: parent.ts, highlight: false });
      return;
    }
    setMissingTs(ts);
    const nearest = nearestMessage(messages, ts);
    setRequest(
      nearest ? { id: nextRequestId.current++, target: { kind: 'message', ts: nearest.ts, highlight: false } } : null,
    );
  }, [request, query.isSuccess, query.isFetching, messages, anchor, setSearchParams]);

  const openThread = useStableCallback((threadTs: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('thread', threadTs);
      next.delete('ts');
      return next;
    });
  });

  const onJumpToDate = useStableCallback((ts: string) => {
    if (ts === tsParam) {
      jumpTo({ kind: 'message', ts, highlight: true });
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('ts', ts);
      next.delete('thread');
      return next;
    });
  });

  const jumpToLatest = useStableCallback(() => {
    jumpTo({ kind: 'bottom' });
    if (tsParam) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('ts');
          return next;
        },
        { replace: true },
      );
    }
  });

  const loadOlder = useStableCallback(() => {
    if (query.hasPreviousPage && !query.isFetching) void query.fetchPreviousPage({ cancelRefetch: false });
  });
  const loadNewer = useStableCallback(() => {
    if (query.hasNextPage && !query.isFetching) void query.fetchNextPage({ cancelRefetch: false });
  });

  if (conversation.isError && isApiError(conversation.error) && conversation.error.isNotFound) {
    return (
      <Pane>
        <EmptyState
          icon={<HashIcon size={20} />}
          title="Conversation not found"
          description="It isn’t in the archive. It may not have been synced yet."
        />
      </Pane>
    );
  }

  const conv = conversation.data;
  let body;
  if (query.isPending) {
    body = <LoadingState label="Loading messages…" />;
  } else if (query.isError && !query.data) {
    body = <ErrorState error={query.error} title="Couldn’t load messages" onRetry={() => void query.refetch()} />;
  } else if (messages.length === 0 && !hasOlder && !hasNewer) {
    body = (
      <EmptyState
        icon={<ArchiveIcon size={20} />}
        title="No messages archived"
        description="Nothing from this conversation has been synced or imported yet."
      />
    );
  } else {
    body = (
      <MessageTimeline
        messages={messages}
        hasOlder={hasOlder}
        hasNewer={hasNewer}
        isFetching={query.isFetching}
        isFetchingOlder={query.isFetchingPreviousPage}
        isFetchingNewer={query.isFetchingNextPage}
        olderFailed={query.isFetchPreviousPageError}
        newerFailed={query.isFetchNextPageError}
        onLoadOlder={loadOlder}
        onLoadNewer={loadNewer}
        onJumpToLatest={jumpToLatest}
        onOpenThread={openThread}
        request={request}
        intro={conv && <ConversationIntro conversation={conv} />}
      />
    );
  }

  return (
    <Pane>
      <ConversationHeader
        conversationId={conversationId}
        conversation={conv}
        onJump={onJumpToDate}
        exporter={exporter}
      />
      <ExportNotice conversationId={conversationId} exporter={exporter} />
      {missingTs && (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-line bg-warn-soft px-5 py-2 text-[13px] text-warn"
        >
          <AlertIcon size={15} className="shrink-0" />
          <span className="flex-1">That message isn’t in the archive. Showing the closest messages instead.</span>
          <IconButton size="sm" label="Dismiss" icon={<CloseIcon size={14} />} onClick={() => setMissingTs(null)} />
        </div>
      )}
      {body}
    </Pane>
  );
}

function Pane({ children }: { children: ReactNode }) {
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">{children}</section>;
}

type Exporter = ReturnType<typeof useExportConversation>;

function ConversationHeader({
  conversationId,
  conversation,
  onJump,
  exporter,
}: {
  conversationId: string;
  conversation: ConversationDTO | undefined;
  onJump: (ts: string) => void;
  exporter: Exporter;
}) {
  const range = conversation ? formatTsRange(conversation.oldestTs, conversation.latestTs) : null;
  const about = conversation?.topic || conversation?.purpose;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
      <SidebarToggle />
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {conversation && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-muted">
            <ConversationIcon conversation={conversation} size={16} />
          </span>
        )}
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 truncate text-[15px] leading-tight font-semibold text-ink">
            <span className="truncate">{conversation ? conversationTitle(conversation) : ' '}</span>
            {conversation?.isArchived && (
              <span className="rounded bg-inset px-1.5 py-px text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                Archived
              </span>
            )}
          </h1>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
            {about && (
              <span className="min-w-0 truncate" title={about}>
                <Mrkdwn text={about} inline />
              </span>
            )}
            {about && range && <span aria-hidden="true">·</span>}
            {range && <span className="shrink-0">{range}</span>}
            {conversation && conversation.messageCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="shrink-0">{formatCount(conversation.messageCount)} messages</span>
              </>
            )}
          </p>
        </div>
      </div>
      <JumpToDate
        conversationId={conversationId}
        oldestTs={conversation?.oldestTs ?? null}
        latestTs={conversation?.latestTs ?? null}
        onJump={onJump}
      />
      <IconButton
        label="Export as a Markdown file"
        icon={<DownloadIcon size={16} />}
        disabled={!conversation || exporter.isPending}
        onClick={() => exporter.mutate(conversationId)}
      />
    </header>
  );
}

/**
 * The outcome of "Export" (PLAN Stage 8: main asks where to save, writes Markdown and shows the
 * file in Finder/Explorer), until dismissed. Nothing when the save dialog was cancelled.
 */
function ExportNotice({ conversationId, exporter }: { conversationId: string; exporter: Exporter }) {
  const [dismissed, setDismissed] = useState<unknown>(null);
  const outcome = exporter.isError ? exporter.error : exporter.data;
  if (!outcome || outcome === dismissed || exporter.variables !== conversationId) return null;
  const failed = exporter.isError;
  return (
    <div
      role={failed ? 'alert' : 'status'}
      className={
        failed
          ? 'flex items-center gap-2 border-b border-line bg-danger-soft px-5 py-2 text-[13px] text-danger'
          : 'flex items-center gap-2 border-b border-line bg-inset px-5 py-2 text-[13px] text-ink-muted'
      }
    >
      {failed ? <AlertIcon size={15} className="shrink-0" /> : <CheckIcon size={15} className="shrink-0" />}
      <span className="flex-1">
        {failed
          ? `Couldn’t export: ${describeError(exporter.error)}`
          : `Exported ${pluralize(exporter.data!.messages, 'message', 'messages')} to ${fileName(exporter.data!.path)}.`}
      </span>
      <IconButton size="sm" label="Dismiss" icon={<CloseIcon size={14} />} onClick={() => setDismissed(outcome)} />
    </div>
  );
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

function ConversationIntro({ conversation }: { conversation: ConversationDTO }) {
  const title = conversationTitle(conversation);
  return (
    <div className="px-5 pt-10 pb-3">
      <div className="flex size-12 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
        <ConversationIcon conversation={conversation} size={22} />
      </div>
      <h2 className="mt-3 text-lg font-semibold text-ink">{title}</h2>
      <p className="mt-1 max-w-xl text-sm leading-relaxed text-ink-muted">
        This is the start of {title} in your archive. Slack Free only shows the last 90 days, so anything older than
        your first sync or import was never captured.
      </p>
    </div>
  );
}
