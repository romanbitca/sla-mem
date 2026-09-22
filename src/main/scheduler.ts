/**
 * Periodic sync while the app runs (PLAN §5.3). Slack Free only shows 90 days of history, so
 * regular, unattended syncs are what keep older messages from being lost.
 *
 * Timing is anchored on the last *successful* sync (from the runs table), so a manual or CLI sync
 * pushes the next automatic one back instead of triggering a redundant run right after it.
 *
 * A sync found overdue (at start-up, or when the computer wakes) waits a random while first, up
 * to `catchUpSpreadMs`, so a company's computers opening at 9:00 don't all sync at once. That
 * wait is drawn once: a computer that sleeps through it syncs soon after it wakes.
 *
 * After a scheduled attempt the next check comes within `RETRY_CHECK_MS` even when the interval
 * is a week or a month: a check that finds the last sync fine only waits for its due time (no
 * request to Slack), and one that didn't succeed (offline, Slack down) is tried again.
 *
 * The interval is read from the settings each time the schedule is computed, and the schedule is
 * recomputed when the settings change or the Slack connection comes or goes, so editing
 * Settings → Sync (or connecting) takes effect without a restart.
 */
import { redactSecrets } from './redact';
import type { RunManager } from './runs';

export type SchedulerRuns = Pick<
  RunManager,
  'isRunning' | 'blockedReason' | 'startSync' | 'setNextRunAt' | 'lastSuccessfulSyncAt'
>;

/** Anything with EventEmitter-style subscription (Preferences, ConnectionService). */
export interface SchedulerEventSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/** What the scheduler reads from the preferences. */
export interface SchedulerSettings extends SchedulerEventSource {
  get(): { syncIntervalMinutes: number };
}

export interface SchedulerOptions {
  runs: SchedulerRuns;
  /** Source of the interval, re-read on every (re)schedule; its 'changed' event reschedules. */
  settings?: SchedulerSettings;
  /** 'connected' / 'disconnected' reschedule (the effective mode may have changed). */
  connection?: SchedulerEventSource;
  /** Fixed interval when no `settings` are given. 0 (or less) disables automatic syncs. */
  intervalMinutes?: number;
  /** Delay of the catch-up sync after boot (or a reschedule) when the last success is older than the interval. */
  bootDelayMs?: number;
  /** Up to this much random extra wait before a catch-up sync (0 = none; the app passes CATCH_UP_SPREAD_MS). */
  catchUpSpreadMs?: number;
  random?: () => number;
  now?: () => number;
  log?: (line: string) => void;
}

export const DEFAULT_BOOT_DELAY_MS = 10_000;
/** The random wait before a catch-up sync is up to half an hour. */
export const CATCH_UP_SPREAD_MS = 30 * 60_000;
/** After a scheduled attempt, check again within six hours: a sync that failed is retried then. */
export const RETRY_CHECK_MS = 6 * 60 * 60_000;
/** setTimeout overflows above 2^31-1 ms (~24.8 days); longer waits are split into hops. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Ticks that fire a little early (timer jitter) still count as due. */
const DUE_GRACE_MS = 1_000;

export class Scheduler {
  private readonly runs: SchedulerRuns;
  private readonly settings?: SchedulerSettings;
  private readonly connection?: SchedulerEventSource;
  private readonly fixedIntervalMinutes: number;
  private readonly bootDelayMs: number;
  private readonly catchUpSpreadMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private scheduledAt: number | null = null;
  private running = false;
  private lastIntervalMs: number | null = null;
  /** The pending run is a catch-up whose random wait was already drawn. */
  private catchUpPending = false;

  constructor(opts: SchedulerOptions) {
    this.runs = opts.runs;
    this.settings = opts.settings;
    this.connection = opts.connection;
    this.fixedIntervalMinutes = opts.intervalMinutes ?? 0;
    this.bootDelayMs = opts.bootDelayMs ?? DEFAULT_BOOT_DELAY_MS;
    this.catchUpSpreadMs = Math.max(0, opts.catchUpSpreadMs ?? 0);
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    const log = opts.log ?? (() => {});
    // Log lines may quote a failure message; Slack tokens and cookies never reach the log.
    this.log = (line) => log(redactSecrets(line));
  }

