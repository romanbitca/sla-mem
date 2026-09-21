import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import clsx from 'clsx';

export interface TooltipProps {
  label: ReactNode;
  /** A single focusable element; it receives `aria-describedby`. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  side?: 'top' | 'bottom';
  className?: string;
}

/**
 * CSS-only tooltip (hover and keyboard focus). No positioning engine: it's for short labels on
 * small controls, placed above by default where the message list leaves room.
 */
export function Tooltip({ label, children, side = 'top', className }: TooltipProps) {
  const id = useId();
  const trigger = isValidElement(children) ? cloneElement(children, { 'aria-describedby': id }) : children;
  return (
    <span className={clsx('group/tooltip relative inline-flex', className)}>
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={clsx(
          'pointer-events-none absolute left-1/2 z-30 w-max max-w-64 -translate-x-1/2 rounded-md px-2 py-1',
          'bg-tooltip text-tooltip-ink text-xs leading-snug font-medium shadow-lg',
          'invisible opacity-0 transition-opacity delay-150 duration-100',
          'group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-focus-within/tooltip:visible group-focus-within/tooltip:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {label}
      </span>
    </span>
  );
}
