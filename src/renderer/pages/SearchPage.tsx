import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import type { SearchResponse, SearchSort } from '../../shared/types';
import { describeError } from '../lib/api';
import { useStableCallback } from '../lib/hooks';
import { useConversations, useSearch, useUsers, useWorkspace } from '../lib/queries';
import { LayersIcon, ListIcon, SearchIcon } from '../components/icons';
import { SidebarToggle } from '../components/layout/shell';
import { Button } from '../components/ui/Button';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { LoadingState, Spinner } from '../components/ui/Spinner';
import { FilterBar } from '../components/search/FilterBar';
import type { EditMode } from '../components/search/FilterChip';
import { collectHits } from '../components/search/hits';
import { removeRawToken, tokenizeQuery } from '../components/search/queryText';
import type { ResolverData } from '../components/search/resolve';
import { SearchInput } from '../components/search/SearchInput';
import { SearchResults } from '../components/search/SearchResults';
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

/**
 * `/search`: the URL (q plus filter params) is the only source of truth, so back/forward and
 * reloads restore the exact search. The text box holds a draft until it's submitted.
 */
export default function SearchPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => parseSearchUrl(location.search), [location.search]);
  const data = useResolverData();
  const effective = useMemo(() => effectiveFilters(state, data), [state, data]);
  const params = useMemo(() => toApiParams(state), [state]);
  const search = useSearch(params);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // The draft follows the URL whenever the URL's query changes (submit, back/forward, sidebar).
  const [draft, setDraft] = useState(state.q);
  const [draftFor, setDraftFor] = useState(state.q);
  if (draftFor !== state.q) {
    setDraftFor(state.q);
    setDraft(state.q);
  }

  const go = useStableCallback((next: SearchUrlState, mode?: EditMode): boolean => {
    if (sameSearch(next, state)) return false;
    navigate(searchLocation(next), { replace: mode?.replace ?? false });
    return true;
  });

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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <SidebarToggle />
        <h1 className="text-[15px] font-semibold text-ink">Search</h1>
      </header>
      <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto">
        {/* Sticky from sm up; on phones the filter rows would eat half the screen. */}
        <div className="relative z-20 border-b border-line bg-canvas/95 backdrop-blur-sm sm:sticky sm:top-0">
          <div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 pt-4 pb-3 sm:px-6">
            <SearchInput
              value={draft}
              onChange={setDraft}
              onSubmit={submit}
              source={data}
              inputRef={inputRef}
              autoFocus={!params}
              onExitDown={focusFirstHit}
            />
            <FilterBar state={working} effective={effective} data={data} onChange={go} />
          </div>
        </div>
        <div className="mx-auto max-w-4xl px-1 py-4 sm:px-3">{body}</div>
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
  onSort,
  onView,
}: {
  total: number;
  tookMs: number;
  fetching: boolean;
  sort: SearchSort;
  view: SearchView;
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
          />
          <ViewButton
            active={view === 'grouped'}
            onClick={() => onView('grouped')}
            icon={<LayersIcon size={14} />}
            label="By conversation"
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
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
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
      <span className="max-sm:sr-only">{label}</span>
    </button>
  );
}
