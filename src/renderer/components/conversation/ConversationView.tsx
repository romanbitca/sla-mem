import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { addDays } from 'date-fns';
import type { ConversationDTO, MessageDTO } from '../../../shared/types';
import { describeError, isApiError } from '../../lib/api';
import { isNotesToSelf, useDirectory } from '../../lib/directory';
import { personPath } from '../../lib/links';
import { Mrkdwn } from '../../lib/mrkdwn';
import { FREE_PLAN_WINDOW_DAYS, formatDate, formatDateRange, pluralize } from '../../lib/format';
import { guessThreadParent } from '../../lib/grouping';
import { useStableCallback } from '../../lib/hooks';
import { qk, useConversation, useExportConversation, useMessages, useSettings } from '../../lib/queries';
import { fromSearchOf, useSearchParamsKeepingState, type ReturnToSearchState } from '../../lib/searchNav';
import { compareTs, parseTsParam, tsToDate } from '../../lib/ts';
import {
  AlertIcon,
  ArchiveIcon,
  CheckIcon,
  ChevronLeftIcon,
  CloseIcon,
  DownloadIcon,
  EyeOffIcon,
  HashIcon,
  InfoIcon,
} from '../icons';
import { SidebarToggle } from '../layout/shell';
import { Button } from '../ui/Button';
import { EmptyState, ErrorState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { LoadingState } from '../ui/Spinner';
import { ConversationIcon, conversationTitle } from './ConversationIcon';
import { JumpToDate } from './JumpToDate';
import { MessageTimeline, type ScrollRequest, type ScrollTarget } from './MessageTimeline';

export interface ConversationViewProps {
  conversationId: string;
  /** Replaces the conversation header (the search preview draws its own); omitted keeps it. */
  header?: ReactNode;
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
export function ConversationView({ conversationId, header }: ConversationViewProps) {
  const qc = useQueryClient();
  const conversation = useConversation(conversationId);
  // Keeps the way back to search results through thread opens and jumps.
  const [searchParams, setSearchParams] = useSearchParamsKeepingState();
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
  const excluded = useSettings().data?.preferences.excludedConversationIds.includes(conversationId) ?? false;
  const selfUserId = useDirectory().selfUserId;

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
  const notesToSelf = isNotesToSelf(conv, selfUserId);
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
        keptBySlack={notesToSelf}
      />
    );
  }

  return (
    <Pane>
      {header === undefined ? (
        <ConversationHeader
          conversationId={conversationId}
          conversation={conv}
          onJump={onJumpToDate}
          exporter={exporter}
        />
      ) : (
        header
      )}
      <ExportNotice conversationId={conversationId} exporter={exporter} />
      {excluded && (
        <div
          role="note"
          className="flex animate-slide-down items-center gap-2 border-b border-line bg-inset px-5 py-2 text-[13px] text-ink-muted"
        >
          <InfoIcon size={15} className="shrink-0" />
          <span className="flex-1">
            Slamem doesn’t archive this conversation any more: these are messages from before.{' '}
            <Link to="/settings#what-to-archive" className="font-medium text-accent-text hover:underline">
              What to archive
            </Link>
          </span>
        </div>
      )}
      {missingTs && (
        <div
          role="status"
          className="flex animate-slide-down items-center gap-2 border-b border-line bg-warn-soft px-5 py-2 text-[13px] text-warn"
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
  return <section className="flex min-h-0 min-w-0 flex-1 animate-page-in flex-col bg-canvas">{children}</section>;
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
  const about = conversation?.topic || conversation?.purpose;
  const { selfUserId } = useDirectory();
  // A DM's name opens that person's page (your notes to yourself have none worth opening).
  const personId =
    conversation?.type === 'im' && conversation.dmUserId && !isNotesToSelf(conversation, selfUserId)
      ? conversation.dmUserId
      : null;
  const title = conversation ? conversationTitle(conversation) : ' ';
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
      <SidebarToggle />
      <BackToSearch />
      {/* A size container: the facts line drops its details as the header narrows (thread open). */}
      <div className="@container flex min-w-0 flex-1 items-center gap-2.5">
        {conversation && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-muted">
            <ConversationIcon conversation={conversation} size={16} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 truncate text-[15px] leading-tight font-semibold text-ink">
            {personId ? (
              <Link
                to={personPath(personId)}
                title={`${title}: everything between you`}
                className="focus-ring truncate rounded-sm hover:underline"
              >
                {title}
              </Link>
            ) : (
              <span className="truncate">{title}</span>
            )}
            {conversation?.isArchived && (
              <span className="rounded bg-inset px-1.5 py-px text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                Archived
              </span>
            )}
          </h1>
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-ink-muted">
            {conversation && <ConversationFacts conversation={conversation} />}
            {about && (
              <span className="hidden min-w-0 truncate @3xl:inline" title={about}>
                <Mrkdwn text={about} inline />
              </span>
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
 * The conversation in numbers: how many messages the archive holds and over which dates, then,
 * set apart, how many of them Slack Free no longer shows (older than 90 days) and from when to
 * when. Notes to yourself are all still in Slack, however old. Details drop out as the header
 * narrows; the tooltips keep them.
 */
function ConversationFacts({ conversation }: { conversation: ConversationDTO }) {
  if (conversation.messageCount === 0) return null;
  const oldest = tsToDate(conversation.oldestTs ?? '');
  const range = formatDateRange(oldest, tsToDate(conversation.latestTs ?? ''));
  const hidden = conversation.beyondFreeWindow;
  return (
    <span className="flex shrink-0 items-center gap-2">
      <span
        className="shrink-0"
        title={range ? `${pluralize(conversation.messageCount, 'message')}, ${range}` : undefined}
      >
        {pluralize(conversation.messageCount, 'message')}
        {range && <span className="hidden @sm:inline"> · {range}</span>}
      </span>
      {hidden && hidden.count > 0 && (
        <NoLongerInSlack count={hidden.count} oldest={hidden.oldest} newest={hidden.newest} />
      )}
      {hidden && hidden.count === 0 && <StillInSlack oldest={oldest} notesToSelf={hidden.notesToSelf} />}
    </span>
  );
}

function NoLongerInSlack({ count, oldest, newest }: { count: number; oldest: number | null; newest: number | null }) {
  const range =
    oldest != null && newest != null ? formatDateRange(new Date(oldest * 1000), new Date(newest * 1000)) : '';
  const one = count === 1;
  const words = `${pluralize(count, 'message')} ${one ? 'is' : 'are'} older than ${FREE_PLAN_WINDOW_DAYS} days`;
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-px font-medium text-accent-text"
      title={`${words}${range ? ` (${range})` : ''}: Slack Free no longer shows ${one ? 'it' : 'them'}. ${one ? 'It’s' : 'They’re'} kept here.`}
    >
      <EyeOffIcon size={12} className="shrink-0" />
      {count.toLocaleString()} no longer in Slack
      {range && <span className="hidden font-normal @xl:inline"> · {range}</span>}
    </span>
  );
}

function StillInSlack({ oldest, notesToSelf }: { oldest: Date; notesToSelf: boolean }) {
  const leaves = formatDate(addDays(oldest, FREE_PLAN_WINDOW_DAYS), 'MMM d, yyyy');
  const title = notesToSelf
    ? `Slack Free shows the last ${FREE_PLAN_WINDOW_DAYS} days, but it keeps showing notes to yourself however old they are.`
    : `Slack Free shows the last ${FREE_PLAN_WINDOW_DAYS} days.${leaves ? ` The oldest message here drops out of Slack on ${leaves}; it stays in your archive.` : ''}`;
  return (
    <span
      className="hidden shrink-0 items-center gap-1 rounded-full bg-inset px-2 py-px text-ink-faint @md:flex"
      title={title}
    >
      <CheckIcon size={12} className="shrink-0" />
      All still in Slack
    </span>
  );
}

/**
 * Opened from search results or an Ask AI answer: the way back to them, with the opened result
 * focused.
 */
function BackToSearch() {
  const location = useLocation();
  const navigate = useNavigate();
  const back = fromSearchOf(location.state);
  if (!back) return null;
  const toChat = back.fromSearch.startsWith('/ask');
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<ChevronLeftIcon size={15} />}
      title={toChat ? 'Back to the answer' : 'Back to the search results'}
      onClick={() => navigate(back.fromSearch, { state: { focusHit: back.hit } satisfies ReturnToSearchState })}
      className="-ml-1.5 shrink-0"
    >
      {toChat ? 'Ask AI' : 'Search results'}
    </Button>
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
          ? 'flex animate-slide-down items-center gap-2 border-b border-line bg-danger-soft px-5 py-2 text-[13px] text-danger'
          : 'flex animate-slide-down items-center gap-2 border-b border-line bg-inset px-5 py-2 text-[13px] text-ink-muted'
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
