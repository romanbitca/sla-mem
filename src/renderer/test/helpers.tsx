/**
 * Shared fixtures and render helpers for the renderer's jsdom tests.
 * (Not a test file itself: vitest only picks up *.test.ts(x).)
 *
 * Components talk to main only through `api` (lib/api.ts); tests `vi.spyOn(api, '…')`. For the
 * pushed events and the envelope layer underneath, `installFakeBridge` provides a scriptable
 * `window.archive`.
 */
import type { ReactElement, ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, type Location } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, type Mock } from 'vitest';
import type { ArchiveBridge, ArchiveEvent, ArchiveEvents } from '../../shared/ipc';
import type {
  AppInfoDTO,
  AttachmentDTO,
  ConversationDTO,
  FileDTO,
  LoginStatusDTO,
  MessageDTO,
  MessagesPage,
  PreferencesDTO,
  SettingsDTO,
  SlackConnectionDTO,
  StatsDTO,
  StorageDTO,
  SyncRunDTO,
  SyncStatusDTO,
  UpdateInfoDTO,
  UserDTO,
  WorkspaceDTO,
} from '../../shared/types';
import { buildDirectory, StaticDirectoryProvider, type Directory } from '../lib/directory';
import { compareTs } from '../lib/ts';

export function makeUser(id: string, label: string, extra: Partial<UserDTO> = {}): UserDTO {
  return {
    id,
    name: label.toLowerCase(),
    realName: label,
    displayName: label,
    label,
    avatarUrl: null,
    isBot: false,
    deleted: false,
    ...extra,
  };
}

export function makeConversation(id: string, label: string, extra: Partial<ConversationDTO> = {}): ConversationDTO {
  return {
    id,
    type: 'channel',
    label,
    rawName: label,
    dmUserId: null,
    memberIds: [],
    isArchived: false,
    topic: null,
    purpose: null,
    messageCount: 0,
    latestTs: null,
    oldestTs: null,
    syncError: null,
    ...extra,
  };
}

export function makeMessage(overrides: Partial<MessageDTO> & { ts: string }): MessageDTO {
  return {
    conversationId: 'C1',
    threadTs: null,
    isReply: false,
    userId: 'U1',
    botId: null,
    username: null,
    botIconUrl: null,
    subtype: null,
    text: `message ${overrides.ts}`,
    blocks: [],
    replyCount: 0,
    latestReply: null,
    replyUsers: [],
    editedTs: null,
    isDeleted: false,
    revisionCount: 0,
    reactions: [],
    files: [],
    attachments: [],
    ...overrides,
  };
}

/** A downloaded, non-inline file (a document): no `url`, opened with the system app. */
export function makeFile(overrides: Partial<FileDTO> & { id: string }): FileDTO {
  return {
    name: `${overrides.id}.bin`,
    title: null,
    mimetype: 'application/octet-stream',
    filetype: 'binary',
    size: 1024,
    isImage: false,
    width: null,
    height: null,
    available: true,
    url: null,
    thumbUrl: null,
    permalink: null,
    status: 'done',
    statusReason: null,
    ...overrides,
  };
}

/** A downloaded raster image, served inline over archive://. */
export function makeImage(overrides: Partial<FileDTO> & { id: string }): FileDTO {
  return makeFile({
    name: `${overrides.id}.png`,
    mimetype: 'image/png',
    filetype: 'png',
    isImage: true,
    url: `archive://file/${overrides.id}`,
    thumbUrl: `archive://thumb/${overrides.id}`,
    ...overrides,
  });
}

