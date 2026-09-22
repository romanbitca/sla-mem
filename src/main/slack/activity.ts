/**
 * Which conversations an incremental sync reads (PLAN §5.2, as built). Reading a conversation
 * costs at least one paced `conversations.history` call, so a workspace with a hundred
 * conversations spent minutes per sync even when nothing had changed. Instead:
 *  - Slack's activity summary (one call) says which conversations have new messages; those are
 *    read now.
 *  - What the summary doesn't show (new replies to older threads, edits, reactions, deletions) is
 *    picked up by re-reading conversations on a schedule that follows how recently they were
 *    active: every sync within ACTIVE_WINDOW_MS (about 99% of thread replies arrive while a
 *    conversation is that fresh), otherwise about once a day, and once a week after
 *    DORMANT_AFTER_MS of silence.
 *  - Without a usable summary every conversation is read, as before.
 */
import type { SyncStateRow } from '../db';
import type { ClientCountsResponse } from './api-types';
import type { SlackClient } from './client';
import { SlackApiError, isFatalAuthError } from './errors';
import type { SlackMessage } from './types';
import { compareTs, isAbortError } from './util';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A conversation with a message or thread reply this recent is read on every sync. */
export const ACTIVE_WINDOW_MS = 2 * DAY_MS;
/** Quieter conversations are read about this often… */
export const RECHECK_INTERVAL_MS = DAY_MS;
/** …and ones silent for longer than this (or with nothing archived) about once a week. */
export const DORMANT_AFTER_MS = 30 * DAY_MS;
export const DORMANT_RECHECK_INTERVAL_MS = 7 * DAY_MS;

/** When the summary missed new messages, it isn't used for this long (meta key below). */
export const SUMMARY_OFF_MS = 7 * DAY_MS;
export const SUMMARY_OFF_UNTIL_KEY = 'activity_summary_off_until';
/** Allowance for clock skew and messages posted while a read was under way. */
const CLOCK_MARGIN_MS = 10 * MINUTE_MS;

/** Slack's activity summary: each conversation's newest message, as Slack reports it. */
export interface ActivitySummary {
  /** Conversation id → ts of its newest message; null when Slack reports none. */
  latest: Map<string, string | null>;
  /** Epoch ms just before Slack was asked. */
  takenAt: number;
}

export type CheckReason = 'requested' | 'first' | 'backfill' | 'retry' | 'unknown' | 'new' | 'active' | 'due';
export type CheckPlan = { read: true; reason: CheckReason } | { read: false; reason: 'unchanged' };

/**
 * Asks Slack which conversations have new messages: `client.counts`, the call the Slack app makes
 * to show unread conversations in bold, answered for the same browser session this app uses. It
 * isn't part of the documented Web API, so any failure or unfamiliar answer returns null and the
 * sync reads every conversation instead. Only a signed-out session or an abort is rethrown.
 */
export async function fetchActivitySummary(
  client: SlackClient,
  now: () => number,
  log: (line: string) => void,
): Promise<ActivitySummary | null> {
  const takenAt = now();
  try {
    const res = await client.call<ClientCountsResponse>('client.counts', { org_wide_aware: true });
    const latest = parseActivitySummary(res);
    if (!latest) log('Slack’s activity summary looked unfamiliar; reading every conversation');
    return latest ? { latest, takenAt } : null;
  } catch (err) {
    if (isFatalAuthError(err) || isAbortError(err)) throw err;
    const reason = err instanceof SlackApiError ? err.code : err instanceof Error ? err.message : String(err);
    log(`Slack’s activity summary is unavailable (${reason}); reading every conversation`);
    return null;
  }
}

const TS_RE = /^\d+(?:\.\d+)?$/;

/**
 * `{ channels, ims, mpims: [{ id, latest }] }` → id → newest ts (null for "0000000000.000000").
 * Anything unexpected (no lists, an entry with a malformed `latest`, nothing at all) returns null:
 * a summary that can't be read in full isn't trusted in part.
 */
export function parseActivitySummary(body: unknown): Map<string, string | null> | null {
  if (!body || typeof body !== 'object') return null;
  const lists = (['channels', 'ims', 'mpims'] as const).map((key) => (body as ClientCountsResponse)[key]);
  if (!lists.some(Array.isArray)) return null;
  const latest = new Map<string, string | null>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) continue;
      if (typeof entry.latest !== 'string' || !TS_RE.test(entry.latest)) return null;
      latest.set(entry.id, Number(entry.latest) > 0 ? entry.latest : null);
    }
  }
  return latest.size ? latest : null;
}

