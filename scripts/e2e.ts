/**
 * End-to-end run of the real app against the mock Slack (PLAN §11 Stages 2–3, automated where
 * possible; the real-workspace sign-in stays a manual check):
 *
 *   1. start the mock Slack and the built app with a fresh archive folder;
 *   2. onboarding through the app's own screens: Connect Slack opens the Slack window, we click
 *      "Sign in with email" there, the app captures the session, verifies it and starts the
 *      first sync;
 *   3. the first sync finishes and the archive has messages and files; the UI shows the home
 *      page, a channel, a thread, and search results that click through to the message;
 *   4. secrets: the saved session is encrypted and no log line contains a token or cookie;
 *   5. restart the app: still connected (persistent session + stored credentials), a second
 *      sync adds nothing; with the window closed the app keeps running and syncing;
 *   6. disconnect clears the credentials and the Slack session; connecting again works;
 *   7. a conversation exports to Markdown with every message; a backup imported on a fresh
 *      archive (a new computer) brings every message and attachment;
 *   8. killed mid-sync (SIGKILL): committed messages survive and the next sync completes;
 *   9. quitting right after a sync exits promptly.
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-mem-e2e-'));
const shots = path.join(ROOT, '.e2e-data', 'shots');
fs.mkdirSync(shots, { recursive: true });

let step = 0;
function log(message: string): void {
  console.log(`[e2e ${String(++step).padStart(2, '0')}] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function launch(mock: MockSlack, folder = dataDir): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: {
      ...process.env,
      SLA_MEM_DATA_DIR: folder,
      SLA_MEM_SLACK_API: mock.apiBaseUrl,
      SLA_MEM_SLACK_WEB: mock.url,
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

/** First run through the real onboarding screens: Welcome → Connect Slack → Getting your history. */
async function onboardThroughUi(app: ElectronApplication, page: Page): Promise<void> {
  await page.getByRole('heading', { name: 'Welcome to sla-mem' }).waitFor();
  await page.screenshot({ path: path.join(shots, 'onboarding-welcome.png') });
  await page.getByRole('button', { name: 'Get started' }).click();
  await page.getByRole('heading', { name: 'Connect Slack' }).waitFor();
  const windowPromise = app.waitForEvent('window');
  await page.getByRole('button', { name: 'Connect Slack' }).click();
  const slackWindow = await windowPromise;
  await slackWindow.waitForLoadState('domcontentloaded');
  await slackWindow.click('#signin');
  // The app captures the session, closes the Slack window and asks what to archive; nothing is
  // fetched before "Start archiving".
  await page.getByRole('heading', { name: 'What to archive' }).waitFor({ timeout: 60_000 });
  await page.getByText('Connected to Brightwave').waitFor();
  await page
    .getByRole('checkbox', { name: /general/ })
    .first()
    .waitFor();
  await page.screenshot({ path: path.join(shots, 'onboarding-what-to-archive.png') });
  await page.getByRole('button', { name: 'Start archiving' }).click();
  await page.getByRole('heading', { name: 'Getting your history' }).waitFor();
  log('Onboarding: connected through the app’s own screens, then chose what to archive');
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

    await onboardThroughUi(app, page);
    const first = await waitForSync(page);
    await page.screenshot({ path: path.join(shots, 'onboarding-first-sync.png') });
    await page.getByRole('button', { name: 'Finish' }).click();
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

    // The archive through the UI: home, a channel, search with click-through, a thread.
    await page.getByRole('heading', { name: 'Brightwave archive' }).waitFor();
    await page.screenshot({ path: path.join(shots, 'home.png') });
    await page.getByRole('navigation', { name: 'Conversations' }).getByText('engineering', { exact: true }).click();
    await page.getByRole('heading', { name: '#engineering' }).waitFor();
    await page.locator('[data-msg-ts]').first().waitFor();
    await page.screenshot({ path: path.join(shots, 'conversation.png') });
    const threadButton = page.getByRole('button', { name: /^View thread, \d+ repl/ }).last();
    await threadButton.click();
    const panel = page.getByRole('complementary', { name: 'Thread' });
    await panel.locator('[data-msg-ts]').first().waitFor();
    await page.screenshot({ path: path.join(shots, 'thread.png') });
    await panel.getByRole('button', { name: 'Close thread' }).click();

    await page
      .getByRole('navigation', { name: 'Archive' })
      .getByRole('link', { name: /^Search/ })
      .click();
    const box = page.getByRole('combobox', { name: 'Search messages' });
    await box.fill('deploy');
    await box.press('Enter');
    const results = page.getByRole('list', { name: 'Search results' });
    const firstHit = results.getByRole('link').first();
    await firstHit.waitFor();
    const hitCount = await results.getByRole('link').count();
    await page.screenshot({ path: path.join(shots, 'search.png') });
    await firstHit.click();
    await page.locator('[data-highlighted="true"]').first().waitFor();
    // A wide window opens the result next to the list; from there, the whole conversation.
    const preview = page.getByRole('region', { name: 'Search result preview' });
    if (await preview.count()) {
      await page.screenshot({ path: path.join(shots, 'search-preview.png') });
      await preview.getByRole('button', { name: 'Open conversation' }).click();
    }
    const back = page.getByRole('button', { name: 'Search results' });
    await back.waitFor();
    assert(page.url().includes('#/c/'), 'a search result opens its conversation');
    await page.screenshot({ path: path.join(shots, 'search-click-through.png') });
    await back.click();
    await results.getByRole('link').first().waitFor();
    assert(page.url().includes('#/search') && page.url().includes('q=deploy'), '"Search results" goes back');
    log(`UI: home, #engineering, a thread, and search (${hitCount} hits on the first page): opened and back`);

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

    // Closing the window keeps the app, and syncing, alive in the tray (PLAN §8.3, Stage 6).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close()));
    const visibleWindows = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
    );
    assert(visibleWindows === 0 && !app.process().killed, 'closing the window hides it; the app keeps running');
    await fetch(`${mock.url}/_mock/mutate`, { method: 'POST' }); // an edit, a late thread reply, a new DM
    await call(page, 'startSync');
    const hidden = (await waitForSync(page)) as Record<string, number>;
    assert(hidden.messagesInserted >= 1 && hidden.revisions >= 1, `a sync with the window closed archives changes`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    log(`Window closed: the app kept running and a sync archived ${hidden.messagesInserted} new message(s)`);

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

    // Export a conversation (the test answers the save dialog; nothing opens in Finder).
    const exportFile = path.join(dataDir, 'exported', 'general.md');
    fs.mkdirSync(path.dirname(exportFile), { recursive: true });
    await app.evaluate(({ dialog, shell }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
      shell.showItemInFolder = () => undefined;
    }, exportFile);
    const conversations = await call<{ id: string; label: string; messageCount: number }[]>(page, 'getConversations');
    const general = conversations.find((c) => c.label === 'general');
    assert(general, 'the mock workspace has #general');
    const exported = await call<{ messages: number }>(page, 'exportConversation', { conversationId: general.id });
    const markdown = fs.readFileSync(exportFile, 'utf8');
    assert(
      exported.messages === general.messageCount && markdown.startsWith('# #general'),
      `export writes every message (${exported.messages} of ${general.messageCount})`,
    );
    log(`Exported #general: ${exported.messages} messages, ${Math.round(markdown.length / 1024)} KB of Markdown`);

    // Moving to another computer: back up here, import on a fresh archive, everything arrives.
    const usb = path.join(dataDir, 'usb-stick');
    fs.mkdirSync(usb, { recursive: true });
    await app.evaluate(({ dialog, shell }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
      shell.showItemInFolder = () => undefined;
    }, usb);
    const backup = await call<{ path: string }>(page, 'backupNow');
    const here = await call<{ messageCount: number; filesDownloaded: number }>(page, 'getStats');
    const newComputer = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-mem-e2e-new-'));
    try {
      const other = await launch(mock, newComputer);
      try {
        await other.app.evaluate(({ dialog }, file) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [file],
          })) as typeof dialog.showOpenDialog;
        }, backup.path);
        const started = await call<{ runId: number }>(other.page, 'importBackup');
        await waitFor('the backup import to finish', async () => {
          const s = await call<{ recentRuns: { id: number; status: string; error: string | null }[] }>(
            other.page,
            'getSyncStatus',
          );
          const run = s.recentRuns.find((r) => r.id === started.runId);
          if (run && run.status !== 'running' && run.status !== 'ok')
            throw new Error(`import ${run.status}: ${run.error}`);
          return run?.status === 'ok';
        });
        const there = await call<{ messageCount: number; filesDownloaded: number }>(other.page, 'getStats');
        assert(
          there.messageCount === here.messageCount && there.filesDownloaded === here.filesDownloaded,
          `the new computer has everything (${there.messageCount} of ${here.messageCount} messages, ` +
            `${there.filesDownloaded} of ${here.filesDownloaded} attachments)`,
        );
        log(
          `Moved to a new computer: ${there.messageCount} messages and ${there.filesDownloaded} attachments imported`,
        );
      } finally {
        await quit(other.app);
      }
    } finally {
      fs.rmSync(newComputer, { recursive: true, force: true });
    }

    // Killed mid-sync: nothing committed is lost and the next run picks up the rest (Stage 3).
    const full = (await call<{ messageCount: number }>(page, 'getStats')).messageCount;
    await quit(app);
    app = null;
    // Start over from an empty archive (the connection stays): the next sync is a first sync.
    const db = openDb(path.join(dataDir, 'archive.db'));
    // Messages this close to the Free plan's 90-day edge may age out before the next sync.
    const edge = Math.floor(Date.now() / 1000) - 90 * 86_400 + 3_600;
    const nearEdge = (db.prepare('SELECT count(*) AS n FROM messages WHERE time < ?').get(edge) as { n: number }).n;
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
    assert(
      resumed <= full && resumed >= full - nearEdge,
      `the next sync completes the archive (${resumed} of ${full}, ${nearEdge} near the 90-day edge)`,
    );
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
