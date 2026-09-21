/**
 * react-query hooks over `api`. Query keys live in `qk` so invalidation stays consistent.
 *
 * Main pushes sync status, sign-in progress, settings and update info as events; `events.ts`
 * writes them into this cache, so those queries only poll slowly as a safety net. Directory data
 * (users, conversations, emoji) is cached forever and refreshed when a sync/import finishes —
 * see `useSyncRunWatcher`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  ConversationDTO,
  CookieLoginRequest,
  LoginState,
  LoginStatusDTO,
  MessageDTO,
  MessagesPage,
  PreferencesPatch,
  SearchParams,
  SearchResponse,
  SettingsDTO,
  SlackConnectionDTO,
  StartLoginRequest,
  SyncRunDTO,
  SyncStatusDTO,
} from '../../shared/types';
import { api, type MessagesWindow } from './api';
import { dedupeMessages } from './grouping';

export const qk = {
  workspace: ['workspace'] as const,
  stats: ['stats'] as const,
  users: ['users'] as const,
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversations', id] as const,
  emoji: ['emoji'] as const,
  messagesAll: ['messages'] as const,
  messages: (conversationId: string, anchorTs: string | null) =>
    ['messages', conversationId, anchorTs ?? 'latest'] as const,
  threadsAll: ['thread'] as const,
  thread: (conversationId: string, threadTs: string) => ['thread', conversationId, threadTs] as const,
  revisions: (conversationId: string, ts: string) => ['revisions', conversationId, ts] as const,
  searchAll: ['search'] as const,
  search: (params: SearchParams) => ['search', normalizeSearchKey(params)] as const,
  syncStatus: ['sync', 'status'] as const,
  settings: ['settings'] as const,
  loginStatus: ['login'] as const,
  storage: ['storage'] as const,
  appInfo: ['app', 'info'] as const,
  updateInfo: ['app', 'update'] as const,
};

function normalizeSearchKey(p: SearchParams) {
  const sorted = (a?: readonly string[]) => (a && a.length ? [...a].sort() : undefined);
  return {
    q: p.q.trim(),
    conversation: sorted(p.conversation),
    user: sorted(p.user),
    after: p.after || undefined,
    before: p.before || undefined,
    has: sorted(p.has),
    sort: p.sort ?? 'relevance',
    limit: p.limit,
  };
}

// ---------------------------------------------------------------------------------------------
// Directory

export function useWorkspace() {
  return useQuery({ queryKey: qk.workspace, queryFn: ({ signal }) => api.getWorkspace(signal), staleTime: 60_000 });
}

export function useStats() {
  return useQuery({ queryKey: qk.stats, queryFn: ({ signal }) => api.getStats(signal) });
}

export function useUsers() {
  return useQuery({ queryKey: qk.users, queryFn: ({ signal }) => api.getUsers(signal), staleTime: Infinity });
}

export function useConversations() {
  return useQuery({
    queryKey: qk.conversations,
    queryFn: ({ signal }) => api.getConversations(signal),
    staleTime: Infinity,
  });
}

/** One conversation; shows the entry from the cached list instantly while the detail loads. */
export function useConversation(id: string) {
  const qc = useQueryClient();
  return useQuery<ConversationDTO>({
    queryKey: qk.conversation(id),
    queryFn: ({ signal }) => api.getConversation(id, signal),
    placeholderData: () => qc.getQueryData<ConversationDTO[]>(qk.conversations)?.find((c) => c.id === id),
    staleTime: 60_000,
  });
}

export function useEmoji() {
  return useQuery({ queryKey: qk.emoji, queryFn: ({ signal }) => api.getEmoji(signal), staleTime: Infinity });
}

// ---------------------------------------------------------------------------------------------
// Messages

/** Messages per request. With MESSAGE_MAX_PAGES this bounds the mounted list to ~600 rows. */
export const MESSAGE_PAGE_SIZE = 100;
export const MESSAGE_MAX_PAGES = 6;

export type MessagePageParam = Pick<MessagesWindow, 'before' | 'after' | 'around'>;

