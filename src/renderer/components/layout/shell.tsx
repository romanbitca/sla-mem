import { createContext, createRef, useContext, type RefObject } from 'react';
import { currentPlatform } from '../../lib/bridge';
import type { NavHistory } from '../../lib/navHistory';
import { ArrowLeftIcon, ArrowRightIcon, MenuIcon } from '../icons';
import { IconButton } from '../ui/IconButton';

export interface ShellContextValue {
  /** Narrow layouts show the sidebar as a drawer. */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  /** Opens the search screen (the last search) and puts the cursor in its box, as ⌘K does. */
  focusSearch: () => void;
  /** The search screen's text box, while it is shown. */
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Back and Forward through the pages visited. */
  history: NavHistory;
}

export const ShellContext = createContext<ShellContextValue>({
  sidebarOpen: false,
  setSidebarOpen: () => {},
  focusSearch: () => {},
  searchInputRef: createRef<HTMLInputElement>(),
  history: { canGoBack: false, canGoForward: false, back: () => {}, forward: () => {} },
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

/** What the Back and Forward shortcuts are called here. */
export function historyShortcuts(): { back: string; forward: string } {
  return currentPlatform() === 'darwin' ? { back: '⌘[', forward: '⌘]' } : { back: 'Alt+←', forward: 'Alt+→' };
}

/** Back and Forward through the pages visited, as in Slack. */
export function HistoryButtons({ className }: { className?: string }) {
  const { history } = useShell();
  const keys = historyShortcuts();
  return (
    <div className={`flex shrink-0 items-center ${className ?? ''}`}>
      <IconButton
        size="sm"
        label="Back"
        title={`Back (${keys.back})`}
        icon={<ArrowLeftIcon size={16} />}
        disabled={!history.canGoBack}
        onClick={history.back}
      />
      <IconButton
        size="sm"
        label="Forward"
        title={`Forward (${keys.forward})`}
        icon={<ArrowRightIcon size={16} />}
        disabled={!history.canGoForward}
        onClick={history.forward}
      />
    </div>
  );
}

/** The start of every page's header: the sidebar toggle (narrow windows) and Back / Forward. */
export function PageNav() {
  return (
    <>
      <SidebarToggle />
      <HistoryButtons className="-ml-1 mr-1" />
    </>
  );
}
