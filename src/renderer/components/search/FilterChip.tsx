import { useEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { usePopover } from '../../lib/hooks';
import { ChevronDownIcon, CloseIcon } from '../icons';

/** How a change made inside an open chip should reach the URL. */
export interface EditMode {
  /** First change of an open session pushes a history entry; later ones replace it. */
  replace: boolean;
}

export interface FilterChipRenderProps {
  close: () => void;
  /** Call once per change to get its history mode. */
  nextEdit: () => EditMode;
}

export interface FilterChipProps {
  /** Dimension name, e.g. "In" or "From". */
  label: string;
  /** Summary of the current value; null when the filter is inactive. */
  value: string | null;
  icon: ReactNode;
  onClear: () => void;
  children: (props: FilterChipRenderProps) => ReactNode;
  panelClassName?: string;
}

/**
 * A filter pill that opens an anchored panel. Several toggles while the panel is open count as
 * one history step, so Back undoes the whole edit rather than each checkbox.
 */
export function FilterChip({ label, value, icon, onClear, children, panelClassName }: FilterChipProps) {
  const { open, setOpen, toggle, containerRef } = usePopover<HTMLDivElement>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const edits = useRef(0);
  const wasOpen = useRef(false);
  const active = value != null;

  useEffect(() => {
    if (open) edits.current = 0;
    // Return focus to the chip when the panel closes with focus inside it (Esc, Done, Apply).
    if (wasOpen.current && !open) {
      const focused = document.activeElement;
      if (!focused || focused === document.body || containerRef.current?.contains(focused)) {
        triggerRef.current?.focus();
      }
    }
    wasOpen.current = open;
  }, [open, containerRef]);

  const renderProps: FilterChipRenderProps = {
    close: () => setOpen(false),
    nextEdit: () => ({ replace: edits.current++ > 0 }),
  };

  return (
    <div ref={containerRef} className="relative">
      <div
        className={clsx(
          'inline-flex h-8 items-center rounded-full border text-[13px] transition-colors',
          active
            ? 'border-accent/35 bg-accent-soft text-accent-text'
            : 'border-line bg-raised text-ink-muted hover:border-line-strong hover:text-ink',
        )}
      >
        <button
          ref={triggerRef}
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={clsx(
            'focus-ring flex h-full max-w-64 items-center gap-1.5 rounded-full pl-3',
            active ? 'pr-1.5' : 'pr-2.5',
          )}
        >
          <span className="shrink-0 opacity-80">{icon}</span>
          <span className={clsx('shrink-0', active && 'font-medium')}>{label}</span>
          {active && <span className="min-w-0 truncate font-semibold">{value}</span>}
          {!active && <ChevronDownIcon size={13} className="shrink-0 opacity-70" />}
        </button>
        {active && (
          <button
            type="button"
            onClick={onClear}
            aria-label={`Clear ${label} filter`}
            title={`Clear ${label} filter`}
            className="focus-ring mr-1 flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-accent/15"
          >
            <CloseIcon size={13} />
          </button>
        )}
      </div>
      {open && (
        <div
          role="dialog"
          aria-label={`${label} filter`}
          className={clsx(
            'absolute top-full left-0 z-40 mt-1.5 w-80 max-w-[calc(100vw-2rem)] animate-pop-in rounded-xl border border-line bg-raised shadow-pop',
            panelClassName,
          )}
        >
          {children(renderProps)}
        </div>
      )}
    </div>
  );
}