/**
 * A page fetched relative to an existing message necessarily has that message on the other
 * side, so we don't depend on main for that direction. This keeps paging possible after
 * `maxPages` drops pages off the far end.
 */
function normalizePage(page: MessagesPage, param: MessagePageParam): MessagesPage {
  return {
    ...page,
    hasMoreBefore: page.hasMoreBefore || (param.after != null && page.messages.length > 0),
    hasMoreAfter: page.hasMoreAfter || (param.before != null && page.messages.length > 0),
  };
}

export function getOlderParam(first: MessagesPage): MessagePageParam | undefined {
  const oldest = first.messages[0];
  return first.hasMoreBefore && oldest ? { before: oldest.ts } : undefined;
}

export function getNewerParam(last: MessagesPage): MessagePageParam | undefined {
  const newest = last.messages[last.messages.length - 1];
  return last.hasMoreAfter && newest ? { after: newest.ts } : undefined;
}

/**
 * A bidirectional window over a conversation's top-level messages.
 * `anchorTs` null starts at the latest page; otherwise the first page is centered on it.
 * `maxPages` drops the far end when paging, keeping the DOM bounded in huge channels.
 */
export function useMessages(conversationId: string, anchorTs: string | null) {
  const query = useInfiniteQuery<
    MessagesPage,
    Error,
    InfiniteData<MessagesPage, MessagePageParam>,
    ReturnType<typeof qk.messages>,
    MessagePageParam
  >({
    queryKey: qk.messages(conversationId, anchorTs),
    queryFn: async ({ pageParam, signal }) =>
      normalizePage(
        await api.getMessages(conversationId, { ...pageParam, limit: MESSAGE_PAGE_SIZE }, signal),
        pageParam,
      ),
    initialPageParam: anchorTs ? { around: anchorTs } : {},
    getPreviousPageParam: (first) => getOlderParam(first),
    getNextPageParam: (last) => getNewerParam(last),
    maxPages: MESSAGE_MAX_PAGES,
    staleTime: Infinity,
  });

  const pages = query.data?.pages;
  const messages = useMemo<MessageDTO[]>(() => (pages ? dedupeMessages(pages.map((p) => p.messages)) : []), [pages]);
  return { ...query, messages };
}

export function useThread(conversationId: string, threadTs: string | null) {
  return useQuery({
    queryKey: qk.thread(conversationId, threadTs ?? ''),
    queryFn: ({ signal }) => api.getThread(conversationId, threadTs!, signal),
    enabled: threadTs != null,
    staleTime: Infinity,
  });
}

export function useRevisions(conversationId: string, ts: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.revisions(conversationId, ts),
    queryFn: ({ signal }) => api.getRevisions(conversationId, ts, signal),
    enabled,
    staleTime: Infinity,
  });
}

// ---------------------------------------------------------------------------------------------
// Search

export const SEARCH_PAGE_SIZE = 30;

/**
 * Offset-paged search ("load more" = `fetchNextPage`). Pass `null` to disable.
 * Keeps the previous results on screen while a new query loads.
 */
