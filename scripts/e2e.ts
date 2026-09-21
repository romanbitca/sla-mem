/**
 * End-to-end run of the real app against the mock Slack (PLAN §11 Stages 2–3, automated where
 * possible; the real-workspace sign-in stays a manual check):
 *
 *   1. start the mock Slack and the built app with a fresh archive folder;
 *   2. connect: the app opens its Slack window, we click "Sign in with email" there, the app
 *      captures the session, verifies it and starts the first sync;
 *   3. the first sync finishes and the archive has messages and files;
 *   4. secrets: the saved session is encrypted and no log line contains a token or cookie;
 *   5. restart the app: still connected (persistent session + stored credentials), a second
 *      sync adds nothing;
 *   6. disconnect clears the credentials and the Slack session; connecting again works.
 *
 * Usage: npm run build && npm run e2e   (screenshots go to .e2e-data/shots)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { openDb } from '../src/main/db';
import type { ArchiveBridge } from '../src/shared/ipc';
import { startMockSlack, type MockSlack } from '../test/mock-slack/server';

// Evaluated inside the app's page, where the preload exposes the bridge.
declare const window: { archive: ArchiveBridge };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-archive-e2e-'));
const shots = path.join(ROOT, '.e2e-data', 'shots');
fs.mkdirSync(shots, { recursive: true });

let step = 0;
function log(message: string): void {
  console.log(`[e2e ${String(++step).padStart(2, '0')}] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function launch(mock: MockSlack): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: {
      ...process.env,
      SLACK_ARCHIVE_DATA_DIR: dataDir,
      SLACK_ARCHIVE_SLACK_API: mock.apiBaseUrl,
      SLACK_ARCHIVE_SLACK_WEB: mock.url,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** Quits like the user would. It must exit promptly: a quit that hangs is a bug (e.g. a dialog). */
async function quit(app: ElectronApplication): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), 20_000);
  });
  const result = await Promise.race([app.close().then(() => 'closed' as const), timedOut]);
  clearTimeout(timer);
  if (result === 'timeout') {
    app.process().kill('SIGKILL');
    throw new Error('The app did not quit within 20 s');
  }
}

/** Calls the app's IPC bridge from its own page, like the UI does. */
async function call<T>(page: Page, method: string, arg?: unknown): Promise<T> {
  const result = await page.evaluate(
    ([m, a]) => {
      const bridge = window.archive as unknown as { call(method: string, arg?: unknown): Promise<unknown> };
      return a === undefined ? bridge.call(m) : bridge.call(m, a);
    },
    [method, arg] as const,
  );
  const r = result as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!r.ok) throw new Error(`${method} failed: ${r.error?.code} ${r.error?.message}`);
  return r.value as T;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function signIn(app: ElectronApplication, page: Page): Promise<void> {
  const windowPromise = app.waitForEvent('window');
  const started = await call<{ state: string }>(page, 'startLogin', {});
  assert(started.state === 'waiting', `sign-in starts waiting (got ${started.state})`);
  const slackWindow = await windowPromise;
  await slackWindow.waitForLoadState('domcontentloaded');
  await slackWindow.screenshot({ path: path.join(shots, `signin-${step}.png`) });
  await slackWindow.click('#signin');
  const status = await waitFor('the sign-in to complete', async () => {
    const s = await call<{ state: string; error: string | null; message: string }>(page, 'getLoginStatus');
    if (s.state === 'error' || s.state === 'cancelled')
      throw new Error(`sign-in ended: ${s.state} ${s.error ?? s.message}`);
    return s.state === 'connected' ? s : null;
  });
  log(`Signed in: ${status.message}`);
}

async function waitForSync(page: Page): Promise<Record<string, unknown>> {
  return waitFor(
    'the sync to finish',
    async () => {
      const s = await call<{
        running: boolean;
        recentRuns: { status: string; kind: string; stats: Record<string, number>; error: string | null }[];
      }>(page, 'getSyncStatus');
      const last = s.recentRuns[0];
      if (s.running || !last) return null;
      if (last.status !== 'ok') throw new Error(`sync ended with ${last.status}: ${last.error}`);
      return last.stats;
    },
    180_000,
  );
}

