/**
 * Getting back to a search: the sidebar's Search reopens the last one, a message opened from the
 * results shows next to them (wide windows) or offers a way back to them (conversation page), and
 * the list comes back scrolled where the reader left it.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import type { MessageDTO } from '../../shared/types';
import { parseTsParam } from './ts';

// ─── the last search ─────────────────────────────────────────────────────────────────────────

let lastSearch: string | null = null;
const listeners = new Set<() => void>();

/** Called by the search page with its current location (`/search?…`). */
export function rememberSearch(url: string): void {
  if (url === lastSearch) return;
  lastSearch = url;
  for (const listener of listeners) listener();
}

/** Where the sidebar's Search goes: the last search, or an empty one. */
export function useLastSearch(): string {
  return useSyncExternalStore(subscribe, () => lastSearch ?? '/search');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── back from a conversation ────────────────────────────────────────────────────────────────

/** History state of a conversation opened from search results. */
export interface FromSearchState {
  /** The search to return to (`/search?…`). */
  fromSearch: string;
  /** The result that was opened, focused again on return. */
  hit: string;
}

export function fromSearchOf(state: unknown): FromSearchState | null {
  const s = state as Partial<FromSearchState> | null;
  if (!s || typeof s.fromSearch !== 'string' || !s.fromSearch.startsWith('/search')) return null;
  return { fromSearch: s.fromSearch, hit: typeof s.hit === 'string' ? s.hit : '' };
}

/** History state of the search page when coming back to it. */
export interface ReturnToSearchState {
  focusHit?: string;
  focusSearch?: boolean;
}

/**
 * `useSearchParams` whose updates keep the history entry's state, so a conversation opened from
 * search still knows its way back after a thread is opened or closed.
 */
export function useSearchParamsKeepingState(): ReturnType<typeof useSearchParams> {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const state = useRef(location.state);
  state.current = location.state;
  const set = useCallback<ReturnType<typeof useSearchParams>[1]>(
    (next, options) => setParams(next, { state: state.current, ...options }),
    [setParams],
  );
  return [params, set];
}

/** A result's identity in the list and in history state. */
export function messageKey(message: Pick<MessageDTO, 'conversationId' | 'ts'>): string {
  return `${message.conversationId}:${message.ts}`;
}

// ─── the preview next to the results ─────────────────────────────────────────────────────────

/**
 * The message open next to the results, in the search URL: `c` is its conversation, `ts` and
 * `thread` are the conversation view's own (a reply opens its thread).
 */
export interface SearchPreviewTarget {
  conversationId: string;
  ts: string | null;
  threadTs: string | null;
}

const PREVIEW_KEYS = ['c', 'ts', 'thread'] as const;
const CONVERSATION_ID = /^[A-Za-z0-9]{1,32}$/;

export function parsePreview(search: string): SearchPreviewTarget | null {
  const params = new URLSearchParams(search);
  const conversationId = params.get('c') ?? '';
  if (!CONVERSATION_ID.test(conversationId)) return null;
  return {
    conversationId,
    ts: parseTsParam(params.get('ts')),
    threadTs: parseTsParam(params.get('thread')),
  };
}

/** `search` with `message` open in the preview (`?q=…&c=…&ts=…`). */
export function withPreview(
  search: string,
  message: Pick<MessageDTO, 'conversationId' | 'ts' | 'threadTs' | 'isReply'>,
): string {
  const params = new URLSearchParams(withoutPreview(search));
  params.set('c', message.conversationId);
  if (message.isReply && message.threadTs) params.set('thread', message.threadTs);
  params.set('ts', message.ts);
  return `?${params.toString()}`;
}

/** `search` with a conversation open in the preview at its latest messages. */
export function withConversationPreview(search: string, conversationId: string): string {
  const params = new URLSearchParams(withoutPreview(search));
  params.set('c', conversationId);
  return `?${params.toString()}`;
}

/** `search` without the preview: the search itself. */
export function withoutPreview(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of PREVIEW_KEYS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/** `target` (`/search?…`) with the preview of `from` (a location's search) still open. */
export function carryPreview(target: string, from: string): string {
  const [path, query = ''] = target.split('?');
  const params = new URLSearchParams(query);
  const source = new URLSearchParams(from);
  for (const key of PREVIEW_KEYS) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

// ─── where the list was ──────────────────────────────────────────────────────────────────────

const scrollTops = new Map<string, number>();
const MAX_REMEMBERED = 20;

export function saveResultsScroll(searchKey: string, top: number): void {
  scrollTops.delete(searchKey);
  scrollTops.set(searchKey, top);
  if (scrollTops.size > MAX_REMEMBERED) scrollTops.delete(scrollTops.keys().next().value!);
}

export function resultsScroll(searchKey: string): number | null {
  return scrollTops.get(searchKey) ?? null;
}

/** A fresh window: no last search, no remembered list positions (tests). */
export function resetSearchNav(): void {
  scrollTops.clear();
  if (lastSearch === null) return;
  lastSearch = null;
  for (const listener of listeners) listener();
}
