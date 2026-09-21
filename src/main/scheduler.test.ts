import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conflict } from './errors';
import { Scheduler } from './scheduler';
import type { SchedulerRuns } from './scheduler';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);

/** In-memory stand-in for RunManager: startSync "completes" instantly and records a success. */
function fakeRuns(opts: { lastSuccess?: number | null; blocked?: string | null } = {}) {
  const state = {
    lastSuccess: opts.lastSuccess ?? null,
    blocked: opts.blocked ?? null,
    running: false,
    nextRunAt: null as number | null,
    starts: [] as number[],
    startError: null as Error | null,
  };
  const runs: SchedulerRuns = {
    isRunning: () => state.running,
    blockedReason: () => state.blocked,
    lastSuccessfulSyncAt: () => state.lastSuccess,
    setNextRunAt: (at) => {
      state.nextRunAt = at;
    },
    startSync: () => {
      if (state.startError) throw state.startError;
      state.starts.push(Date.now());
      state.lastSuccess = Date.now();
      return state.starts.length;
    },
  };
  return { runs, state };
}

let schedulers: Scheduler[] = [];
function scheduler(runs: SchedulerRuns, intervalMinutes = 60, log?: (l: string) => void): Scheduler {
  const s = new Scheduler({ runs, intervalMinutes, log });
  schedulers.push(s);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  schedulers = [];
});

afterEach(() => {
  for (const s of schedulers) s.stop();
  vi.useRealTimers();
});

describe('Scheduler', () => {
  it('is disabled with an interval of 0', async () => {
    const { runs, state } = fakeRuns();
    const s = scheduler(runs, 0);
    s.start();
    expect(s.enabled).toBe(false);
    expect(s.nextRunAt).toBeNull();
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(state.starts).toEqual([]);
  });

  it('catches up ~10s after boot when there was never a successful sync, then repeats every interval', async () => {
    const { runs, state } = fakeRuns();
    const s = scheduler(runs, 60);
    s.start();
    expect(s.nextRunAt).toBe(T0 + 10_000);
    expect(state.nextRunAt).toBe(T0 + 10_000);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(state.starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.starts).toEqual([T0 + 10_000]);
    expect(state.nextRunAt).toBe(T0 + 10_000 + 60 * MIN);

    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(state.starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(state.starts).toHaveLength(3);
  });

  it('catches up after boot when the last success is older than the interval', async () => {
    const { runs, state } = fakeRuns({ lastSuccess: T0 - 3 * 60 * MIN });
    scheduler(runs, 60).start();
    expect(state.nextRunAt).toBe(T0 + 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.starts).toHaveLength(1);
  });

  it('waits for the interval when the last success is recent', async () => {
    const lastSuccess = T0 - 20 * MIN;
    const { runs, state } = fakeRuns({ lastSuccess });
    scheduler(runs, 60).start();
    expect(state.nextRunAt).toBe(lastSuccess + 60 * MIN);
    await vi.advanceTimersByTimeAsync(39 * MIN);
    expect(state.starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(state.starts).toEqual([lastSuccess + 60 * MIN]);
  });

  it('postpones when a manual sync happened since the tick was planned', async () => {
    const { runs, state } = fakeRuns({ lastSuccess: T0 - 60 * MIN });
    scheduler(runs, 60).start();
    await vi.advanceTimersByTimeAsync(5_000);
    state.lastSuccess = Date.now(); // e.g. `npm run sync` finished just now
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.starts).toEqual([]);
    expect(state.nextRunAt).toBe(T0 + 5_000 + 60 * MIN);
  });

  it('skips while a run is active or the mode is blocked, and tries again next interval', async () => {
    const lines: string[] = [];
    const { runs, state } = fakeRuns({ blocked: 'SLACK_TOKEN is not set' });
    scheduler(runs, 30, (l) => lines.push(l)).start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.starts).toEqual([]);
    expect(lines.at(-1)).toMatch(/Skipping scheduled sync: SLACK_TOKEN is not set/);

    state.blocked = null;
    state.running = true;
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(state.starts).toEqual([]);
    expect(lines.at(-1)).toMatch(/another run is in progress/);

    state.running = false;
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(state.starts).toHaveLength(1);
  });

  it('logs and survives a refused start (e.g. another process holds the lock)', async () => {
    const lines: string[] = [];
    const { runs, state } = fakeRuns();
    state.startError = conflict('Another sync is already running in a different process');
    scheduler(runs, 60, (l) => lines.push(l)).start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines.at(-1)).toMatch(/did not start: Another sync/);
    expect(state.nextRunAt).toBe(T0 + 10_000 + 60 * MIN);

    state.startError = null;
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(state.starts).toHaveLength(1);
  });

  it('stop() cancels the pending tick and clears nextRunAt', async () => {
    const { runs, state } = fakeRuns();
    const s = scheduler(runs, 60);
    s.start();
    s.stop();
    expect(s.nextRunAt).toBeNull();
    expect(state.nextRunAt).toBeNull();
    await vi.advanceTimersByTimeAsync(2 * 60 * MIN);
    expect(state.starts).toEqual([]);
    await s.tick(); // A stray tick after stop does nothing.
    expect(state.starts).toEqual([]);
  });

  it('handles intervals longer than the setTimeout limit by hopping', async () => {
    const lastSuccess = T0;
    const { runs, state } = fakeRuns({ lastSuccess });
    const interval = 60 * 24 * 40; // 40 days
    scheduler(runs, interval).start();
    expect(state.nextRunAt).toBe(lastSuccess + interval * MIN);
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * MIN);
    expect(state.starts).toEqual([]);
    expect(state.nextRunAt).toBe(lastSuccess + interval * MIN);
    await vi.advanceTimersByTimeAsync(10 * 24 * 60 * MIN);
    expect(state.starts).toHaveLength(1);
  });
});

