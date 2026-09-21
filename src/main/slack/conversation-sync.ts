import { getStoredThreadInfo, getSyncState, listActiveThreads, setSyncState, upsertMessages, type DB } from '../db';
import type { HistoryResponse, RepliesResponse, SlackParams } from './api-types';
import type { SlackClient } from './client';
import { SlackApiError } from './errors';
import type { SlackMessage } from './types';
import { compareTs, subtractSeconds, throwIfAborted } from './util';

/**
 * Syncs one conversation's history and threads into the archive.
 *
 * sync_state invariant: every message in [oldest_ts, latest_ts] has been fetched and committed.
 *  - First sync pages history newest → oldest without bounds. latest_ts is set from the first
 *    page and oldest_ts after every page, which keeps the invariant because pages are contiguous;
 *    an interrupted first sync therefore resumes as incremental + backfill.
 *  - Incremental sync re-reads from `latest_ts - overlap` (to catch edits, reactions and new
 *    thread activity). Those pages also arrive newest first, so latest_ts only advances once the
 *    whole pass is committed; advancing it earlier could leave a hole after a crash.
 *  - Backfill continues below oldest_ts until Slack has nothing older (on the Free plan: the
 *    90-day limit), then sets backfill_complete.
 */

export interface ConversationSyncContext {
  db: DB;
  client: SlackClient;
  /** Passed to upsertMessages so a `done` file whose local copy vanished is re-queued. */
  filesDir: string;
  overlapSeconds: number;
  threadRecheckDays: number;
  now: () => number;
  signal?: AbortSignal;
  log: (line: string) => void;
  /** Human label for log lines, e.g. `#general`. */
  label: string;
  onProgress?: (event: ConversationProgress) => void;
}

/** Messages fetched so far in this conversation, and thread re-checks. */
export interface ConversationProgress {
  phase: 'history' | 'threads';
  fetched: number;
  threadsDone?: number;
  threadsTotal?: number;
}

export interface ConversationSyncResult {
  inserted: number;
  updated: number;
  revisions: number;
  threadsFetched: number;
  pages: number;
  /** Messages received from Slack (history pages and thread replies), new or not. */
  fetched: number;
}

/** Slack's recommended maximum page size for history and replies. */
const PAGE_LIMIT = 200;

export function emptyConversationResult(): ConversationSyncResult {
  return { inserted: 0, updated: 0, revisions: 0, threadsFetched: 0, pages: 0, fetched: 0 };
}

/**
 * `result` is updated as pages commit, so a caller whose sync throws midway (abort, token
 * revoked) still knows what was written.
 */
export async function syncConversation(
  ctx: ConversationSyncContext,
  conversationId: string,
  result: ConversationSyncResult = emptyConversationResult(),
): Promise<ConversationSyncResult> {
  const run = new ConversationRun(ctx, conversationId, result);
  const state = getSyncState(ctx.db, conversationId);
  if (!state?.latest_ts) {
    await run.firstSync();
  } else {
    await run.incremental(state.latest_ts);
    if (!state.backfill_complete) await run.backfill(state.oldest_ts ?? state.latest_ts);
  }
  await run.recheckActiveThreads();
  setSyncState(ctx.db, conversationId, { last_synced_at: ctx.now(), last_error: null });
  return run.result;
}

class ConversationRun {
  /** Threads known to be current in this run: refetched, or their parent's reply metadata matched storage. */
  private readonly checkedThreads = new Set<string>();

  constructor(
    private readonly ctx: ConversationSyncContext,
    private readonly id: string,
    readonly result: ConversationSyncResult,
  ) {}

  async firstSync(): Promise<void> {
    let newest: string | null = null;
    let oldest: string | null = null;
    const complete = await this.pageHistory({}, (messages) => {
      newest = maxTs(newest, messages);
      oldest = minTs(oldest, messages);
      if (newest) setSyncState(this.ctx.db, this.id, { latest_ts: newest, oldest_ts: oldest });
    });
    if (complete) setSyncState(this.ctx.db, this.id, { backfill_complete: true });
  }

