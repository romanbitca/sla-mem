import clsx from 'clsx';
import type { ReactNode } from 'react';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-raised px-1',
        'font-sans text-[11px] font-medium text-ink-faint',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere. */
export function modKeyLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
}
