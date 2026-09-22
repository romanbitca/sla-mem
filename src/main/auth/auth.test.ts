import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoginStatusDTO, SlackConnectionDTO } from '../../shared/types';
import { getMeta, openDb, setMeta, upsertUsers, type DB } from '../db';
import { CONNECTION_META_KEY, ConnectionService, SIGN_IN_AGAIN_MESSAGE, SIGNED_OUT_MESSAGE } from './connection';
import { MemoryCredentialStore, SafeStorageCredentialStore, type SecretCipher } from './credentials';
import { ConnectError } from './errors';
import { LoginManager, parseLocalConfig } from './signin';
import { FakeSlackWeb, FakeSurface, localConfig } from './test-helpers';

const API = 'https://slack.test/api';
const XOXC = 'xoxc-1111-2222-3333-session-token-secret';
const COOKIE = 'xoxd-AbCd%2FeFgH%2BiJkL%3D%3D';
const OTHER_XOXC = 'xoxc-9999-8888-7777-other-session';
const OTHER_COOKIE = 'xoxd-ZzZz%2FyYyY%3D';
const SECRETS = [XOXC, COOKIE, decodeURIComponent(COOKIE), OTHER_XOXC, OTHER_COOKIE];
const NINE_H = { teamId: 'T09H', team: '9H', userId: 'U0ROMAN', user: 'roman', url: 'https://9h.slack.com/' };

/** Reversible stand-in for the OS keychain: proves plaintext never reaches the disk. */
const fakeCipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
};

function expectNoSecrets(...values: unknown[]): void {
  const text = values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
  for (const s of SECRETS) expect(text).not.toContain(s);
}

let dir: string;
let db: DB;
let slack: FakeSlackWeb;
let events: string[];

function connection(store = new MemoryCredentialStore(), cleared: string[] = []): ConnectionService {
  const svc = new ConnectionService({
    db,
    store,
    apiBaseUrl: API,
    fetch: slack.fetch,
    now: () => 1_700_000_000_000,
    clearBrowserSession: async () => {
      cleared.push('cleared');
    },
  });
  for (const e of ['connected', 'disconnected', 'changed']) svc.on(e, () => events.push(e));
  return svc;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-auth-'));
  db = openDb(':memory:');
  slack = new FakeSlackWeb(API);
  slack.accounts = [
    { token: XOXC, cookie: COOKIE, ...NINE_H },
    {
      token: OTHER_XOXC,
      cookie: OTHER_COOKIE,
      teamId: 'T0ACME',
      team: 'Acme',
      userId: 'U0ACME',
      user: 'zed',
      url: 'https://acme.slack.com/',
    },
  ];
  events = [];
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SafeStorageCredentialStore', () => {
  it('round-trips credentials and never writes them in plaintext', () => {
    const file = path.join(dir, 'credentials.bin');
    const store = new SafeStorageCredentialStore(file, fakeCipher);
    expect(store.get()).toBeNull();
    const creds = {
      method: 'browser' as const,
      token: XOXC,
      cookie: COOKIE,
      teamId: 'T09H',
      teamName: '9H',
      teamDomain: '9h.slack.com',
      userId: 'U0ROMAN',
      userName: 'roman',
      connectedAt: 1,
    };
    store.set(creds);
    expect(store.get()).toEqual(creds);
    expectNoSecrets(fs.readFileSync(file).toString('latin1'), fs.readFileSync(file).toString('utf8'));
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    store.clear();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses to save when the OS secure storage is unavailable', () => {
    const store = new SafeStorageCredentialStore(path.join(dir, 'c.bin'), {
      ...fakeCipher,
      isEncryptionAvailable: () => false,
    });
    expect(() =>
      store.set({
        method: 'browser',
        token: XOXC,
        cookie: COOKIE,
        teamId: 'T',
        teamName: 'T',
        teamDomain: '',
        userId: 'U',
        userName: 'u',
        connectedAt: 0,
      }),
    ).toThrow(/secure storage/);
  });

  it('treats a file it cannot decrypt (another account or machine) as no credentials', () => {
    const file = path.join(dir, 'c.bin');
    fs.writeFileSync(file, 'garbage');
    expect(new SafeStorageCredentialStore(file, fakeCipher).get()).toBeNull();
  });
});

