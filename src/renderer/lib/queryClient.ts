import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './api';

/**
 * The archive only changes when a sync/import finishes (we invalidate then) and main pushes
 * status changes as events, so window-focus refetches would be pure churn. Errors from main are
 * deterministic ("not found", "not available") except unexpected ones, which get one more try.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: (failureCount, error) => isApiError(error) && error.code === 'internal' && failureCount < 2,
      },
      mutations: { retry: false },
    },
  });
}
