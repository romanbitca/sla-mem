import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import type { MessageDTO, SearchResponse, SearchSort } from '../../shared/types';
import { describeError } from '../lib/api';
import { isModalOpen, isTypingTarget, useKeydown, useMediaQuery, useStableCallback } from '../lib/hooks';
import { conversationPath, messagePath } from '../lib/links';
import { useConversations, useSearch, useUsers, useWorkspace } from '../lib/queries';
import {
  carryPreview,
  messageKey,
  parsePreview,
  rememberSearch,
  resultsScroll,
  saveResultsScroll,
  withConversationPreview,
  withoutPreview,
  withPreview,
  type FromSearchState,
  type ReturnToSearchState,
} from '../lib/searchNav';
import { LayersIcon, ListIcon, SearchIcon } from '../components/icons';
import { PageNav, useShell } from '../components/layout/shell';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { LoadingState, Spinner } from '../components/ui/Spinner';
import { FilterBar } from '../components/search/FilterBar';
import type { EditMode } from '../components/search/FilterChip';
import { collectHits } from '../components/search/hits';
import { removeRawToken, tokenizeQuery } from '../components/search/queryText';
import type { ResolverData } from '../components/search/resolve';
import { SearchInput } from '../components/search/SearchInput';
import { SearchPreview } from '../components/search/SearchPreview';
import { SearchResults, type ResultLink } from '../components/search/SearchResults';
import { SearchTips, UnresolvedNotice } from '../components/search/SearchNotices';
import {
  clearFilters,
  effectiveFilters,
  hasFilters,
  parseSearchUrl,
  sameSearch,
  searchLocation,
  setConversationFilter,
  toApiParams,
  type SearchUrlState,
  type SearchView,
} from '../components/search/searchUrl';

/** Cached directory lists, shaped for modifier resolution and autocomplete. */
function useResolverData(): ResolverData | null {
  const users = useUsers().data;
  const conversations = useConversations().data;
  const selfUserId = useWorkspace().data?.selfUserId ?? null;
  return useMemo(
    () => (users && conversations ? { users, conversations, selfUserId } : null),
    [users, conversations, selfUserId],
  );
}

/** Wide enough for the results and an open message side by side. */
const SPLIT_QUERY = '(min-width: 1200px)';

/**
 * `/search`: the URL (q plus filter params) is the only source of truth, so back/forward and
 * reloads restore the exact search. The text box holds a draft until it's submitted.
 *
 * Opening a result: in a wide window it opens next to the results (the preview, also in the URL:
 * `c`, `ts`, `thread`), so the list stays in view; otherwise it opens the conversation, whose
 * "Search results" button comes back here, scrolled where the list was, with that result focused.
 */
