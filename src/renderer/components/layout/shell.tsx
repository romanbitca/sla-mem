import { createContext, useContext } from 'react';
import { MenuIcon } from '../icons';
import { IconButton } from '../ui/IconButton';

export interface ShellContextValue {
  /** Narrow layouts show the sidebar as a drawer. */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  /** Focuses (and reveals) the sidebar search box, as ⌘K does. */
  focusSearch: () => void;
}

export const ShellContext = createContext<ShellContextValue>({
  sidebarOpen: false,
  setSidebarOpen: () => {},
  focusSearch: () => {},
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
