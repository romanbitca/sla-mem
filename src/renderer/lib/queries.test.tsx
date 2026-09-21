// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { SyncStatusDTO } from '../../shared/types';
import { makeRun, makeSyncStatus, testQueryClient } from '../test/helpers';
import { isRunFinished, lastFinishedRunKey, qk, useSyncRunWatcher } from './queries';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const idle = (runs = [makeRun({ id: 1, finishedAt: 1_000 })]) => makeSyncStatus({ running: false, recentRuns: runs });
const running = (runs = [makeRun({ id: 1, finishedAt: 1_000 })]) =>
  makeSyncStatus({
    running: true,
    currentRun: makeRun({ id: 2, status: 'running', finishedAt: null }),
    recentRuns: [makeRun({ id: 2, status: 'running', finishedAt: null }), ...runs],
  });

describe('finished runs', () => {
  it('identifies the latest finished run whatever the list order', () => {
    const a = makeRun({ id: 3, finishedAt: 3_000 });
    const b = makeRun({ id: 4, finishedAt: 4_000 });
    const live = makeRun({ id: 5, status: 'running', finishedAt: null });
    expect(lastFinishedRunKey(makeSyncStatus({ recentRuns: [live, b, a] }))).toBe('4:4000');
    expect(lastFinishedRunKey(makeSyncStatus({ recentRuns: [a, b, live] }))).toBe('4:4000');
    expect(lastFinishedRunKey(makeSyncStatus({ recentRuns: [live] }))).toBeNull();
  });

  it('knows when a given run is over', () => {
    const status = makeSyncStatus({
      running: true,
      recentRuns: [makeRun({ id: 8, finishedAt: null, status: 'running' }), makeRun({ id: 7, finishedAt: 7_000 })],
    });
    expect(isRunFinished(status, 7)).toBe(true);
    expect(isRunFinished(status, 8)).toBe(false);
    // Not listed yet: main hasn't reported it, so it isn't over.
    expect(isRunFinished(status, 9)).toBe(false);
    // Main started nothing: done as soon as nothing runs.
    expect(isRunFinished(status, null)).toBe(false);
    expect(isRunFinished({ ...status, running: false }, null)).toBe(true);
  });
});

describe('useSyncRunWatcher', () => {
  function watch(initial: SyncStatusDTO | undefined) {
    const client = testQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(({ status }) => useSyncRunWatcher(status), { wrapper, initialProps: { status: initial } });
    const refreshed = () => invalidate.mock.calls.some(([filters]) => filters?.queryKey === qk.messagesAll);
    return { ...hook, invalidate, refreshed };
  }

  it('does nothing on the first status it sees', () => {
    const { refreshed } = watch(idle());
    expect(refreshed()).toBe(false);
  });

  it('refreshes the archive when a run it saw running finishes', () => {
    const { rerender, refreshed } = watch(running());
    expect(refreshed()).toBe(false);
    rerender({ status: idle([makeRun({ id: 2, finishedAt: 2_000 }), makeRun({ id: 1, finishedAt: 1_000 })]) });
    expect(refreshed()).toBe(true);
  });

  it('refreshes after a run that started and finished between two updates', () => {
    const { rerender, refreshed, invalidate } = watch(idle());
    rerender({ status: idle() });
    expect(refreshed()).toBe(false);
    // A single file's Retry: never seen running, but a new finished run is listed.
    rerender({ status: idle([makeRun({ id: 2, kind: 'files', finishedAt: 2_000 }), makeRun({ id: 1 })]) });
    expect(refreshed()).toBe(true);
    const calls = invalidate.mock.calls.length;
    rerender({ status: idle([makeRun({ id: 2, kind: 'files', finishedAt: 2_000 }), makeRun({ id: 1 })]) });
    expect(invalidate.mock.calls.length).toBe(calls);
  });
});