  async incremental(latestTs: string): Promise<void> {
    let newest = latestTs;
    const oldest = subtractSeconds(latestTs, this.ctx.overlapSeconds);
    const complete = await this.pageHistory({ oldest, inclusive: true }, (messages) => {
      newest = maxTs(newest, messages) ?? newest;
    });
    if (complete) setSyncState(this.ctx.db, this.id, { latest_ts: newest });
    else this.ctx.log(`${this.ctx.label}: history paging ended early; will retry next sync`);
  }

  async backfill(oldestTs: string): Promise<void> {
    let oldest = oldestTs;
    const complete = await this.pageHistory({ latest: oldestTs, inclusive: false }, (messages) => {
      oldest = minTs(oldest, messages) ?? oldest;
      setSyncState(this.ctx.db, this.id, { oldest_ts: oldest });
    });
    if (complete) setSyncState(this.ctx.db, this.id, { backfill_complete: true });
  }

  /**
   * Re-polls threads with recent replies whose parent wasn't covered by this run's history pages
   * (e.g. an old parent with a new reply). With all replies stored, only replies from the stored
   * latest_reply on are requested; otherwise the whole thread is fetched to fill the gap.
   */
  async recheckActiveThreads(): Promise<void> {
    if (this.ctx.threadRecheckDays <= 0) return;
    const since = Math.floor(this.ctx.now() / 1000) - Math.round(this.ctx.threadRecheckDays * 86_400);
    const active = listActiveThreads(this.ctx.db, this.id, String(since)).filter(
      (t) => !this.checkedThreads.has(t.thread_ts),
    );
    for (const [i, thread] of active.entries()) {
      throwIfAborted(this.ctx.signal);
      this.ctx.onProgress?.({
        phase: 'threads',
        fetched: this.result.fetched,
        threadsDone: i,
        threadsTotal: active.length,
      });
      const info = getStoredThreadInfo(this.ctx.db, this.id, thread.thread_ts);
      const complete = info != null && info.latest_reply != null && info.stored_replies >= info.reply_count;
      await this.fetchThread(thread.thread_ts, complete ? info.latest_reply! : undefined);
    }
  }

  /** Pages `conversations.history`; returns whether Slack reported the end of the range. */
  private async pageHistory(bounds: SlackParams, afterPage: (messages: SlackMessage[]) => void): Promise<boolean> {
    let hasMore = false;
    const params: SlackParams = { channel: this.id, limit: PAGE_LIMIT, ...bounds };
    for await (const page of this.ctx.client.pages<HistoryResponse>('conversations.history', params)) {
      throwIfAborted(this.ctx.signal);
      const messages = validMessages(page.messages);
      this.result.pages++;
      this.result.fetched += messages.length;
      this.ctx.onProgress?.({ phase: 'history', fetched: this.result.fetched });
      await this.processHistoryPage(messages);
      afterPage(messages);
      hasMore = page.has_more === true;
    }
    // The pager stops when the cursor runs out; has_more without a cursor means we couldn't continue.
    return !hasMore;
  }

  /** Thread checks read stored reply metadata, so they must run before the page overwrites it. */
  private async processHistoryPage(messages: SlackMessage[]): Promise<void> {
    const stale = this.threadsNeedingFetch(messages);
    this.upsert(messages);
    for (const threadTs of stale) await this.fetchThread(threadTs);
  }

  private threadsNeedingFetch(messages: SlackMessage[]): string[] {
    const stale = new Set<string>();
    for (const [threadTs, parentMeta] of threadCandidates(messages)) {
      if (this.checkedThreads.has(threadTs) || stale.has(threadTs)) continue;
      const info = getStoredThreadInfo(this.ctx.db, this.id, threadTs);
      const needed = parentMeta ? threadChanged(info, parentMeta) : info === null;
      if (needed) stale.add(threadTs);
      else if (parentMeta) this.checkedThreads.add(threadTs);
    }
    return [...stale];
  }

