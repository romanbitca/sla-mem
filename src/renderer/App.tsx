import { lazy, Suspense, useState, type ReactNode } from 'react';
import { HashRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { LoadingState } from './components/ui/Spinner';
import { DirectoryProvider } from './lib/directory';
import { useArchiveEvents } from './lib/events';
import { useSettings, useSyncRunWatcher, useSyncStatus } from './lib/queries';
import { createQueryClient } from './lib/queryClient';
import { useAppliedTheme } from './lib/theme';
import ConversationPage from './pages/ConversationPage';
import HomePage from './pages/HomePage';
import NotFoundPage from './pages/NotFoundPage';
import PeoplePage from './pages/PeoplePage';
import PersonPage from './pages/PersonPage';
import SearchPage from './pages/SearchPage';

// Visited rarely (settings now and then, onboarding once): keep them out of the main bundle.
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const AskPage = lazy(() => import('./pages/AskPage'));

const Onboarding = lazy(() => import('./components/onboarding/Onboarding'));

/** Route table, separate from the router so tests can mount it in a MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="c/:id" element={<ConversationPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route
          path="ask"
          element={
            <Suspense fallback={<LoadingState label="Opening Ask AI…" />}>
              <AskPage />
            </Suspense>
          }
        />
        {/* In the main bundle, like Search: loading a page's code the first time costs ~300 ms. */}
        <Route path="people" element={<PeoplePage />} />
        <Route path="people/:id" element={<PersonPage />} />
        <Route
          path="settings"
          element={
            <Suspense fallback={<LoadingState label="Loading settings…" />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/**
 * Onboarding until main records it as done; the archive otherwise. If the settings can't be
 * loaded at all, the archive is still shown (with the error on the home page and in Settings):
 * a broken settings file must never lock anyone out of their messages.
 */
export function AppGate() {
  const settings = useSettings();
  // Only before the very first answer: a query without data goes back to "pending" whenever it
  // is retried (e.g. by a screen mounting after an error), and unmounting the whole app then
  // would remount that screen, retry again, and loop.
  if (settings.isPending && !settings.isFetched) {
    return <LoadingState label="Opening your archive…" className="h-full" />;
  }
  if (settings.data && !settings.data.preferences.onboardingComplete) {
    return (
      <Suspense fallback={<LoadingState label="Opening…" className="h-full" />}>
        <Onboarding settings={settings.data} />
      </Suspense>
    );
  }
  return <AppRoutes />;
}

/** App-wide wiring that needs the router: pushed events, theme, and refresh after each run. */
export function AppEffects() {
  useArchiveEvents();
  useAppliedTheme();
  useSyncRunWatcher(useSyncStatus().data);
  return null;
}

/** Data providers shared by the app and tests. */
export function AppProviders({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <DirectoryProvider>{children}</DirectoryProvider>
    </QueryClientProvider>
  );
}

export function App() {
  const [client] = useState(createQueryClient);
  return (
    <AppProviders client={client}>
      {/* The app loads a single page (slamem://app/index.html in production), so routes live in the
          hash (PLAN pitfall 29). Plain state updates (no transitions) keep scroll restoration in
          step with the URL. */}
      <HashRouter useTransitions={false}>
        <AppEffects />
        <ErrorBoundary className="flex h-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
          <AppGate />
        </ErrorBoundary>
      </HashRouter>
    </AppProviders>
  );
}