export interface PlanInput {
  state: SyncStateRow | null;
  /** Newest archived message or thread reply (Slack ts); null when nothing is archived. */
  lastActivity: string | null;
  /** null when there is no usable summary: every conversation is then read. */
  summary: ActivitySummary | null;
  /** Asked for by name (e.g. `conversationIds`): always read. */
  requested: boolean;
  /** Epoch ms. */
  now: number;
}

/**
 * Whether this sync reads the conversation, and why. A conversation missing from the summary is
 * treated as unchanged: Slack leaves out conversations closed in the sidebar, and a new message
 * reopens (and so lists) them. The periodic re-read covers anything that slips through.
 */
export function planConversation(conversationId: string, input: PlanInput): CheckPlan {
  const { state, summary, now } = input;
  if (input.requested) return { read: true, reason: 'requested' };
  if (!state || (!state.latest_ts && !state.backfill_complete)) return { read: true, reason: 'first' };
  if (!state.backfill_complete) return { read: true, reason: 'backfill' };
  if (state.last_error) return { read: true, reason: 'retry' };
  if (!summary) return { read: true, reason: 'unknown' };

  const reported = summary.latest.get(conversationId);
  if (reported && isNewerThanLastRead(reported, state)) return { read: true, reason: 'new' };

  const activeAt = input.lastActivity ? Number(input.lastActivity) * 1000 : null;
  if (activeAt != null && now - activeAt < ACTIVE_WINDOW_MS) return { read: true, reason: 'active' };
  const dormant = activeAt == null || now - activeAt >= DORMANT_AFTER_MS;
  const interval = dormant ? DORMANT_RECHECK_INTERVAL_MS : RECHECK_INTERVAL_MS;
  if (state.last_synced_at == null || isDue(state.last_synced_at, now, interval, phaseOf(conversationId, interval))) {
    return { read: true, reason: 'due' };
  }
  return { read: false, reason: 'unchanged' };
}

/**
 * Newer than anything the last read could have returned: the newest archived message, and the time
 * of that read (less a margin). The second matters when Slack's newest message never shows up in
 * history (hidden by the Free plan's limit, or a thread reply): without it, such a conversation
 * would be read on every sync.
 */
function isNewerThanLastRead(reported: string, state: SyncStateRow): boolean {
  if (state.latest_ts && compareTs(reported, state.latest_ts) <= 0) return false;
  if (state.last_synced_at != null && Number(reported) * 1000 < state.last_synced_at - CLOCK_MARGIN_MS) return false;
  return true;
}

/**
 * True once a boundary at `phase + k × interval` has passed since the last read. Each
 * conversation so comes due once per interval, and the per-conversation phase spreads those
 * re-reads over the interval instead of piling them onto one sync a day. A last read "in the
 * future" (the clock was changed) counts as due.
 */
export function isDue(lastMs: number, nowMs: number, intervalMs: number, phaseMs: number): boolean {
  if (lastMs > nowMs) return true;
  return Math.floor((nowMs - phaseMs) / intervalMs) > Math.floor((lastMs - phaseMs) / intervalMs);
}

/** A stable offset in [0, interval) from the conversation id (FNV-1a). */
export function phaseOf(conversationId: string, intervalMs: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < conversationId.length; i++) {
    hash ^= conversationId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash / 2 ** 32) * intervalMs;
}

const PLAIN_SUBTYPES = new Set(['bot_message', 'file_share', 'me_message']);

/**
 * Top-level messages that certainly move a conversation's newest message in Slack's summary: not
 * joins, topic changes or thread broadcasts, which the summary might not count.
 */
export function isPlainMessage(m: SlackMessage): boolean {
  if (m.thread_ts && m.thread_ts !== m.ts) return false;
  return !m.subtype || PLAIN_SUBTYPES.has(m.subtype);
}

/**
 * A conversation read on schedule turned out to have a new message that Slack's summary didn't
 * report, although it was posted well before the summary was taken.
 */
export function summaryMissed(
  summary: ActivitySummary,
  conversationId: string,
  previousLatest: string | null,
  newestPlain: string | null,
): boolean {
  if (!newestPlain) return false;
  if (previousLatest && compareTs(newestPlain, previousLatest) <= 0) return false;
  const reported = summary.latest.get(conversationId);
  if (reported && compareTs(newestPlain, reported) <= 0) return false;
  return Number(newestPlain) * 1000 < summary.takenAt - CLOCK_MARGIN_MS;
}
