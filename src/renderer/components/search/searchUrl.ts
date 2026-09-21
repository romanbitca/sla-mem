/**
 * The search page keeps all of its state in the URL (`/search?q=…&conversation=…&has=…`), so
 * back/forward, reloads and shared links restore exactly the same search. This module maps
 * between the query string and a typed state, and implements chip edits as pure transforms.
 *
 * Filters can live in two places: explicit URL params (set through the chip controls) and
 * modifiers typed into `q` (`from:@bob`). Main applies both. The chips show the union
 * ("effective" filters); editing a chip in a way that drops something typed in `q` cuts those
 * modifiers out of the text and moves the whole selection into params.
 */
import type { SearchHas, SearchParams, SearchSort } from '../../../shared/types';
import {
  filtersFromQuery,
  HAS_VALUES,
  mergeFilters,
  normalizeHas,
  parseDay,
  stripDimension,
  type DateRange,
  type FilterDimension,
  type QueryFilters,
  type ResolverData,
} from './resolve';

export type SearchView = 'flat' | 'grouped';

export interface SearchUrlState extends QueryFilters {
  q: string;
  sort: SearchSort;
  view: SearchView;
}

export const SORTS: readonly SearchSort[] = ['relevance', 'newest', 'oldest'];

export const EMPTY_SEARCH: SearchUrlState = {
  q: '',
  conversation: [],
  user: [],
  after: null,
  before: null,
  has: [],
  sort: 'relevance',
  view: 'flat',
};

/** Slack ids are short alphanumerics; anything else in the URL is dropped rather than sent on. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

function parseIds(values: string[]): string[] {
  return unique(values.map((v) => v.trim()).filter((v) => ID_RE.test(v)));
}

function parseDateParam(value: string | null): string | null {
  return value && DAY_RE.test(value) && parseDay(value) === value ? value : null;
}

/** Canonical order keeps URLs (and react-query keys) stable regardless of click order. */
function sortHas(values: readonly SearchHas[]): SearchHas[] {
  return HAS_VALUES.filter((h) => values.includes(h));
}

export function parseSearchUrl(search: string | URLSearchParams): SearchUrlState {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const sort = params.get('sort');
  return {
    q: (params.get('q') ?? '').trim(),
    conversation: parseIds(params.getAll('conversation')),
    user: parseIds(params.getAll('user')),
    after: parseDateParam(params.get('after')),
    before: parseDateParam(params.get('before')),
    has: sortHas(params.getAll('has').flatMap((h) => normalizeHas(h) ?? [])),
    sort: SORTS.includes(sort as SearchSort) ? (sort as SearchSort) : 'relevance',
    view: params.get('view') === 'grouped' ? 'grouped' : 'flat',
  };
}

/** `?q=…` in canonical order, omitting defaults; '' when there's nothing to encode. */
export function serializeSearchUrl(state: SearchUrlState): string {
  const params = new URLSearchParams();
  if (state.q.trim()) params.set('q', state.q.trim());
  for (const id of unique(state.conversation)) params.append('conversation', id);
  for (const id of unique(state.user)) params.append('user', id);
  if (state.after) params.set('after', state.after);
  if (state.before) params.set('before', state.before);
  for (const h of sortHas(state.has)) params.append('has', h);
  if (state.sort !== 'relevance') params.set('sort', state.sort);
  if (state.view !== 'flat') params.set('view', state.view);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function searchLocation(state: SearchUrlState): string {
  return `/search${serializeSearchUrl(state)}`;
}

export function hasFilters(state: QueryFilters): boolean {
  return (
    state.conversation.length > 0 ||
    state.user.length > 0 ||
    state.has.length > 0 ||
    state.after != null ||
    state.before != null
  );
}

/** API params for the current state, or null when there is nothing to search for. */
export function toApiParams(state: SearchUrlState): SearchParams | null {
  const q = state.q.trim();
  if (!q && !hasFilters(state)) return null;
  const params: SearchParams = { q, sort: state.sort };
  if (state.conversation.length) params.conversation = state.conversation;
  if (state.user.length) params.user = state.user;
  if (state.after) params.after = state.after;
  if (state.before) params.before = state.before;
  if (state.has.length) params.has = sortHas(state.has);
  return params;
}

function explicitFilters(state: SearchUrlState): QueryFilters {
  return {
    conversation: state.conversation,
    user: state.user,
    has: state.has,
    after: state.after,
    before: state.before,
  };
}

/**
 * Filters search will apply: explicit params plus modifiers typed in `q`. Without directory
 * data (still loading) only the explicit params are known.
 */
export function effectiveFilters(state: SearchUrlState, data: ResolverData | null): QueryFilters {
  const explicit = explicitFilters(state);
  if (!data) return explicit;
  const merged = mergeFilters(explicit, filtersFromQuery(state.q, data));
  return { ...merged, has: sortHas(merged.has) };
}

type ListDimension = 'conversation' | 'user' | 'has';

function setList<D extends ListDimension>(
  state: SearchUrlState,
  dimension: D,
  next: SearchUrlState[D],
  data: ResolverData | null,
): SearchUrlState {
  const typed: readonly string[] = data ? filtersFromQuery(state.q, data)[dimension] : [];
  const nextList: readonly string[] = next;
  if (typed.every((id) => nextList.includes(id))) {
    // Everything typed in the query survives: keep the text as written, params hold the rest.
    return { ...state, [dimension]: nextList.filter((id) => !typed.includes(id)) };
  }
  return { ...state, q: data ? stripDimension(state.q, dimension, data) : state.q, [dimension]: next };
}

export function setConversationFilter(state: SearchUrlState, ids: string[], data: ResolverData | null) {
  return setList(state, 'conversation', unique(ids), data);
}

export function setUserFilter(state: SearchUrlState, ids: string[], data: ResolverData | null) {
  return setList(state, 'user', unique(ids), data);
}

export function setHasFilter(state: SearchUrlState, has: SearchHas[], data: ResolverData | null) {
  return setList(state, 'has', sortHas(has), data);
}

/** Date ranges don't compose partially, so any typed date modifiers move into the params. */
export function setDateFilter(state: SearchUrlState, range: DateRange, data: ResolverData | null): SearchUrlState {
  return {
    ...state,
    q: data ? stripDimension(state.q, 'date', data) : state.q,
    after: range.after,
    before: range.before,
  };
}

/** Drops every chip filter (params and resolvable typed modifiers); keeps words and `is:`. */
export function clearFilters(state: SearchUrlState, data: ResolverData | null): SearchUrlState {
  let q = state.q;
  if (data) {
    for (const dimension of ['conversation', 'user', 'date', 'has'] as FilterDimension[]) {
      q = stripDimension(q, dimension, data);
    }
  }
  return { ...state, q, conversation: [], user: [], has: [], after: null, before: null };
}

export function sameSearch(a: SearchUrlState, b: SearchUrlState): boolean {
  return serializeSearchUrl(a) === serializeSearchUrl(b);
}
