import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import { isTypingTarget, useKeydown, useMediaQuery } from '../../lib/hooks';
import { useSyncStatus } from '../../lib/queries';
import { ShellContext, type ShellContextValue } from './shell';
import { Sidebar } from './Sidebar';
import { UpdateBanner } from './UpdateBanner';

/**
 * In-app links rendered as plain anchors (channel mentions from mrkdwn: `/c/C123`) would make the
 * window navigate away, which main blocks; route them instead. Router `<Link>`s (`#/…` under the
 * hash router) already prevent default before this runs.
 */
function useInternalLinkHandler() {
  const navigate = useNavigate();
  return useCallback(
    (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a');
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const raw = anchor.getAttribute('href');
      const href = raw?.startsWith('#/') ? raw.slice(1) : raw;
      if (!href || !href.startsWith('/') || href.startsWith('//')) return;
      e.preventDefault();
      navigate(href);
    },
    [navigate],
  );
}

/** Sidebar + routed main pane, the update banner and global shortcuts. */
export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const sync = useSyncStatus();
  const onClick = useInternalLinkHandler();

  // The drawer closes whenever the reader goes somewhere.
  useEffect(() => setSidebarOpen(false), [location.pathname, location.search]);

  const focusSearch = useCallback(() => {
    setSidebarOpen(true);
    // The drawer may still be inert for this frame on narrow screens.
    requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
  }, []);

  useKeydown((e) => {
    if (e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      focusSearch();
    } else if (e.key === '/' && !mod && !isTypingTarget(e.target)) {
      e.preventDefault();
      focusSearch();
    } else if (e.key === 'Escape' && sidebarOpen && !isDesktop) {
      e.preventDefault();
      setSidebarOpen(false);
    }
  });

  const shell = useMemo<ShellContextValue>(
    () => ({ sidebarOpen, setSidebarOpen, focusSearch }),
    [sidebarOpen, focusSearch],
  );
  const drawerHidden = !isDesktop && !sidebarOpen;

  return (
    <ShellContext.Provider value={shell}>
      <div className="flex h-full overflow-hidden bg-canvas text-ink" onClick={onClick}>
        {/* A hash link would be read as a route here, so the skip link moves focus itself. */}
        <a
          href="#main"
          onClick={(e) => {
            e.preventDefault();
            mainRef.current?.focus();
          }}
          className="sr-only z-[60] rounded-md bg-raised px-3 py-2 text-sm shadow-pop focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        {sidebarOpen && !isDesktop && (
          <div
            className="fixed inset-0 z-40 animate-fade-in bg-scrim lg:hidden"
            aria-hidden="true"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <Sidebar
          searchRef={searchRef}
          syncStatus={sync.data}
          syncError={sync.error}
          onClose={() => setSidebarOpen(false)}
          inert={drawerHidden}
          className={clsx(
            'fixed inset-y-0 left-0 z-50 w-[272px] shrink-0 transition-transform duration-200 ease-out lg:static lg:z-auto lg:translate-x-0 lg:transition-none',
            sidebarOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full',
          )}
        />
        <main ref={mainRef} id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
          <UpdateBanner />
          <Outlet />
        </main>
      </div>
    </ShellContext.Provider>
  );
}
