import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * A callback with a permanent identity that always calls the latest closure. Lets memoized
 * message rows receive handlers without re-rendering when the parent's state changes.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

export type KeyHandler = (event: KeyboardEvent) => void;

/**
 * Overlays (lightbox, popovers) listen in the capture phase and call `preventDefault()` on keys
 * they consume; page-level shortcuts listen in the bubble phase and skip prevented events.
 * That way Esc closes the innermost layer only.
 */
export function useKeydown(handler: KeyHandler, opts: { enabled?: boolean; overlay?: boolean } = {}): void {
  const { enabled = true, overlay = false } = opts;
  const stable = useStableCallback(handler);
  useEffect(() => {
    if (!enabled) return;
    const target: Document | Window = overlay ? document : window;
    const listener = (e: Event) => stable(e as KeyboardEvent);
    target.addEventListener('keydown', listener, overlay);
    return () => target.removeEventListener('keydown', listener, overlay);
  }, [enabled, overlay, stable]);
}

/** True when the event originates from a text field, where single-key shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Open/close state for a small anchored popover: closes on outside pointer-down and on Esc
 * (consuming the Esc so the thread panel behind it stays open).
 */
export function usePopover<T extends HTMLElement = HTMLDivElement>(): {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  containerRef: RefObject<T | null>;
} {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<T | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const el = containerRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useKeydown(
    (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
    },
    { enabled: open, overlay: true },
  );

  const toggle = useCallback(() => setOpen((o) => !o), []);
  return { open, setOpen, toggle, containerRef };
}

/** Temporarily true after `trigger()` (e.g. a "Copied" confirmation). */
export function useFlag(durationMs: number): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const trigger = useCallback(() => {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), durationMs);
  }, [durationMs]);
  return [on, trigger];
}

export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Current time, refreshed every `intervalMs`, so relative times ("5 minutes ago") stay true. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
