import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { useKeydown } from '../../lib/hooks';
import { Button } from './Button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Body text; also the dialog's accessible description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned in the footer. */
  footer?: ReactNode;
  /** `alertdialog` for confirmations that interrupt the user. */
  role?: 'dialog' | 'alertdialog';
  /** Receives focus when the dialog opens (defaults to the first focusable element). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Receives focus when it closes (defaults to whatever was focused before it opened; Safari
   * doesn't focus buttons on click, so pass the opener).
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * Modal dialog: portal, scrim, focus moved inside and trapped (Tab / Shift+Tab wrap), Esc and a
 * click on the scrim close it, and focus returns to the opener afterwards.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  role = 'dialog',
  initialFocusRef,
  returnFocusRef,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const target =
      initialFocusRef?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panelRef.current;
    target?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const returnRef = returnFocusRef;
    return () => {
      document.body.style.overflow = overflow;
      (returnRef?.current ?? previouslyFocused)?.focus?.();
    };
    // Focus is placed once per opening. The refs are stable `useRef` objects, so listing them
    // doesn't re-run this; callers must not pass fresh ref objects on every render.
  }, [open, initialFocusRef, returnFocusRef]);

  useKeydown(
    (e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    },
    { enabled: open, overlay: true },
  );

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex animate-fade-in items-center justify-center bg-scrim p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={clsx(
          'flex w-full max-w-md animate-pop-in flex-col gap-4 rounded-2xl border border-line bg-raised p-5 shadow-pop outline-none',
          className,
        )}
      >
        <div className="flex flex-col gap-1.5">
          <h2 id={titleId} className="text-[15px] font-semibold text-ink">
            {title}
          </h2>
          {description && (
            <div id={descriptionId} className="text-[13.5px] leading-relaxed text-ink-muted">
              {description}
            </div>
          )}
        </div>
        {children}
        {footer && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  busy?: boolean;
  /** Shown under the text, e.g. why the action failed. */
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Yes/no confirmation. Focus starts on Cancel, so Enter never confirms a destructive action by accident. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
  returnFocusRef,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onCancel}
      role="alertdialog"
      title={title}
      description={description}
      initialFocusRef={cancelRef}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
