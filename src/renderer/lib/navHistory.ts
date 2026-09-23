/**
 * Back and Forward, as Slack has them: the pages visited in this window, up to HISTORY_LIMIT steps
 * back. The router's own history moves (navigate(-1) / navigate(1)); this keeps track of where in
 * it the reader is, so the buttons know when there is somewhere to go, and stops at the limit.
 *
 * Only real steps count: opening a conversation, a thread, a person, a search. What a page rewrites
 * in place (another result in the search preview, grouped or flat, Jump to latest) replaces the
 * current entry.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useNavigationType, type NavigationType } from 'react-router';

/** Steps Back can take at most. */
export const HISTORY_LIMIT = 20;

export interface NavHistoryState {
  /** Location keys, oldest first; `at` is where the reader is. */
  keys: string[];
  at: number;
}

/** The history after the router moved to `key` by `type` (a pure step, for tests). */
export function nextHistory(state: NavHistoryState, key: string, type: `${NavigationType}`): NavHistoryState {
  if (state.keys[state.at] === key) return state;
  if (type === 'PUSH') {
    // Going somewhere new drops what was ahead, like a browser; the oldest go past the limit.
    const keys = [...state.keys.slice(0, state.at + 1), key].slice(-(HISTORY_LIMIT + 1));
    return { keys, at: keys.length - 1 };
  }
  if (type === 'REPLACE') {
    const keys = [...state.keys];
    keys[state.at] = key;
    return { keys, at: state.at };
  }
  const at = state.keys.indexOf(key);
  return at >= 0 ? { keys: state.keys, at } : { keys: [key], at: 0 };
}

export interface NavHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  back(): void;
  forward(): void;
}

/** Tracks the window's history; mounted once, in the app shell. */
export function useNavHistoryTracker(): NavHistory {
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  const [state, setState] = useState<NavHistoryState>(() => ({ keys: [location.key], at: 0 }));
  useEffect(() => setState((s) => nextHistory(s, location.key, type)), [location.key, type]);

  const canGoBack = state.at > 0;
  const canGoForward = state.at < state.keys.length - 1;
  const back = useCallback(() => {
    if (canGoBack) void navigate(-1);
  }, [canGoBack, navigate]);
  const forward = useCallback(() => {
    if (canGoForward) void navigate(1);
  }, [canGoForward, navigate]);
  return useMemo(() => ({ canGoBack, canGoForward, back, forward }), [canGoBack, canGoForward, back, forward]);
}