export function useSearch(params: SearchParams | null) {
  const limit = params?.limit ?? SEARCH_PAGE_SIZE;
  return useInfiniteQuery<SearchResponse, Error, InfiniteData<SearchResponse, number>, readonly unknown[], number>({
    queryKey: params ? qk.search({ ...params, limit }) : ['search', 'disabled'],
    queryFn: ({ pageParam, signal }) => api.search({ ...params!, limit, offset: pageParam }, signal),
    initialPageParam: params?.offset ?? 0,
    getNextPageParam: (last, _all, lastOffset) => {
      const next = lastOffset + last.hits.length;
      return last.hits.length > 0 && next < last.total ? next : undefined;
    },
    enabled: params != null,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------------------------
// Sync

/** Main pushes every change; this slow poll only covers a missed event or a sleeping laptop. */
export const SYNC_POLL_FALLBACK_MS = 30_000;

export function useSyncStatus() {
  return useQuery({
    queryKey: qk.syncStatus,
    queryFn: ({ signal }) => api.getSyncStatus(signal),
    refetchInterval: SYNC_POLL_FALLBACK_MS,
    staleTime: 5_000,
  });
}

/** Everything a finished run may have changed. */
export function invalidateArchiveData(qc: QueryClient): Promise<void> {
  return Promise.all(
    [
      qk.users,
      qk.conversations,
      qk.emoji,
      qk.stats,
      qk.workspace,
      qk.storage,
      qk.messagesAll,
      qk.threadsAll,
      qk.searchAll,
    ].map((queryKey) => qc.invalidateQueries({ queryKey })),
  ).then(() => undefined);
}

/** Identifies the latest finished run ("id:finishedAt"); null before any has finished. */
export function lastFinishedRunKey(status: SyncStatusDTO): string | null {
  let latest: SyncRunDTO | null = null;
  for (const run of status.recentRuns) {
    if (run.finishedAt != null && (!latest || run.id > latest.id)) latest = run;
  }
  return latest ? `${latest.id}:${latest.finishedAt}` : null;
}

/**
 * Mount once (app level): refreshes archive data when a run finishes, whether it was started
 * here, by the schedule or from the tray. A short run (a single file's Retry) can start and end
 * between two pushes of the throttled status, so a newly finished run counts as much as seeing
 * `running` go from true to false.
 */
export function useSyncRunWatcher(status: SyncStatusDTO | undefined): void {
  const qc = useQueryClient();
  const seen = useRef<{ running: boolean; finished: string | null } | null>(null);
  const running = status?.running;
  const finished = status ? lastFinishedRunKey(status) : undefined;
  useEffect(() => {
    if (running == null || finished === undefined) return;
    const prev = seen.current;
    seen.current = { running, finished };
    if (prev && ((prev.running && !running) || prev.finished !== finished)) void invalidateArchiveData(qc);
  }, [running, finished, qc]);

  // A first sync can take the better part of an hour: as it moves on, the sidebar and the numbers
  // follow (message pages are left alone, so reading isn't disturbed).
  const step = status?.running ? `${status.progress?.phase ?? ''}:${status.progress?.current ?? ''}` : null;
  const lastLive = useRef(0);
  useEffect(() => {
    if (!step) return;
    const now = Date.now();
    if (now - lastLive.current < LIVE_REFRESH_MS) return;
    lastLive.current = now;
    void refreshArchiveLists(qc);
  }, [step, qc]);
}

/** How often lists refresh at most while a sync runs. */
export const LIVE_REFRESH_MS = 10_000;

/** The light parts of the archive, cheap to reload during a sync. */
export function refreshArchiveLists(qc: QueryClient): Promise<void> {
  return Promise.all(
    [qk.conversations, qk.users, qk.stats, qk.workspace, qk.storage].map((queryKey) =>
      qc.invalidateQueries({ queryKey }),
    ),
  ).then(() => undefined);
}

/** Whether run `runId` has finished; with no id (main started nothing), once nothing runs. */
export function isRunFinished(status: SyncStatusDTO, runId: number | null): boolean {
  if (runId == null) return !status.running;
  return status.recentRuns.some((run) => run.id === runId && run.finishedAt != null);
}

/**
 * `isRunFinished` over the cached sync status, for a run this screen started (e.g. a file's
 * Retry). Reads what main pushes without starting another poll: many cards may ask at once.
 */
export function useRunFinished(runId: number | null, enabled: boolean): boolean {
  const { data } = useQuery({
    queryKey: qk.syncStatus,
    queryFn: ({ signal }) => api.getSyncStatus(signal),
    enabled: false,
    select: (status: SyncStatusDTO) => isRunFinished(status, runId),
  });
  return enabled && data === true;
}

export function useStartSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.startSync(),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.syncStatus }),
  });
}

export function useCancelSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelSync(),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.syncStatus }),
  });
}

/** Main opens a folder/zip picker; the result is null when the reader cancelled it. */
export function useImportExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.importExport(),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.syncStatus }),
  });
}

export function useRetryFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api.retryFile({ fileId }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.syncStatus }),
  });
}

// ---------------------------------------------------------------------------------------------
// Settings

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: ({ signal }) => api.getSettings(signal), staleTime: 30_000 });
}

