import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { InfoIcon } from '../icons';

export interface InfoTipProps {
  /** What the button says to screen readers: "How reply time is worked out". */
  label: string;
  children: ReactNode;
  /** Which edge of the button the panel lines up with. */
  align?: 'start' | 'end';
  className?: string;
}

/** How long the panel stays after the pointer leaves, so it can travel from the button to it. */
const LEAVE_MS = 150;

/**
 * An "i" that explains how something is worked out. Pointing at it shows the explanation; a click
 * (or Enter) keeps it open until a second click, Escape or a click elsewhere.
 */
export function InfoTip({ label, children, align = 'end', className }: InfoTipProps) {
  const [mode, setMode] = useState<'closed' | 'hover' | 'pinned'>('closed');
  // After closing it with a click or Escape, pointing at it again only counts once the pointer left.
  const [muted, setMuted] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = mode !== 'closed';

  const cancelLeave = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  useEffect(() => cancelLeave, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setMode('closed');
      setMuted(true);
      buttonRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (mode === 'pinned' && !rootRef.current?.contains(e.target as Node)) setMode('closed');
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, mode]);

  return (
    <span
      ref={rootRef}
      className={clsx('relative inline-flex align-middle', className)}
      onMouseEnter={() => {
        cancelLeave();
        if (!muted) setMode((m) => (m === 'closed' ? 'hover' : m));
      }}
      onMouseLeave={() => {
        setMuted(false);
        cancelLeave();
        leaveTimer.current = setTimeout(() => setMode((m) => (m === 'hover' ? 'closed' : m)), LEAVE_MS);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          if (mode === 'pinned') {
            setMode('closed');
            setMuted(true);
          } else {
            setMode('pinned');
          }
        }}
        className={clsx(
          'focus-ring inline-flex size-5 shrink-0 items-center justify-center rounded-full transition-colors',
          open ? 'text-accent-text' : 'text-ink-faint hover:text-ink-muted',
        )}
      >
        <InfoIcon size={15} />
      </button>
      {open && (
        <div
          id={panelId}
          className={clsx(
            'absolute top-full z-30 mt-1.5 w-[23rem] max-w-[calc(100vw-2rem)] cursor-auto rounded-xl border border-line bg-raised p-4 text-left',
            'text-[12.5px] leading-relaxed font-normal tracking-normal text-ink-muted normal-case shadow-pop',
            'flex flex-col gap-2 [&_b]:font-semibold [&_b]:text-ink [&_li]:pl-0.5 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1 [&_ul]:pl-4',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {children}
        </div>
      )}
    </span>
  );
}