export default function SearchPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => parseSearchUrl(location.search), [location.search]);
  const data = useResolverData();
  const effective = useMemo(() => effectiveFilters(state, data), [state, data]);
  const params = useMemo(() => toApiParams(state), [state]);
  const search = useSearch(params);
  const inputRef = useShell().searchInputRef;
  const resultsRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const split = useMediaQuery(SPLIT_QUERY);
  const preview = split ? parsePreview(location.search) : null;
  const previewOpen = preview != null;
  const selectedKey = preview?.ts ? `${preview.conversationId}:${preview.ts}` : null;
  const currentUrl = `/search${location.search}`;
  const searchKey = withoutPreview(location.search);
  const arrival = location.state as ReturnToSearchState | null;

  // The sidebar's Search (and ⌘K) come back to this search.
  useEffect(() => rememberSearch(currentUrl), [currentUrl]);

  // ⌘K or "/" from another page: the cursor goes in the box, ready to type over the last query.
  // Opened any other way (the sidebar, a link), the box waits for a click: nothing pops up unasked.
  useEffect(() => {
    if (!arrival?.focusSearch) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [arrival, inputRef]);

  // The draft follows the URL whenever the URL's query changes (submit, back/forward, sidebar).
  const [draft, setDraft] = useState(state.q);
  const [draftFor, setDraftFor] = useState(state.q);
  if (draftFor !== state.q) {
    setDraftFor(state.q);
    setDraft(state.q);
  }

  const go = useStableCallback((next: SearchUrlState, mode?: EditMode): boolean => {
    if (sameSearch(next, state)) return false;
    // A new search closes the preview; sorting or regrouping the same results keeps it.
    const sameResults = sameSearch({ ...next, sort: state.sort, view: state.view }, state);
    const target = searchLocation(next);
    navigate(sameResults ? carryPreview(target, location.search) : target, { replace: mode?.replace ?? false });
    return true;
  });

  const closePreview = useStableCallback(() =>
    navigate({ pathname: '/search', search: withoutPreview(location.search) }, { replace: true }),
  );

  // The first result opened adds a history entry (Back closes it); switching results replaces it.
  const linkFor = useCallback(
    (message: MessageDTO): ResultLink =>
      split
        ? { to: { pathname: '/search', search: withPreview(location.search, message) }, replace: previewOpen }
        : {
            to: messagePath(message),
            state: { fromSearch: currentUrl, hit: messageKey(message) } satisfies FromSearchState,
          },
    [split, location.search, previewOpen, currentUrl],
  );
  const conversationLinkFor = useCallback(
    (conversationId: string): ResultLink =>
      split
        ? {
            to: { pathname: '/search', search: withConversationPreview(location.search, conversationId) },
            replace: previewOpen,
          }
        : {
            to: conversationPath(conversationId),
            state: { fromSearch: currentUrl, hit: '' } satisfies FromSearchState,
          },
    [split, location.search, previewOpen, currentUrl],
  );

  // Esc closes the preview (a thread in it closes first, by its own Esc).
  useKeydown((e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !preview || preview.threadTs || isModalOpen()) return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    closePreview();
  });

  // Coming back to a search: the list where it was, and the result that was opened focused. A
  // different search starts at the top.
  const restoredFor = useRef<string | null>(null);
  const hasResults = search.data != null;
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !hasResults || restoredFor.current === searchKey) return;
    restoredFor.current = searchKey;
    const top = resultsScroll(searchKey);
    scroller.scrollTop = top ?? 0;
    if (arrival?.focusHit) {
      scroller
        .querySelector<HTMLElement>(`[data-search-hit="${arrival.focusHit}"]`)
        ?.focus({ preventScroll: top != null });
    }
  }, [hasResults, searchKey, arrival]);

  // The previewed result stays in view as the list narrows beside it.
  useLayoutEffect(() => {
    if (!selectedKey) return;
    scrollerRef.current
      ?.querySelector<HTMLElement>(`[data-search-hit="${selectedKey}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedKey]);

  // Filter edits also run whatever is typed in the box, as Slack does.
  const working = useMemo<SearchUrlState>(() => ({ ...state, q: draft.trim() }), [state, draft]);

  const submit = (q: string) => {
    if (!go({ ...state, q: q.trim() }) && params) void search.refetch();
  };

  const insertTip = (text: string) => {
    const base = draft.trimEnd();
    const next = base ? `${base} ${text}` : text;
    setDraft(next);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(next.length, next.length);
    });
  };

  const removeUnresolved = (raw: string) => {
    if (tokenizeQuery(state.q).some((t) => t.raw === raw)) go({ ...state, q: removeRawToken(state.q, raw) });
    // The server also reports malformed explicit date params as `after:…` / `before:…`.
    else if (raw.startsWith('after:')) go({ ...state, after: null });
    else if (raw.startsWith('before:')) go({ ...state, before: null });
  };

  const focusFirstHit = () => resultsRef.current?.querySelector<HTMLElement>('[data-search-hit]')?.focus();

  // The box's clear button starts over, as if Search had just been opened: no results, filters or
  // open message. Back returns to the search that was cleared.
  const clear = () => {
    setDraft('');
    if (location.search) navigate('/search');
  };

  let body: ReactNode;
  if (!params) {
    body = <SearchTips onInsert={insertTip} />;
  } else if (search.isPending) {
    body = <LoadingState label="Searching…" />;
  } else if (search.isError && !search.data) {
    body = <ErrorState error={search.error} title="Search failed" onRetry={() => void search.refetch()} />;
  } else if (search.data) {
    const pages = search.data.pages;
    const first = pages[0] as SearchResponse | undefined;
    const hits = collectHits(pages);
    const total = first?.total ?? 0;
    // Placeholder data belongs to the previous search; its warnings would be misleading.
    const unresolved = search.isPlaceholderData ? [] : (first?.parsed.unresolved ?? []);
    const filtered = hasFilters(effective);
    body = (
      <div
        className={clsx('transition-opacity duration-150', search.isPlaceholderData && 'opacity-55')}
        aria-busy={search.isFetching || undefined}
      >
        {unresolved.length > 0 && (
          <div className="px-3 pb-4">
            <UnresolvedNotice unresolved={unresolved} onRemove={removeUnresolved} />
          </div>
        )}
        {total === 0 && unresolved.length === 0 && (
          <EmptyState
            icon={<SearchIcon size={20} />}
            title="No messages match"
            description={
              filtered
                ? 'Try removing a filter or searching fewer words.'
                : 'Try fewer or shorter words. The archive only contains what has been synced or imported.'
            }
            action={
              filtered && (
                <Button size="sm" onClick={() => go(clearFilters(working, data))}>
                  Search without filters
                </Button>
              )
            }
          />
        )}
        {total > 0 && first && (
          <>
            <ResultsToolbar
              total={total}
              tookMs={first.tookMs}
              fetching={search.isFetching && !search.isFetchingNextPage}
              sort={state.sort}
              view={state.view}
              compact={preview != null}
              onSort={(sort) => go({ ...working, sort })}
              onView={(view) => go({ ...state, view }, { replace: true })}
            />
            <div ref={resultsRef}>
              <SearchResults
                hits={hits}
                view={state.view}
                filteredConversations={effective.conversation}
                onOnlyConversation={(id) => go(setConversationFilter(working, [id], data))}
                onExitUp={() => inputRef.current?.focus()}
                linkFor={linkFor}
                conversationLinkFor={conversationLinkFor}
                selectedKey={selectedKey}
              />
            </div>
            <div className="flex flex-col items-center gap-2 py-6">
              <p className="text-xs text-ink-faint tabular-nums">
                Showing {hits.length.toLocaleString()} of {total.toLocaleString()}
              </p>
              {search.hasNextPage && (
                <Button onClick={() => void search.fetchNextPage()} loading={search.isFetchingNextPage}>
                  Load more results
                </Button>
              )}
              {search.isFetchNextPageError && (
                <p role="alert" className="text-xs text-danger">
                  Couldn’t load more results. {describeError(search.error)}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 animate-page-in flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <PageNav />
        <h1 className="text-[15px] font-semibold text-ink">Search</h1>
      </header>
      {/* The box and filters stay put above the results (and the preview, when open). */}
      <div className="relative z-20 shrink-0 border-b border-line bg-canvas">
        <div
          className={clsx('flex flex-col gap-3 px-4 pt-4 pb-3 sm:px-6', preview ? 'max-w-none' : 'mx-auto max-w-4xl')}
        >
          <SearchInput
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            source={data}
            inputRef={inputRef}
            onExitDown={focusFirstHit}
            onClear={clear}
          />
          <FilterBar state={working} effective={effective} data={data} onChange={go} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* One scroller in both layouts, so opening a result doesn't lose the place in the list. */}
        <div
          ref={scrollerRef}
          onScroll={(e) => saveResultsScroll(searchKey, e.currentTarget.scrollTop)}
          className={clsx(
            'scroll-thin relative min-h-0 overflow-y-auto',
            preview ? 'w-[400px] shrink-0 xl:w-[460px]' : 'flex-1',
          )}
        >
          <div className={clsx(preview ? 'px-1 py-3' : 'mx-auto max-w-4xl px-1 py-4 sm:px-3')}>{body}</div>
        </div>
        {preview && <SearchPreview target={preview} searchUrl={currentUrl} onClose={closePreview} />}
      </div>
    </section>
  );
}

function formatTook(ms: number): string {
  if (ms < 1) return 'under 1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

const SORT_LABELS: Record<SearchSort, string> = {
  relevance: 'Most relevant',
  newest: 'Newest first',
  oldest: 'Oldest first',
};

function ResultsToolbar({
  total,
  tookMs,
  fetching,
  sort,
  view,
  compact,
  onSort,
  onView,
}: {
  total: number;
  tookMs: number;
  fetching: boolean;
  sort: SearchSort;
  view: SearchView;
  /** Beside the preview: layout buttons show only their icons. */
  compact: boolean;
  onSort: (sort: SearchSort) => void;
  onView: (view: SearchView) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pb-3">
      <p className="flex items-center gap-2 text-[13px] text-ink-muted" role="status">
        <span>
          <span className="font-semibold text-ink tabular-nums">{total.toLocaleString()}</span>{' '}
          {total === 1 ? 'result' : 'results'}
          <span className="text-ink-faint"> · {formatTook(tookMs)}</span>
        </span>
        {fetching && <Spinner size={12} label="Updating results" />}
      </p>
      <div className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-[13px] text-ink-muted">
          Sort
          <select
            value={sort}
            onChange={(e) => onSort(e.target.value as SearchSort)}
            className="focus-ring h-8 rounded-lg border border-line bg-raised pr-7 pl-2 text-[13px] text-ink"
          >
            {(Object.keys(SORT_LABELS) as SearchSort[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <div role="group" aria-label="Result layout" className="flex rounded-lg border border-line bg-raised p-0.5">
          <ViewButton
            active={view === 'flat'}
            onClick={() => onView('flat')}
            icon={<ListIcon size={14} />}
            label="List"
            compact={compact}
          />
          <ViewButton
            active={view === 'grouped'}
            onClick={() => onView('grouped')}
            icon={<LayersIcon size={14} />}
            label="By conversation"
            compact={compact}
          />
        </div>
      </div>
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
  compact,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  compact: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={label}
      className={clsx(
        'focus-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors',
        active ? 'bg-accent-soft font-medium text-accent-text' : 'text-ink-muted hover:bg-hover hover:text-ink',
      )}
    >
      {icon}
      <span className={compact ? 'sr-only' : 'max-sm:sr-only'}>{label}</span>
    </button>
  );
}
