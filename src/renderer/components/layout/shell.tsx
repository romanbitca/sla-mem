import { createContext, createRef, useContext, type RefObject } from 'react';
import { MenuIcon } from '../icons';
import { IconButton } from '../ui/IconButton';

export interface ShellContextValue {
  /** Narrow layouts show the sidebar as a drawer. */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  /** Opens the search screen (the last search) and puts the cursor in its box, as ⌘K does. */
  focusSearch: () => void;
  /** The search screen's text box, while it is shown. */
  searchInputRef: RefObject<HTMLInputElement | null>;
}

export const ShellContext = createContext<ShellContextValue>({
  sidebarOpen: false,
  setSidebarOpen: () => {},
  focusSearch: () => {},
  searchInputRef: createRef<HTMLInputElement>(),
});

export function useShell(): ShellContextValue {
  return useContext(ShellContext);
}

/** Hamburger shown only when the sidebar is collapsed into a drawer (below the lg breakpoint). */
export function SidebarToggle({ className }: { className?: string }) {
  const { setSidebarOpen } = useShell();
  return (
    <IconButton
      label="Show sidebar"
      icon={<MenuIcon size={18} />}
      onClick={() => setSidebarOpen(true)}
      className={`lg:hidden ${className ?? ''}`}
    />
  );
}
