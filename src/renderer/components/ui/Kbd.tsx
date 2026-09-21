import clsx from 'clsx';
import type { ReactNode } from 'react';
import { currentPlatform } from '../../lib/bridge';

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

/** "⌘" on macOS, "Ctrl" on Windows and Linux (the platform comes from the app itself). */
export function modKeyLabel(): string {
  return currentPlatform() === 'darwin' ? '⌘' : 'Ctrl';
}
