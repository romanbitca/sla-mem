import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreferencesDTO } from '../shared/types';
import { createRun, getRun, openDb, readLock, type DB } from './db';
import { DEFAULT_PREFERENCES } from './preferences';
import {
  NOT_CONNECTED_REASON,
  ONBOARDING_REASON,
  PROBLEM_MESSAGES,
  RunManager,
  classifyFailure,
  type RunConnection,
  type RunEvent,
  type RunJobs,
} from './runs';
import { SlackApiError, SlackHttpError, WrongAccountError } from './slack/errors';

const XOXC = 'xoxc-1111-2222-secret';
const COOKIE = 'xoxd-secret%2Fcookie';

let db: DB;
let dir: string;
let events: RunEvent[];
let signedOut: string[];
let now: number;

beforeEach(() => {
  db = openDb(':memory:');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-runs-'));
  events = [];
  signedOut = [];
  now = 1_800_000_000_000;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function connection(
  opts: { connected?: boolean; expired?: boolean; error?: string; unreadable?: boolean } = {},
): RunConnection {
  const state = { expired: opts.expired ?? false };
  return {
    hasCredentials: () => opts.connected ?? true,
    getCredentials: () => ((opts.connected ?? true) && !opts.unreadable ? { token: XOXC, cookie: COOKIE } : null),
    status: () => ({ expired: state.expired, error: opts.error ?? null }),
    markSignedOut: (code) => {
      signedOut.push(code);
      state.expired = true;
    },
  };
}

/** A job that waits until released (or aborted), then returns stats or throws. */
function controllableJob() {
  let release!: (value: Record<string, number> | Error) => void;
  const calls: { token: string; cookie?: string; attachmentPolicy: string; overlapSeconds?: number }[] = [];
  const job = async (opts: {
    signal: AbortSignal;
    onProgress: (p: never) => void;
    log: (l: string) => void;
    token: string;
    cookie?: string;
    attachmentPolicy: string;
    overlapSeconds?: number;
  }) => {
    calls.push({
      token: opts.token,
      cookie: opts.cookie,
      attachmentPolicy: opts.attachmentPolicy,
      overlapSeconds: opts.overlapSeconds,
    });
    opts.log(`working with ${opts.token}`);
    const result = await new Promise<Record<string, number> | Error>((resolve, reject) => {
      release = resolve;
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    });
    if (result instanceof Error) throw result;
    return result;
  };
  return { job, calls, release: (v: Record<string, number> | Error) => release(v) };
}

function manager(jobs: Partial<RunJobs>, conn = connection(), prefs: Partial<PreferencesDTO> = {}): RunManager {
  const m = new RunManager({
    db,
    filesDir: dir,
    prefs: { get: () => ({ ...DEFAULT_PREFERENCES, ...prefs }) },
    connection: conn,
    jobs,
    now: () => now,
    persistIntervalMs: 10,
  });
  m.subscribe((e) => events.push(e));
  return m;
}

describe('RunManager', () => {
  it('runs one job at a time with the saved session and the current preferences', async () => {
    const sync = controllableJob();
    const m = manager({ runApiSync: sync.job as never }, connection(), {
      attachmentPolicy: 'everything',
      overlapDays: 7,
    });
    expect(m.status()).toMatchObject({ lastSuccessAt: null, lastSuccessNewMessages: null });
    const id = m.startSync();
    expect(m.isRunning()).toBe(true);
    expect(() => m.startSync()).toThrow('A sync is already running.');
    await Promise.resolve();
    expect(sync.calls).toEqual([
      { token: XOXC, cookie: COOKIE, attachmentPolicy: 'everything', overlapSeconds: 7 * 86_400 },
    ]);
    sync.release({ messagesInserted: 3 });
    const run = await m.wait(id);
    expect(run).toMatchObject({ id, kind: 'sync', status: 'ok', stats: { messagesInserted: 3 }, error: null });
    expect(m.status()).toMatchObject({
      running: false,
      lastSuccessAt: now,
      lastSuccessNewMessages: 3, // shown as "just now · 3 new messages"
      problem: null,
      stale: false,
    });
    expect(events.map((e) => e.type)).toContain('finished');
    expect(readLock(db, 'sync')).toBeNull();
  });

  it('holds automatic syncs until onboarding is done, but runs a sync started by hand', async () => {
    const sync = controllableJob();
    const m = manager({ runApiSync: sync.job as never }, connection(), { onboardingComplete: false });
    expect(m.blockedReason()).toBe(ONBOARDING_REASON);
    const id = m.startSync();
    await Promise.resolve();
    sync.release({ messagesInserted: 1 });
    expect(await m.wait(id)).toMatchObject({ status: 'ok' });
    expect(manager({}, connection(), { onboardingComplete: true }).blockedReason()).toBeNull();
  });

  it('refreshes the people and conversation lists for onboarding without recording a run', async () => {
    const asked: unknown[] = [];
    const m = manager({
      runApiSync: async (opts) => {
        asked.push(opts.listsOnly);
        return {};
      },
    });
    await m.refreshLists();
    expect(asked).toEqual([true]);
    expect(m.status().recentRuns).toEqual([]);
  });

  it('explains a list refresh that failed in plain words', async () => {
    const m = manager({
      runApiSync: async () => {
        throw new SlackHttpError('users.conversations', null, 'fetch failed');
      },
    });
    await expect(m.refreshLists()).rejects.toMatchObject({
      code: 'blocked',
      message: PROBLEM_MESSAGES.offline.message,
    });
    await expect(manager({}, connection({ connected: false })).refreshLists()).rejects.toMatchObject({
      message: NOT_CONNECTED_REASON,
    });
  });

  it('never lets the token or cookie into logs, status or the runs table', async () => {
    const sync = controllableJob();
    const m = manager({ runApiSync: sync.job as never });
    const id = m.startSync();
    await Promise.resolve();
    sync.release(new Error(`boom with ${XOXC} and d=${COOKIE}`));
    await m.wait(id);
    const everything = JSON.stringify([m.status(), getRun(db, id), db.prepare('SELECT * FROM runs').all(), events]);
    expect(everything).not.toContain(XOXC);
    expect(everything).not.toContain(COOKIE);
  });

  it('is blocked, in plain words, until Slack is connected', () => {
    const m = manager({}, connection({ connected: false }));
    expect(m.blockedReason()).toBe(NOT_CONNECTED_REASON);
    expect(() => m.startSync()).toThrow(NOT_CONNECTED_REASON);
    expect(m.status()).toMatchObject({ blockedReason: NOT_CONNECTED_REASON, nextRunAt: null });
  });

  it('cancel stops the job promptly and keeps it recorded as cancelled', async () => {
    const sync = controllableJob();
    const m = manager({ runApiSync: sync.job as never });
    const id = m.startSync();
    await Promise.resolve();
    expect(m.cancel()).toBe(true);
    expect(await m.wait(id)).toMatchObject({ status: 'cancelled', error: null });
    expect(m.status().problem).toBeNull();
  });

  it('turns a signed-out session into a Reconnect problem and tells the connection', async () => {
    const sync = controllableJob();
    const m = manager({ runApiSync: sync.job as never });
    const id = m.startSync();
    await Promise.resolve();
    sync.release(new SlackApiError('auth.test', { error: 'invalid_auth' }));
    await m.wait(id);
    expect(signedOut).toEqual(['invalid_auth']);
    expect(m.status().problem).toEqual({
      kind: 'signed_out',
      message: 'Slack signed you out. Reconnect to keep archiving.',
      action: 'reconnect',
    });
  });

  it('a saved sign-in that can’t be read shows Reconnect with its reason, not a Sync now that does nothing', async () => {
    const reason = 'sla-mem needs you to sign in to Slack again. Reconnect to keep archiving.';
    const m = manager({}, connection({ expired: true, unreadable: true, error: reason }), { onboardingComplete: true });
    expect(m.status()).toMatchObject({
      blockedReason: reason,
      problem: { kind: 'signed_out', message: reason, action: 'reconnect' },
    });
    // Started anyway (the menu, a shortcut): the run says the same, not "Connect Slack".
    const id = m.startSync();
    expect(await m.wait(id)).toMatchObject({ status: 'error', error: reason });
  });

  it('describes being offline, a full disk and unexpected failures without codes or stack traces', async () => {
    const cases: [Error, string][] = [
      [
        new SlackHttpError('conversations.history', null, 'network error (ENOTFOUND)'),
        'Can’t reach Slack right now. We’ll try again automatically.',
      ],
      [
        Object.assign(new Error('write failed'), { code: 'ENOSPC' }),
        'Your disk is full, so new messages can’t be saved. Free up space and we’ll continue.',
      ],
      [new TypeError('Cannot read properties of undefined'), 'Something went wrong. Nothing was lost.'],
    ];
    for (const [err, message] of cases) {
      const sync = controllableJob();
      const m = manager({ runApiSync: sync.job as never });
      const id = m.startSync();
      await Promise.resolve();
      sync.release(err);
      await m.wait(id);
      expect(m.status().problem?.message).toBe(message);
    }
  });

  it('shows the wrong-account message as is', async () => {
    const sync = controllableJob();
    const m = manager({ runApiSync: sync.job as never });
    const id = m.startSync();
    await Promise.resolve();
    sync.release(
      new WrongAccountError(
        'This archive belongs to Roman at 9H. To archive a different account, use a different archive folder.',
      ),
    );
    await m.wait(id);
    expect(m.status().problem).toMatchObject({
      kind: 'wrong_account',
      message: expect.stringMatching(/^This archive belongs to Roman at 9H/),
      action: null,
    });
  });

  it('marks runs a crash left behind as interrupted on startup', () => {
    const id = createRun(db, 'sync');
    db.prepare('UPDATE runs SET pid = 999999999 WHERE id = ?').run(id);
    expect(manager({}).init()).toBe(1);
    expect(getRun(db, id)).toMatchObject({ status: 'error', error: 'interrupted' });
  });

  it('warns when the last successful sync is more than 30 days old (PLAN §5.3)', async () => {
    const sync = controllableJob();
    const m = manager({ runApiSync: sync.job as never });
    const id = m.startSync();
    await Promise.resolve();
    sync.release({});
    await m.wait(id);
    now += 31 * 86_400_000;
    expect(m.status().stale).toBe(true);
  });

  it('imports an export folder chosen by the user', async () => {
    const calls: string[] = [];
    const m = manager({
      importSlackExport: async (opts) => {
        calls.push(opts.path);
        return { messagesInserted: 1 };
      },
    });
    const id = m.startImport(dir);
    expect(await m.wait(id)).toMatchObject({ kind: 'import', status: 'ok' });
    expect(calls).toEqual([dir]);
    expect(() => m.startImport(path.join(dir, 'nope'))).toThrow(/no longer exists/);
  });

  it('restores a backup chosen for import (moving from another computer)', async () => {
    const restored: { path: string; tmpDir: string }[] = [];
    const m = manager({
      isArchiveBackup: async () => true,
      restoreBackup: async (opts) => {
        restored.push({ path: opts.path, tmpDir: opts.tmpDir });
        opts.onExcludedConversations?.(['D1']);
        return { messagesInserted: 5 };
      },
      importSlackExport: async () => {
        throw new Error('not a Slack export');
      },
    });
    const id = m.startImport(dir);
    expect(await m.wait(id)).toMatchObject({ kind: 'import', status: 'ok', stats: { messagesInserted: 5 } });
    expect(restored).toEqual([{ path: dir, tmpDir: expect.any(String) }]);
  });
});

describe('classifyFailure', () => {
  it('maps job errors onto the PLAN §8.5 categories', () => {
    expect(classifyFailure(new SlackApiError('x', { error: 'token_revoked' }))).toBe('signed_out');
    expect(classifyFailure(new SlackHttpError('x', 503, 'HTTP 503'))).toBe('offline');
    expect(
      classifyFailure(
        Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND slack.com') }),
      ),
    ).toBe('offline');
    expect(classifyFailure(new Error('SQLITE_FULL: database or disk is full'))).toBe('disk_full');
    expect(classifyFailure(new WrongAccountError('x'))).toBe('wrong_account');
    expect(classifyFailure(new Error('weird'))).toBe('unexpected');
  });
});