/**
 * Saves preferences optimistically: the control shows the new value at once and rolls back
 * (then refetches the truth) if main refuses it.
 */
export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: PreferencesPatch) => api.updatePreferences(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: qk.settings });
      const previous = qc.getQueryData<SettingsDTO>(qk.settings);
      if (previous) {
        qc.setQueryData<SettingsDTO>(qk.settings, {
          ...previous,
          preferences: { ...previous.preferences, ...patch },
        });
      }
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) qc.setQueryData(qk.settings, context.previous);
      void qc.invalidateQueries({ queryKey: qk.settings });
    },
    onSuccess: (settings) => qc.setQueryData(qk.settings, settings),
    // The schedule changes the next run time shown with the sync status.
    onSettled: () => qc.invalidateQueries({ queryKey: qk.syncStatus }),
  });
}

export function useCompleteOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (launchAtLogin: boolean) => api.completeOnboarding({ launchAtLogin }),
    onSuccess: (settings) => qc.setQueryData(qk.settings, settings),
  });
}

// ---------------------------------------------------------------------------------------------
// The Slack connection

/** Everything a new (or removed) Slack connection changes. */
export function invalidateConnectionData(qc: QueryClient): Promise<void> {
  return Promise.all(
    [qk.workspace, qk.settings, qk.syncStatus, qk.conversations, qk.stats].map((queryKey) =>
      qc.invalidateQueries({ queryKey }),
    ),
  ).then(() => undefined);
}

/** Writes a fresh connection into the cached settings so cards update before the refetch. */
export function setCachedConnection(qc: QueryClient, connection: SlackConnectionDTO): void {
  qc.setQueryData<SettingsDTO>(qk.settings, (prev) => (prev ? { ...prev, connection } : prev));
}

/** Sign-in states in which main is still working (the Slack window is open or being checked). */
export const ACTIVE_LOGIN_STATES: ReadonlySet<LoginState> = new Set(['opening', 'waiting', 'choose_team', 'verifying']);

export function isLoginActive(state: LoginState | null | undefined): boolean {
  return state != null && ACTIVE_LOGIN_STATES.has(state);
}

/** Main pushes sign-in progress; this poll only covers a missed event while a sign-in runs. */
export const LOGIN_POLL_FALLBACK_MS = 3_000;

export function useLoginStatus(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: qk.loginStatus,
    queryFn: ({ signal }) => api.getLoginStatus(signal),
    enabled: opts.enabled ?? true,
    refetchInterval: (query) => (isLoginActive(query.state.data?.state) ? LOGIN_POLL_FALLBACK_MS : false),
    staleTime: 0,
  });
}

const LOGIN_STEP: Record<LoginState, number> = {
  idle: 0,
  opening: 1,
  waiting: 2,
  choose_team: 3,
  verifying: 4,
  connected: 5,
  error: 5,
  cancelled: 5,
};

/**
 * Whether `incoming` should replace the cached sign-in status. Main may push a later step of the
 * same sign-in (same `startedAt`) before the reply to Start or Choose arrives; that reply must
 * not move the screen backwards.
 */
export function isLoginUpdate(cached: LoginStatusDTO | undefined, incoming: LoginStatusDTO): boolean {
  if (!cached || cached.startedAt == null || cached.startedAt !== incoming.startedAt) return true;
  return LOGIN_STEP[incoming.state] >= LOGIN_STEP[cached.state];
}

/**
 * Writes a sign-in status (pushed by main, or a reply) into the cache. A sign-in that just
 * completed changes the workspace, the connection and what sync can do, so those refresh too.
 */
export function applyLoginStatus(qc: QueryClient, status: LoginStatusDTO): void {
  const prev = qc.getQueryData<LoginStatusDTO>(qk.loginStatus);
  qc.setQueryData(qk.loginStatus, status);
  if (status.state === 'connected' && prev?.state !== 'connected') void invalidateConnectionData(qc);
}

/**
 * Start / choose / cancel answer with the new sign-in status. A status fetch still in flight was
 * asked before the change, so it's cancelled: landing after this result it would overwrite it
 * (e.g. "idle" right after Start). The reply goes through the same path as a pushed status.
 */