describe('ConnectionService', () => {
  it('saves a session: validates it, binds the archive, and never exposes secrets', async () => {
    const svc = connection();
    const dto = await svc.saveSession({ method: 'browser', token: XOXC, cookie: COOKIE });
    expect(dto).toMatchObject({
      connected: true,
      method: 'browser',
      teamName: '9H',
      teamDomain: '9h.slack.com',
      userName: 'roman',
      expired: false,
    });
    expect(svc.getCredentials()).toEqual({ token: XOXC, cookie: COOKIE, method: 'browser' });
    expect([getMeta(db, 'team_id'), getMeta(db, 'self_user_id'), getMeta(db, 'team_domain')]).toEqual([
      'T09H',
      'U0ROMAN',
      '9h',
    ]);
    expect(events).toEqual(['connected', 'changed']);
    expectNoSecrets(dto, getMeta(db, CONNECTION_META_KEY));
    // Both credentials went to auth.test: the cookie with the token (PLAN §2.2).
    const call = slack.authTestCalls()[0];
    expect(call.authorization).toBe(`Bearer ${XOXC}`);
    expect(call.cookie).toContain(`d=${COOKIE}`);
  });

  it('refuses a different person or workspace than the archive belongs to (PLAN §5.7)', async () => {
    setMeta(db, 'team_id', 'T09H');
    setMeta(db, 'team_name', '9H');
    setMeta(db, 'self_user_id', 'U0ROMAN');
    upsertUsers(db, [{ id: 'U0ROMAN', name: 'roman', real_name: 'Roman' }]);
    const err = await connection()
      .saveSession({ method: 'browser', token: OTHER_XOXC, cookie: OTHER_COOKIE })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as Error).message).toBe(
      'This archive belongs to Roman at 9H. To archive a different account, use a different archive folder.',
    );
    expect(getMeta(db, CONNECTION_META_KEY)).toBeNull();
  });

  it('reports a rejected session in plain words', async () => {
    const err = await connection()
      .saveSession({ method: 'browser', token: 'xoxc-not-a-real-session', cookie: COOKIE })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: 'Slack didn’t accept this sign-in. Please sign in again.',
      slackCode: 'invalid_auth',
    });
  });

  it('marks the connection expired when Slack signs the user out, and recovers on reconnect', async () => {
    const svc = connection();
    await svc.saveSession({ method: 'browser', token: XOXC, cookie: COOKIE });
    slack.authError = 'invalid_auth';
    expect(await svc.test()).toMatchObject({ connected: true, expired: true, error: SIGNED_OUT_MESSAGE });
    slack.authError = null;
    expect(await svc.test()).toMatchObject({ expired: false, error: null });
    svc.markSignedOut('token_revoked');
    expect(svc.status().expired).toBe(true);
  });

  it('distinguishes "can’t reach Slack" from "signed out"', async () => {
    const svc = connection();
    await svc.saveSession({ method: 'browser', token: XOXC, cookie: COOKIE });
    slack.networkError = 'getaddrinfo ENOTFOUND slack.test';
    const dto = await svc.test();
    expect(dto.expired).toBe(false);
    expect(dto.error).toMatch(/Can’t reach Slack/);
  });

  it('a saved sign-in this app can’t unlock asks for Reconnect instead of letting syncs fail silently', async () => {
    // Connected, then the app was renamed (or the folder copied to another computer): the archive
    // still records the connection, but the Keychain key that locked the sign-in isn't there.
    await connection().saveSession({ method: 'browser', token: XOXC, cookie: COOKIE });
    events = [];
    const svc = connection(new MemoryCredentialStore());
    expect(svc.status()).toMatchObject({ connected: true, expired: false });

    svc.checkSavedSignIn(); // at start-up
    expect(svc.status()).toMatchObject({ connected: true, expired: true, error: SIGN_IN_AGAIN_MESSAGE });
    expect(events).toEqual(['changed']);
    expect(svc.getCredentials()).toBeNull();
    svc.checkSavedSignIn();
    expect(await svc.test()).toMatchObject({ expired: true, error: SIGN_IN_AGAIN_MESSAGE });

    // Reconnecting saves a sign-in this app can read, and the problem is gone.
    expect(await svc.saveSession({ method: 'browser', token: XOXC, cookie: COOKIE })).toMatchObject({
      connected: true,
      expired: false,
    });
    expect(svc.getCredentials()).toMatchObject({ token: XOXC });
  });

  it('disconnect removes credentials and the sign-in session; the archive stays', async () => {
    const cleared: string[] = [];
    const store = new MemoryCredentialStore();
    const svc = connection(store, cleared);
    await svc.saveSession({ method: 'browser', token: XOXC, cookie: COOKIE });
    const dto = await svc.disconnect();
    expect(dto.connected).toBe(false);
    expect(store.get()).toBeNull();
    expect(svc.getCredentials()).toBeNull();
    expect(cleared).toEqual(['cleared']);
    expect(getMeta(db, 'team_id')).toBe('T09H'); // archive identity kept
    expect(events).toContain('disconnected');
  });

  it('connects with a pasted cookie by deriving the session token (PLAN §2.4 fallback)', async () => {
    const svc = connection();
    const dto = await svc.connectWithCookie({ workspace: '9h', cookie: decodeURIComponent(COOKIE) });
    expect(dto).toMatchObject({ connected: true, method: 'cookie', teamName: '9H' });
    expect(svc.getCredentials()).toMatchObject({ token: XOXC, cookie: COOKIE });
  });
});