  /** Current interval in ms; 0 when automatic syncs are disabled (manual only). */
  get intervalMs(): number {
    if (!this.settings) return Math.max(0, this.fixedIntervalMinutes) * 60_000;
    return Math.max(0, this.settings.get().syncIntervalMinutes) * 60_000;
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  /** Epoch ms of the next automatic sync attempt, or null when stopped/disabled. */
  get nextRunAt(): number | null {
    return this.scheduledAt;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.settings?.on('changed', this.onChange);
    this.connection?.on('connected', this.onChange);
    this.connection?.on('disconnected', this.onChange);
    this.lastIntervalMs = this.intervalMs;
    this.reschedule();
  }

  stop(): void {
    this.running = false;
    this.catchUpPending = false;
    this.settings?.off('changed', this.onChange);
    this.connection?.off('connected', this.onChange);
    this.connection?.off('disconnected', this.onChange);
    this.clearTimer();
    this.setScheduledAt(null);
  }

  /**
   * Recomputes the next run from the current interval: soon (a catch-up) when the last success is
   * older than the interval, else when it becomes due. While a sync is already running (e.g. the
   * first sync RunManager starts on 'connected') that sync is the catch-up, so the next automatic
   * one is an interval away instead of a tick that would only find it busy.
   * Disabled → no next run.
   */
  reschedule(): void {
    if (!this.running) return;
    if (!this.enabled) {
      this.clearTimer();
      this.catchUpPending = false;
      this.setScheduledAt(null);
      return;
    }
    const now = this.now();
    if (this.runs.isRunning()) {
      this.catchUpPending = false;
      this.schedule(Math.max(now + this.intervalMs, this.dueAt(now)));
      return;
    }
    const due = this.dueAt(now);
    if (due > now + this.bootDelayMs) {
      this.catchUpPending = false;
      this.schedule(due);
    } else {
      this.scheduleCatchUp(now);
    }
  }

  /**
   * The computer woke up (or came back online): timers were frozen while it slept, so a sync that
   * became due in the meantime runs soon instead of an interval later.
   */
  wake(): void {
    if (!this.running || !this.enabled) return;
    const now = this.now();
    if (this.dueAt(now) <= now + DUE_GRACE_MS) this.scheduleCatchUp(now);
  }

  /** One scheduling decision. Public so tests can drive it directly. */
  async tick(): Promise<void> {
    this.timer = null;
    if (!this.running) return;
    if (!this.enabled) {
      this.setScheduledAt(null);
      return;
    }
    const now = this.now();
    const due = this.dueAt(now);
    if (due > now + DUE_GRACE_MS) {
      // Someone synced since this tick was planned (manual/CLI run), the timer hopped early, or
      // this is the check after a sync that went fine.
      this.catchUpPending = false;
      this.schedule(due);
      return;
    }
    this.catchUpPending = false;
    await this.attemptSync();
    if (!this.running) return;
    if (this.enabled) this.schedule(this.now() + this.intervalMs, this.now() + RETRY_CHECK_MS);
    else this.setScheduledAt(null);
  }

  private readonly onChange = (): void => {
    const interval = this.intervalMs;
    if (interval !== this.lastIntervalMs) {
      this.log(interval > 0 ? `Automatic sync every ${interval / 60_000} min` : 'Automatic sync is off');
    }
    this.lastIntervalMs = interval;
    this.reschedule();
  };

  private async attemptSync(): Promise<void> {
    try {
      if (!this.running) return;
      if (this.runs.isRunning()) {
        this.log('Skipping scheduled sync: another run is in progress');
        return;
      }
      const blocked = this.runs.blockedReason();
      if (blocked) {
        this.log(`Skipping scheduled sync: ${blocked}`);
        return;
      }
      const runId = this.runs.startSync();
      this.log(`Started scheduled sync (run #${runId})`);
    } catch (err) {
      // Another process holding the lock lands here; the next tick simply retries.
      this.log(`Scheduled sync did not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private dueAt(now: number): number {
    const last = this.runs.lastSuccessfulSyncAt();
    return last == null ? now : last + this.intervalMs;
  }

  /**
   * An overdue sync: after the boot delay plus a random wait the first time, so computers that
   * wake together don't sync together. The wait is kept across sleep (a computer that slept
   * through it syncs soon after waking) and across reschedules (a settings change doesn't draw a
   * new one).
   */
  private scheduleCatchUp(now: number): void {
    if (this.catchUpPending && this.scheduledAt != null) {
      this.schedule(Math.max(this.scheduledAt, now + this.bootDelayMs));
      return;
    }
    this.catchUpPending = true;
    this.schedule(now + this.bootDelayMs + Math.floor(this.random() * this.catchUpSpreadMs));
  }

  /**
   * Plans the next run at `at` (what the UI shows as the next sync). The timer may fire earlier, at
   * `checkAt`, to see whether the last attempt succeeded; it never fires later than `at`.
   */
  private schedule(at: number, checkAt: number = at): void {
    if (!this.running) return;
    this.clearTimer();
    this.setScheduledAt(at);
    const delay = Math.min(Math.max(0, Math.min(at, checkAt) - this.now()), MAX_TIMER_MS);
    this.timer = setTimeout(() => void this.tick(), delay);
    // The app keeps the process alive; the scheduler alone never should.
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setScheduledAt(at: number | null): void {
    this.scheduledAt = at;
    this.runs.setNextRunAt(at);
  }
}