async function main(): Promise<void> {
  const mock = await startMockSlack({ messages: 2_000 });
  log(`Mock Slack at ${mock.url}; archive folder ${dataDir}`);
  let app: ElectronApplication | null = null;
  try {
    let page: Page;
    ({ app, page } = await launch(mock));
    const before = await call<{ connection: { connected: boolean } }>(page, 'getSettings');
    assert(!before.connection.connected, 'starts disconnected');

    await signIn(app, page);
    const first = await waitForSync(page);
    const stats = await call<{ messageCount: number; filesDownloaded: number; conversationCount: number }>(
      page,
      'getStats',
    );
    log(`First sync: ${JSON.stringify(first)}`);
    assert(stats.messageCount > 200, `archive has messages (${stats.messageCount})`);
    assert(stats.filesDownloaded > 0, `attachments downloaded (${stats.filesDownloaded})`);
    log(
      `Archive: ${stats.messageCount} messages in ${stats.conversationCount} conversations, ${stats.filesDownloaded} files`,
    );

    const creds = fs.readFileSync(path.join(dataDir, 'credentials.bin'));
    assert(
      !creds.includes(mock.session.token) && !creds.includes(mock.session.cookie),
      'credentials are encrypted at rest',
    );
    log('Credentials file is encrypted (no token or cookie in it)');

    await page.screenshot({ path: path.join(shots, 'after-first-sync.png') });
    await quit(app);
    app = null;

    ({ app, page } = await launch(mock));
    const tested = await call<{ connected: boolean; expired: boolean; teamName: string }>(page, 'testConnection');
    assert(tested.connected && !tested.expired, 'still connected after a restart');
    log(`Restarted: still connected to ${tested.teamName}`);
    await call(page, 'startSync');
    const second = (await waitForSync(page)) as Record<string, number>;
    assert(second.messagesInserted === 0, `second sync adds nothing (${second.messagesInserted})`);
    log(`Second sync: ${JSON.stringify(second)}`);

    const disconnected = await call<{ connected: boolean }>(page, 'disconnect');
    assert(
      !disconnected.connected && !fs.existsSync(path.join(dataDir, 'credentials.bin')),
      'disconnect removes credentials',
    );
    const statsAfter = await call<{ messageCount: number }>(page, 'getStats');
    assert(statsAfter.messageCount >= stats.messageCount, 'archive kept');
    log('Disconnected: credentials removed, archive kept');

    await signIn(app, page);
    await waitForSync(page);
    log('Reconnected and synced again');

    // Killed mid-sync: nothing committed is lost and the next run picks up the rest (Stage 3).
    const full = (await call<{ messageCount: number }>(page, 'getStats')).messageCount;
    await quit(app);
    app = null;
    // Start over from an empty archive (the connection stays): the next sync is a first sync.
    const db = openDb(path.join(dataDir, 'archive.db'));
    db.exec('DELETE FROM message_files; DELETE FROM files; DELETE FROM messages; DELETE FROM sync_state;');
    db.close();
    ({ app, page } = await launch(mock));
    mock.setDelay(120);
    await call(page, 'startSync');
    const partial = await waitFor('some messages to be committed', async () => {
      const n = (await call<{ messageCount: number }>(page, 'getStats')).messageCount;
      return n > 50 && n < full ? n : null;
    });
    app.process().kill('SIGKILL');
    app = null;
    mock.setDelay(0);
    ({ app, page } = await launch(mock));
    const afterCrash = (await call<{ messageCount: number }>(page, 'getStats')).messageCount;
    const status = await call<{ recentRuns: { status: string; error: string | null }[] }>(page, 'getSyncStatus');
    assert(afterCrash >= partial, `committed messages survive a crash (${afterCrash} >= ${partial})`);
    assert(
      status.recentRuns[0]?.status === 'error' && status.recentRuns[0]?.error === 'interrupted',
      'the killed run is marked interrupted',
    );
    await call(page, 'startSync');
    await waitForSync(page);
    const resumed = (await call<{ messageCount: number }>(page, 'getStats')).messageCount;
    assert(resumed === full, `the next sync completes the archive (${resumed} of ${full})`);
    log(`Killed mid-sync at ${partial} messages; kept ${afterCrash}; the next sync completed all ${resumed}`);
    // Quitting right as a run finishes must not leave anything reading the closed database.
    await call(page, 'startSync');
    await waitForSync(page);
    await quit(app);
    app = null;
    log('Quit right after a sync: the app exited promptly');

    const logs = fs
      .readdirSync(path.join(dataDir, 'logs'))
      .map((f) => fs.readFileSync(path.join(dataDir, 'logs', f), 'utf8'))
      .join('\n');
    assert(!/xox[cd]-(?!\[redacted\])[A-Za-z0-9]/.test(logs), 'no token or cookie in the logs');
    assert(!logs.includes(mock.session.cookie) && !logs.includes(mock.session.token), 'no session values in the logs');
    log('Logs contain no tokens or cookies');
    console.log('\nE2E passed');
  } finally {
    if (app) await quit(app).catch(() => undefined);
    await mock.close();
    if (!process.env.KEEP_E2E_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