describe('parseLocalConfig', () => {
  it('reads every signed-in workspace with a web session token', () => {
    const raw = JSON.stringify({
      teams: {
        T09H: { id: 'T09H', name: '9H', domain: '9h', token: XOXC },
        T0ACME: { id: 'T0ACME', name: 'Acme', domain: 'acme', token: 'xoxc-2' },
        T0OLD: { id: 'T0OLD', name: 'Old', domain: 'old', token: '' },
      },
    });
    expect(parseLocalConfig(raw)).toEqual([
      { id: 'T09H', name: '9H', domain: '9h.slack.com', token: XOXC },
      { id: 'T0ACME', name: 'Acme', domain: 'acme.slack.com', token: 'xoxc-2' },
    ]);
    expect(parseLocalConfig('not json')).toEqual([]);
    expect(parseLocalConfig(null)).toEqual([]);
  });
});

describe('LoginManager', () => {
  interface Harness {
    manager: LoginManager;
    surface: FakeSurface;
    statuses: LoginStatusDTO[];
    connected: SlackConnectionDTO[];
    tick: (ms?: number) => Promise<void>;
  }

  /** Drives the poll loop with a manual clock: each tick advances time and runs one poll. */
  function harness(svc = connection()): Harness {
    const surface = new FakeSurface();
    const statuses: LoginStatusDTO[] = [];
    const connected: SlackConnectionDTO[] = [];
    let now = 0;
    let wake: (() => void) | null = null;
    const manager = new LoginManager({
      connection: svc,
      createSurface: () => surface,
      fetch: slack.fetch,
      pollMs: 1000,
      nudgeAfterMs: 3000,
      deriveAfterMs: 6000,
      timeoutMs: 60_000,
      now: () => now,
      sleep: () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      onStatus: (s) => statuses.push(s),
      onConnected: (c) => connected.push(c),
    });
    const tick = async (ms = 1000) => {
      now += ms;
      const w = wake;
      wake = null;
      w?.();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { manager, surface, statuses, connected, tick };
  }

  it('opens Slack’s sign-in page and waits for the user', () => {
    const h = harness();
    expect(h.manager.start({}).state).toBe('waiting');
    expect(h.surface.opened).toEqual(['https://app.slack.com/signin']);
    expect(() => h.manager.start({})).toThrow(/already open/);
  });

  it('captures the session from the web client, verifies it and closes the window', async () => {
    const h = harness();
    h.manager.start({});
    await h.tick();
    expect(h.manager.status().state).toBe('waiting');
    h.surface.cookie = COOKIE;
    h.surface.url = 'https://app.slack.com/client/T09H';
    h.surface.localConfig = localConfig([{ id: 'T09H', name: '9H', domain: '9h', token: XOXC }]);
    await h.tick();
    const status = h.manager.status();
    expect(status).toMatchObject({ state: 'connected', message: 'Connected to 9H as roman.', error: null });
    expect(status.connection).toMatchObject({ teamName: '9H' });
    expect(h.surface.closed).toBe(true);
    expect(h.connected).toHaveLength(1);
    expectNoSecrets(h.statuses);
  });

  it('asks which workspace to archive when signed in to several', async () => {
    const h = harness();
    h.manager.start({});
    h.surface.cookie = COOKIE;
    h.surface.url = 'https://app.slack.com/client/T09H';
    h.surface.localConfig = localConfig([
      { id: 'T09H', name: '9H', domain: '9h', token: XOXC },
      { id: 'T0ACME', name: 'Acme', domain: 'acme', token: OTHER_XOXC },
    ]);
    await h.tick();
    expect(h.manager.status()).toMatchObject({
      state: 'choose_team',
      teams: [
        { id: 'T09H', name: '9H', domain: '9h.slack.com' },
        { id: 'T0ACME', name: 'Acme', domain: 'acme.slack.com' },
      ],
    });
    h.manager.choose('T09H');
    await h.tick(0);
    expect(h.manager.status().state).toBe('connected');
  });

  it('treats closing the window as cancelled, not an error', async () => {
    const h = harness();
    h.manager.start({});
    h.surface.userCloses();
    expect(h.manager.status()).toMatchObject({ state: 'cancelled', error: null });
    expect(h.manager.start({}).state).toBe('waiting'); // and can start again
  });

  it('gives up after the timeout', async () => {
    const h = harness();
    h.manager.start({});
    await h.tick(61_000);
    expect(h.manager.status()).toMatchObject({ state: 'error', error: 'Signing in took too long. Please try again.' });
    expect(h.surface.closed).toBe(true);
  });

  it('nudges a finished sign-in to the web client, then derives the token from the cookie', async () => {
    const h = harness();
    h.manager.start({});
    h.surface.cookie = COOKIE;
    h.surface.url = 'https://9h.slack.com/ssb/redirect';
    h.surface.hosts = ['9h.slack.com'];
    await h.tick(); // cookie first seen
    await h.tick(3000); // nudge
    expect(h.surface.navigations).toEqual(['https://app.slack.com/client/']);
    h.surface.url = 'https://app.slack.com/client/'; // …but the web client never wrote its config
    await h.tick(3000); // derive over HTTP from the cookie
    expect(h.manager.status().state).toBe('connected');
  });

  it('ignores a stale session left in the window and waits for a fresh sign-in', async () => {
    const h = harness();
    h.manager.start({});
    h.surface.cookie = 'xoxd-stale%2Fcookie';
    h.surface.url = 'https://app.slack.com/client/T09H';
    h.surface.localConfig = localConfig([{ id: 'T09H', name: '9H', domain: '9h', token: 'xoxc-stale-token' }]);
    await h.tick();
    expect(h.manager.status()).toMatchObject({ state: 'waiting', message: expect.stringMatching(/sign in again/) });
    h.surface.cookie = COOKIE;
    h.surface.localConfig = localConfig([{ id: 'T09H', name: '9H', domain: '9h', token: XOXC }]);
    await h.tick();
    expect(h.manager.status().state).toBe('connected');
  });

  it('stops with a plain message when the account doesn’t match the archive', async () => {
    setMeta(db, 'team_id', 'T0ACME');
    setMeta(db, 'team_name', 'Acme');
    const h = harness();
    h.manager.start({});
    h.surface.cookie = COOKIE;
    h.surface.url = 'https://app.slack.com/client/T09H';
    h.surface.localConfig = localConfig([{ id: 'T09H', name: '9H', domain: '9h', token: XOXC }]);
    await h.tick();
    expect(h.manager.status()).toMatchObject({
      state: 'error',
      error: expect.stringMatching(/This archive belongs to .* at Acme/),
    });
    expect(h.surface.closed).toBe(true);
  });

  it('can be cancelled', () => {
    const h = harness();
    h.manager.start({});
    expect(h.manager.cancel()).toMatchObject({ state: 'cancelled' });
    expect(h.surface.closed).toBe(true);
  });
});