function useLoginMutation<V>(fn: (vars: V) => Promise<LoginStatusDTO>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: () => qc.cancelQueries({ queryKey: qk.loginStatus }),
    onSuccess: (status) => {
      if (isLoginUpdate(qc.getQueryData<LoginStatusDTO>(qk.loginStatus), status)) applyLoginStatus(qc, status);
    },
  });
}

export function useStartLogin() {
  return useLoginMutation((req: StartLoginRequest) => api.startLogin(req));
}

export function useChooseLoginTeam() {
  return useLoginMutation((teamId: string) => api.chooseLoginTeam({ teamId }));
}

export function useCancelLogin() {
  return useLoginMutation(() => api.cancelLogin());
}

function useConnectionMutation<V>(fn: (vars: V) => Promise<SlackConnectionDTO>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (connection) => {
      setCachedConnection(qc, connection);
      void invalidateConnectionData(qc);
    },
  });
}

export function useConnectWithCookie() {
  return useConnectionMutation((req: CookieLoginRequest) => api.connectWithCookie(req));
}

export function useDisconnect() {
  return useConnectionMutation(() => api.disconnect());
}

export function useTestConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.testConnection(),
    onSuccess: (connection) => setCachedConnection(qc, connection),
  });
}

/**
 * Follows a sign-in this screen has seen in progress, so a result from before the screen opened
 * never pops up. `followed` turns true once an active state is seen (or `follow()` is called
 * when Start returns); `reset()` forgets it (after Cancel or Try again).
 */
export function useLoginFollower(status: LoginStatusDTO | undefined): {
  followed: boolean;
  follow: () => void;
  reset: () => void;
} {
  const [followed, setFollowed] = useState(false);
  const active = isLoginActive(status?.state);
  if (active && !followed) setFollowed(true);
  return useMemo(() => ({ followed, follow: () => setFollowed(true), reset: () => setFollowed(false) }), [followed]);
}

// ---------------------------------------------------------------------------------------------
// Storage, backup, files

export function useStorage() {
  return useQuery({ queryKey: qk.storage, queryFn: ({ signal }) => api.getStorage(signal), staleTime: 60_000 });
}

export function useDeleteOldAttachments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (months: number) => api.deleteAttachmentsOlderThan({ months }),
    // Removed files change their cards (now "Removed to save space") and the numbers.
    onSuccess: () => invalidateArchiveData(qc),
  });
}

/** Main opens a folder picker; the result is null when the reader cancelled it. */
export function useBackupNow() {
  return useMutation({ mutationFn: () => api.backupNow() });
}

/**
 * Main opens a save dialog, writes the conversation as Markdown and shows the file in
 * Finder/Explorer. The result is null when the reader cancelled the dialog.
 */
export function useExportConversation() {
  return useMutation({ mutationFn: (conversationId: string) => api.exportConversation({ conversationId }) });
}

export function useShowDataFolder() {
  return useMutation({ mutationFn: () => api.showDataFolder() });
}

export function useShowLogs() {
  return useMutation({ mutationFn: () => api.showLogs() });
}

export function useOpenFile() {
  return useMutation({ mutationFn: (fileId: string) => api.openFile({ fileId }) });
}

export function useRevealFile() {
  return useMutation({ mutationFn: (fileId: string) => api.revealFile({ fileId }) });
}

// ---------------------------------------------------------------------------------------------
// App info and updates

export function useAppInfo() {
  return useQuery({ queryKey: qk.appInfo, queryFn: ({ signal }) => api.getAppInfo(signal), staleTime: Infinity });
}

export function useUpdateInfo() {
  return useQuery({
    queryKey: qk.updateInfo,
    queryFn: ({ signal }) => api.getUpdateInfo(signal),
    staleTime: Infinity,
  });
}

export function useCheckForUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.checkForUpdates(),
    onSuccess: (info) => qc.setQueryData(qk.updateInfo, info),
  });
}

export function useOpenUpdateDownload() {
  return useMutation({ mutationFn: () => api.openUpdateDownload() });
}

export function useOpenExternal() {
  return useMutation({ mutationFn: (url: string) => api.openExternal({ url }) });
}