export function makeAttachment(overrides: Partial<AttachmentDTO> = {}): AttachmentDTO {
  return {
    color: null,
    pretext: null,
    authorName: null,
    authorLink: null,
    authorIcon: null,
    title: null,
    titleLink: null,
    text: null,
    fallback: null,
    imageUrl: null,
    thumbUrl: null,
    serviceName: null,
    serviceIcon: null,
    footer: null,
    fields: [],
    fromUrl: null,
    isMsgUnfurl: false,
    blocks: [],
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<WorkspaceDTO> = {}): WorkspaceDTO {
  return {
    teamId: 'T9H',
    teamName: '9H',
    teamDomain: '9h',
    selfUserId: 'U1',
    connected: true,
    ...overrides,
  };
}

export const NOT_CONNECTED: SlackConnectionDTO = {
  connected: false,
  method: null,
  teamId: null,
  teamName: null,
  teamDomain: null,
  userId: null,
  userName: null,
  connectedAt: null,
  lastCheckedAt: null,
  expired: false,
  error: null,
};

/** A working sign-in to the "9H" workspace. */
export function makeConnection(overrides: Partial<SlackConnectionDTO> = {}): SlackConnectionDTO {
  return {
    connected: true,
    method: 'browser',
    teamId: 'T9H',
    teamName: '9H',
    teamDomain: '9h.slack.com',
    userId: 'U1',
    userName: 'roman',
    connectedAt: Date.now() - 5 * 60_000,
    lastCheckedAt: Date.now() - 5 * 60_000,
    expired: false,
    error: null,
    ...overrides,
  };
}

export function makePreferences(overrides: Partial<PreferencesDTO> = {}): PreferencesDTO {
  return {
    syncIntervalMinutes: 60,
    attachmentPolicy: 'standard',
    overlapDays: 7,
    launchAtLogin: true,
    theme: 'system',
    onboardingComplete: true,
    showTrayIcon: true,
    excludedConversationIds: [],
    ...overrides,
  };
}

export function makeSettings(
  overrides: { connection?: SlackConnectionDTO; preferences?: Partial<PreferencesDTO> } = {},
): SettingsDTO {
  return {
    connection: overrides.connection ?? makeConnection(),
    preferences: makePreferences(overrides.preferences),
  };
}

export function makeLoginStatus(overrides: Partial<LoginStatusDTO> = {}): LoginStatusDTO {
  return {
    state: 'idle',
    message: '',
    startedAt: null,
    error: null,
    teams: [],
    connection: null,
    ...overrides,
  };
}

export function makeRun(overrides: Partial<SyncRunDTO> & { id: number }): SyncRunDTO {
  return {
    kind: 'sync',
    status: 'ok',
    startedAt: Date.now() - 60 * 60_000,
    finishedAt: Date.now() - 58 * 60_000,
    stats: {},
    error: null,
    ...overrides,
  };
}

export function makeSyncStatus(overrides: Partial<SyncStatusDTO> = {}): SyncStatusDTO {
  const finished = Date.now() - 58 * 60_000;
  return {
    running: false,
    currentRun: null,
    progress: null,
    log: [],
    recentRuns: [makeRun({ id: 1, finishedAt: finished })],
    intervalMinutes: 60,
    nextRunAt: Date.now() + 2 * 60_000,
    lastSuccessAt: finished,
    blockedReason: null,
    problem: null,
    stale: false,
    ...overrides,
  };
}

const MB = 1024 * 1024;

export function makeStats(overrides: Partial<StatsDTO> = {}): StatsDTO {
  return {
    messageCount: 48_213,
    conversationCount: 37,
    userCount: 42,
    fileCount: 1200,
    filesDownloaded: 1020,
    filesBytes: 880 * MB,
    dbBytes: 340 * MB,
    oldestTs: '1709500000.000100',
    newestTs: `${Math.floor(Date.now() / 1000)}.000100`,
    beyondFreeWindowCount: 31_337,
    ...overrides,
  };
}

export function makeStorage(overrides: Partial<StorageDTO> = {}): StorageDTO {
  return {
    dataDir: '/Users/me/Library/Application Support/sla-mem',
    databaseBytes: 340 * MB,
    attachmentsBytes: 880 * MB,
    logsBytes: 2 * MB,
    totalBytes: 1222 * MB,
    filesDownloaded: 1020,
    diskFreeBytes: 200 * 1024 * MB,
    warning: null,
    ...overrides,
  };
}

export function makeAppInfo(overrides: Partial<AppInfoDTO> = {}): AppInfoDTO {
  return {
    version: '1.2.0',
    platform: 'darwin',
    arch: 'arm64',
    isPackaged: true,
    dataDir: '/Users/me/Library/Application Support/sla-mem',
    logsDir: '/Users/me/Library/Application Support/sla-mem/logs',
    installedProperly: true,
    ...overrides,
  };
}

export function makeUpdateInfo(overrides: Partial<UpdateInfoDTO> = {}): UpdateInfoDTO {
  return {
    currentVersion: '1.2.0',
    latestVersion: '1.2.0',
    available: false,
    notes: null,
    releaseUrl: null,
    downloadUrl: null,
    checkedAt: Date.now(),
    error: null,
    ...overrides,
  };
}

/** Slack-like ts for message #i, 10 minutes apart. */
export function tsAt(i: number, base = 1_700_000_000): string {
  return `${base + i * 600}.000100`;
}

/**
 * In-memory implementation of main's getMessages paging (before/after exclusive, around
 * centered and inclusive, exact hasMore flags).
 */
export function fakeMessagesEndpoint(all: MessageDTO[]) {
  const sorted = [...all].sort((a, b) => compareTs(a.ts, b.ts));
  return (query: { before?: string; after?: string; around?: string; limit?: number }): MessagesPage => {
    const limit = query.limit ?? 50;
    const n = sorted.length;
    let start: number;
    let end: number;
    if (query.before) {
      end = sorted.findIndex((m) => compareTs(m.ts, query.before!) >= 0);
      if (end < 0) end = n;
      start = Math.max(0, end - limit);
    } else if (query.after) {
      start = sorted.findIndex((m) => compareTs(m.ts, query.after!) > 0);
      if (start < 0) start = n;
      end = Math.min(n, start + limit);
    } else if (query.around) {
      let idx = sorted.findIndex((m) => compareTs(m.ts, query.around!) >= 0);
      if (idx < 0) idx = n - 1;
      start = Math.max(0, idx - Math.floor(limit / 2));
      end = Math.min(n, start + limit);
      start = Math.max(0, end - limit);
    } else {
      end = n;
      start = Math.max(0, n - limit);
    }
    return { messages: sorted.slice(start, end), hasMoreBefore: start > 0, hasMoreAfter: end < n };
  };
}

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

export const testUsers = [
  makeUser('U1', 'Alice'),
  makeUser('U2', 'Bob'),
  makeUser('U3', 'Carol'),
  makeUser('UBOT', 'Deploy Bot', { isBot: true }),
];

export function testDirectory(conversations: ConversationDTO[] = [makeConversation('C1', 'general')]): Directory {
  return buildDirectory(
    testUsers,
    conversations,
    { partyparrot: 'https://emoji.slack-edge.com/T9H/partyparrot/abc.gif', yay: 'alias:tada' },
    'U1',
    '9h',
  );
}

export interface RenderOptions {
  route?: string;
  /** Route pattern the element is mounted under (for useParams). */
  path?: string;
  client?: QueryClient;
  directory?: Directory;
}

export interface LocationRef {
  current: Location | null;
}

function LocationProbe({ into }: { into: LocationRef }) {
  into.current = useLocation();
  return null;
}

export function Providers({
  client,
  directory,
  children,
}: {
  client: QueryClient;
  directory: Directory;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={client}>
      <StaticDirectoryProvider directory={directory}>{children}</StaticDirectoryProvider>
    </QueryClientProvider>
  );
}

/** Renders `ui` inside router + query + directory providers; exposes the current location. */
export function renderWithProviders(ui: ReactElement, opts: RenderOptions = {}) {
  const client = opts.client ?? testQueryClient();
  const directory = opts.directory ?? testDirectory();
  const location: LocationRef = { current: null };
  const utils = render(
    <Providers client={client} directory={directory}>
      <MemoryRouter initialEntries={[opts.route ?? '/']} useTransitions={false}>
        <Routes>
          <Route
            path={opts.path ?? '*'}
            element={
              <>
                {ui}
                <LocationProbe into={location} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
  return { ...utils, client, location };
}

// ---------------------------------------------------------------------------------------------
// A scriptable preload bridge (window.archive)

export interface FakeBridge extends Omit<ArchiveBridge, 'call'> {
  /** The contract call, as a mock: inspect `.mock.calls` or override an answer. */
  call: Mock<(method: string, arg?: unknown) => Promise<unknown>>;
  /** Delivers a pushed event to every subscribed listener (inside act()). */
  emit<E extends ArchiveEvent>(event: E, payload: ArchiveEvents[E]): void;
  listenerCount(event: ArchiveEvent): number;
}

/**
 * Installs `window.archive`. `call` answers with `handler(method, arg)` wrapped as an IPC
 * envelope; a thrown `{ code, message }` becomes an error envelope, as main does.
 */
export function installFakeBridge(
  handler: (method: string, arg: unknown) => unknown = () => undefined,
  platform: ArchiveBridge['platform'] = 'darwin',
): FakeBridge {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const bridge = {
    platform,
    call: vi.fn(async (method: string, arg?: unknown) => {
      try {
        return { ok: true, value: await handler(method, arg) };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return { ok: false, error: { code: e.code ?? 'internal', message: e.message ?? '' } };
      }
    }),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    }),
    emit(event: string, payload: unknown) {
      act(() => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      });
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
  vi.stubGlobal('archive', bridge);
  return bridge as unknown as FakeBridge;
}

/** What main answers per method: a value, a function of the request, or an error `{ code, message }`. */
export type BridgeFixtures = Record<string, unknown>;

export const BLOCKED_ERROR = { code: 'blocked', message: 'This isn’t available yet.' };

/** A healthy, connected archive with onboarding done; override per test. */
export function appFixtures(overrides: BridgeFixtures = {}): BridgeFixtures {
  return {
    getSettings: makeSettings(),
    getWorkspace: makeWorkspace(),
    getUsers: testUsers,
    getConversations: [makeConversation('C1', 'general', { messageCount: 3 })],
    getEmoji: {},
    getStats: makeStats(),
    getStorage: makeStorage(),
    getSyncStatus: makeSyncStatus(),
    getUpdateInfo: makeUpdateInfo(),
    getAppInfo: makeAppInfo(),
    getLoginStatus: makeLoginStatus(),
    ...overrides,
  };
}

function isErrorFixture(value: unknown): value is { code: string; message: string } {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

/** `window.archive` answering from `data`; methods without an entry answer "not available". */
export function installFixtureBridge(data: BridgeFixtures, platform: ArchiveBridge['platform'] = 'darwin'): FakeBridge {
  return installFakeBridge(async (method, arg) => {
    const entry = data[method];
    if (entry === undefined) throw BLOCKED_ERROR;
    const value = typeof entry === 'function' ? await (entry as (arg: unknown) => unknown)(arg) : entry;
    if (isErrorFixture(value)) throw value;
    return value;
  }, platform);
}

// ---------------------------------------------------------------------------------------------
// IntersectionObserver / layout fakes (jsdom has neither)

export class FakeIntersectionObserver {
  static instances = new Set<FakeIntersectionObserver>();
  readonly targets = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  readonly options: IntersectionObserverInit | undefined;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    FakeIntersectionObserver.instances.add(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
    FakeIntersectionObserver.instances.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root = null;
  rootMargin = '';
  thresholds = [];
}

/** Reports `el` as intersecting to every live observer watching it. Returns how many fired. */
export function intersect(el: Element): number {
  let fired = 0;
  for (const io of [...FakeIntersectionObserver.instances]) {
    if (!io.targets.has(el)) continue;
    fired += 1;
    io.callback(
      [{ isIntersecting: true, target: el, intersectionRatio: 1 } as unknown as IntersectionObserverEntry],
      io as unknown as IntersectionObserver,
    );
  }
  return fired;
}

/**
 * Minimal fake layout for the message scroller: every message row is `rowHeight` px tall and
 * stacked in DOM order; the scroller is `viewport` px tall. Enough to exercise scroll anchoring.
 */
export function installFakeLayout(rowHeight = 40, viewport = 600): () => void {
  const proto = HTMLElement.prototype;
  const originalRect = proto.getBoundingClientRect;
  const scrollerOf = (el: Element) => el.closest('[data-testid="message-scroller"]') as HTMLElement | null;
  const rect = (top: number, height: number) =>
    ({ top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} }) as DOMRect;

  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.dataset.testid === 'message-scroller') return rect(0, viewport);
    const scroller = scrollerOf(this);
    if (scroller && this.hasAttribute('data-msg-ts')) {
      const rows = Array.from(scroller.querySelectorAll('[data-msg-ts]'));
      return rect(rows.indexOf(this) * rowHeight - scroller.scrollTop, rowHeight);
    }
    return originalRect.call(this);
  };
  const heightDesc = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  const clientDesc = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.querySelectorAll('[data-msg-ts]').length * rowHeight;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'message-scroller' ? viewport : 0;
    },
  });
  return () => {
    proto.getBoundingClientRect = originalRect;
    // jsdom defines these on Element.prototype; removing our override re-exposes them.
    if (heightDesc) Object.defineProperty(proto, 'scrollHeight', heightDesc);
    else Reflect.deleteProperty(proto, 'scrollHeight');
    if (clientDesc) Object.defineProperty(proto, 'clientHeight', clientDesc);
    else Reflect.deleteProperty(proto, 'clientHeight');
  };
}

/** Number of live observers currently watching `el`. */
export function observerCount(el: Element): number {
  let count = 0;
  for (const io of FakeIntersectionObserver.instances) if (io.targets.has(el)) count += 1;
  return count;
}
