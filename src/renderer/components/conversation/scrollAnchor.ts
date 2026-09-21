/**
 * Manual scroll anchoring for the message list.
 *
 * Prepending older messages, dropping far pages (bounded window) and late-loading images all
 * change content height above the reader. Browsers' native `overflow-anchor` handles some of
 * this, but not in every engine and not predictably when combined with our own adjustments, so
 * the list disables it and keeps the topmost visible message at a constant offset instead.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export interface ScrollAnchor {
  ts: string;
  /** Distance from the container's top edge to the anchor's top edge, in px. */
  offset: number;
}

export const MESSAGE_SELECTOR = '[data-msg-ts]';

/** The first message whose bottom edge is below the container's top edge (binary search). */
export function findAnchor(container: HTMLElement): ScrollAnchor | null {
  const nodes = container.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR);
  if (nodes.length === 0) return null;
  const top = container.getBoundingClientRect().top;
  let lo = 0;
  let hi = nodes.length - 1;
  let found = nodes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].getBoundingClientRect().bottom > top) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const el = nodes[found];
  const ts = el.dataset.msgTs;
  return ts ? { ts, offset: el.getBoundingClientRect().top - top } : null;
}

export function findMessageElement(container: HTMLElement, ts: string): HTMLElement | null {
  // ts values are validated digits-and-dot strings, safe inside a quoted attribute selector.
  return container.querySelector<HTMLElement>(`[data-msg-ts="${ts}"]`);
}

/** Scrolls so the anchor message sits at its recorded offset again. Returns the applied delta. */
export function restoreAnchor(container: HTMLElement, anchor: ScrollAnchor): number {
  const el = findMessageElement(container, anchor.ts);
  if (!el) return 0;
  const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const delta = offset - anchor.offset;
  if (Math.abs(delta) >= 1) container.scrollTop += delta;
  return delta;
}

export function isNearBottom(container: HTMLElement, threshold = 4): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
}

/**
 * Tracks the anchor on scroll and re-applies it when content resizes. When the reader is at the
 * bottom of the live end of the conversation, the list sticks to the bottom instead.
 */
export function useScrollAnchor(
  containerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  stickToBottom: boolean,
) {
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const atBottomRef = useRef(false);
  const stickRef = useRef(stickToBottom);
  useLayoutEffect(() => {
    stickRef.current = stickToBottom;
  }, [stickToBottom]);

  const capture = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    atBottomRef.current = isNearBottom(el);
    anchorRef.current = findAnchor(el);
  }, [containerRef]);

  const restore = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickRef.current && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (anchorRef.current) {
      restoreAnchor(el, anchorRef.current);
    }
    capture();
  }, [containerRef, capture]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => restore());
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, restore]);

  return { capture, restore, anchorRef, atBottomRef };
}