  /**
   * Fetches a thread (parent first, then replies) and upserts it. Slack repeats the parent at the
   * top of every page, so messages are de-duplicated across pages.
   */
  private async fetchThread(threadTs: string, oldest?: string): Promise<void> {
    const params: SlackParams = { channel: this.id, ts: threadTs, limit: PAGE_LIMIT };
    if (oldest) Object.assign(params, { oldest, inclusive: true });
    const seen = new Set<string>();
    try {
      for await (const page of this.ctx.client.pages<RepliesResponse>('conversations.replies', params)) {
        throwIfAborted(this.ctx.signal);
        const fresh = validMessages(page.messages).filter((m) => !seen.has(m.ts));
        for (const m of fresh) seen.add(m.ts);
        this.result.fetched += fresh.filter((m) => m.ts !== threadTs).length;
        if (fresh.length) this.upsert(fresh);
      }
    } catch (err) {
      // The parent was deleted (or aged out) since we listed it: nothing to fetch, not an error.
      if (err instanceof SlackApiError && err.code === 'thread_not_found') {
        this.ctx.log(`${this.ctx.label}: thread ${threadTs} no longer exists in Slack`);
        this.checkedThreads.add(threadTs);
        return;
      }
      throw err;
    }
    this.result.threadsFetched++;
    this.checkedThreads.add(threadTs);
  }

  private upsert(messages: SlackMessage[]): void {
    if (!messages.length) return;
    const r = upsertMessages(this.ctx.db, this.id, messages, 'api', { filesDir: this.ctx.filesDir });
    this.result.inserted += r.inserted;
    this.result.updated += r.updated;
    this.result.revisions += r.revisions;
  }
}

/**
 * Threads a history page tells us about, with the freshest parent metadata available: the
 * parent itself, or for a broadcast reply (the only replies history returns) its embedded `root`.
 * Broadcasts matter because their parent may be too old to appear in this page at all.
 */
function threadCandidates(messages: SlackMessage[]): Map<string, SlackMessage | null> {
  const candidates = new Map<string, SlackMessage | null>();
  for (const m of messages) {
    if (isThreadParent(m)) candidates.set(m.ts, m);
  }
  for (const m of messages) {
    const threadTs = m.thread_ts;
    if (!threadTs || threadTs === m.ts || candidates.get(threadTs)) continue;
    const root = m.root && typeof m.root === 'object' ? (m.root as SlackMessage) : null;
    candidates.set(threadTs, root && (root.reply_count ?? 0) > 0 ? root : null);
  }
  return candidates;
}

function isThreadParent(m: SlackMessage): boolean {
  return (m.reply_count ?? 0) > 0 && (!m.thread_ts || m.thread_ts === m.ts);
}

type StoredThreadInfo = ReturnType<typeof getStoredThreadInfo>;

/** True when Slack's view of the thread differs from what we hold, or replies are missing. */
function threadChanged(info: StoredThreadInfo, parent: SlackMessage): boolean {
  if (!info) return true;
  const replyCount = parent.reply_count ?? 0;
  const latest = parent.latest_reply ?? null;
  if (latest && (!info.latest_reply || compareTs(latest, info.latest_reply) !== 0)) return true;
  if (replyCount !== info.reply_count) return true;
  return info.stored_replies < replyCount;
}

function validMessages(list: SlackMessage[] | undefined): SlackMessage[] {
  if (!Array.isArray(list)) return [];
  return list.filter((m) => m && typeof m === 'object' && typeof m.ts === 'string' && m.ts !== '');
}

function maxTs(current: string | null, messages: SlackMessage[]): string | null {
  return messages.reduce<string | null>((acc, m) => (acc === null || compareTs(m.ts, acc) > 0 ? m.ts : acc), current);
}

function minTs(current: string | null, messages: SlackMessage[]): string | null {
  return messages.reduce<string | null>((acc, m) => (acc === null || compareTs(m.ts, acc) < 0 ? m.ts : acc), current);
}
