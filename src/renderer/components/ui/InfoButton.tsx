import { useRef, useState, type ReactNode } from 'react';
import { InfoIcon } from '../icons';
import { Dialog } from './Dialog';

export interface InfoButtonProps {
  /** The dialog's title, and the button's name for screen readers unless `label` is given. */
  title: string;
  label?: string;
  children: ReactNode;
}

/**
 * An "i" that opens an explanation in a dialog: the page greys out behind it, and the ×, Escape
 * or a click outside closes it. For text too long to read in a tooltip.
 */
export function InfoButton({ title, label, children }: InfoButtonProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label ?? title}
        aria-haspopup="dialog"
        title={label ?? title}
        onClick={() => setOpen(true)}
        className="focus-ring inline-flex size-5 shrink-0 items-center justify-center rounded-full text-ink-faint transition-colors hover:text-accent-text"
      >
        <InfoIcon size={15} />
      </button>
      {/* Mounted while open, so each opening starts at the top. */}
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={title} closeButton size="lg" returnFocusRef={buttonRef}>
          <div className="flex flex-col gap-5 pb-1 text-[13.5px] leading-relaxed text-ink-muted">{children}</div>
        </Dialog>
      )}
    </>
  );
}