/** Stand-in for Preferences: the interval, plus the 'changed' event. */
class FakeSettings extends EventEmitter {
  intervalMinutes = 60;
  get() {
    return { syncIntervalMinutes: this.intervalMinutes };
  }
  set(patch: { intervalMinutes?: number }) {
    Object.assign(this, patch);
    this.emit('changed');
  }
}

describe('Scheduler with live settings', () => {
  function live(opts: { lastSuccess?: number | null } = {}) {
    const { runs, state } = fakeRuns(opts);
    const settings = new FakeSettings();
    const connection = new EventEmitter();
    const lines: string[] = [];
    const s = new Scheduler({ runs, settings, connection, log: (l) => lines.push(l) });
    schedulers.push(s);
    return { s, runs, state, settings, connection, lines };
  }

  it('reschedules when the interval changes in Settings', async () => {
    const lastSuccess = T0 - 20 * MIN;
    const { s, state, settings, lines } = live({ lastSuccess });
    s.start();
    expect(state.nextRunAt).toBe(lastSuccess + 60 * MIN);

    settings.set({ intervalMinutes: 15 }); // already overdue → soon, after the short delay
    expect(state.nextRunAt).toBe(T0 + 10_000);
    expect(lines.at(-1)).toBe('Automatic sync every 15 min');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.starts).toEqual([T0 + 10_000]);
    expect(state.nextRunAt).toBe(T0 + 10_000 + 15 * MIN);

    settings.set({ intervalMinutes: 24 * 60 }); // longer: waits for the new interval from the last success
    expect(state.nextRunAt).toBe(T0 + 10_000 + 24 * 60 * MIN);
  });

  it('manual only (0) disables it until the interval is set again', async () => {
    const { s, state, settings, lines } = live();
    s.start();
    settings.set({ intervalMinutes: 0 });
    expect(s.enabled).toBe(false);
    expect(state.nextRunAt).toBeNull();
    expect(lines.at(-1)).toBe('Automatic sync is off');
    await vi.advanceTimersByTimeAsync(3 * 60 * MIN);
    expect(state.starts).toEqual([]);

    settings.set({ intervalMinutes: 60 });
    expect(state.nextRunAt).toBe(Date.now() + 10_000);
  });

  it('skips while Slack isn’t connected and comes back soon after connecting', async () => {
    const { s, state, connection, lines } = live();
    state.blocked = 'Connect Slack to start archiving.';
    s.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.starts).toEqual([]);
    expect(lines.at(-1)).toBe('Skipping scheduled sync: Connect Slack to start archiving.');

    state.blocked = null;
    connection.emit('connected');
    expect(state.nextRunAt).toBe(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.starts).toHaveLength(1);
  });

  it('after connecting, the first sync already running is the catch-up: next run is an interval away', async () => {
    const { s, state, connection, lines } = live();
    state.blocked = 'Connect Slack to start archiving.';
    s.start();

    // RunManager handles 'connected' first (it subscribes earlier) and starts the first sync.
    state.blocked = null;
    state.running = true;
    connection.emit('connected');
    expect(state.nextRunAt).toBe(Date.now() + 60 * MIN);

    // The first sync finishes; nothing extra runs before the interval is up.
    state.running = false;
    state.lastSuccess = Date.now() + 5_000;
    await vi.advanceTimersByTimeAsync(59 * MIN);
    expect(state.starts).toEqual([]);
    expect(lines.filter((l) => l.startsWith('Skipping'))).toEqual([]);
  });

  it('wake() runs a sync that became due while the computer slept', async () => {
    const { s, state } = live({ lastSuccess: T0 - 5 * MIN });
    s.start();
    expect(state.nextRunAt).toBe(T0 + 55 * MIN);
    // Asleep for three hours: the clock jumped, the timer didn't fire.
    vi.setSystemTime(T0 + 3 * 60 * MIN);
    s.wake();
    expect(state.nextRunAt).toBe(T0 + 3 * 60 * MIN + 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.starts).toHaveLength(1);
  });

  it('a tick that finds the schedule disabled clears nextRunAt', async () => {
    const { s, state, settings } = live();
    s.start();
    settings.intervalMinutes = 0; // changed without an event (e.g. read at tick time)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.starts).toEqual([]);
    expect(state.nextRunAt).toBeNull();
  });

  it('stop() unsubscribes from settings and connection', () => {
    const { s, settings, connection } = live();
    s.start();
    expect(settings.listenerCount('changed')).toBe(1);
    expect(connection.listenerCount('connected')).toBe(1);
    s.stop();
    expect(settings.listenerCount('changed')).toBe(0);
    expect(connection.listenerCount('connected')).toBe(0);
    expect(connection.listenerCount('disconnected')).toBe(0);
  });
});
