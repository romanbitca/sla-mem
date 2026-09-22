import { describe, expect, it } from 'vitest';
import type { SyncStateRow } from '../db';
import {
  ACTIVE_WINDOW_MS,
  DORMANT_RECHECK_INTERVAL_MS,
  RECHECK_INTERVAL_MS,
  isDue,
  isPlainMessage,
  parseActivitySummary,
  phaseOf,
  planConversation,
  summaryMissed,
  type ActivitySummary,
  type PlanInput,
} from './activity';

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Slack ts `ms` milliseconds before NOW. */
const ago = (ms: number) => `${Math.floor((NOW - ms) / 1000)}.000100`;

function state(patch: Partial<SyncStateRow> = {}): SyncStateRow {
  return {
    conversation_id: 'C1',
    latest_ts: ago(3 * DAY),
    oldest_ts: ago(80 * DAY),
    backfill_complete: true,
    last_synced_at: NOW - 5 * 60_000,
    last_error: null,
    ...patch,
  };
}

function summary(entries: Record<string, string | null> = {}): ActivitySummary {
  return { latest: new Map(Object.entries(entries)), takenAt: NOW };
}

function plan(patch: Partial<PlanInput> = {}, id = 'C1') {
  return planConversation(id, {
    state: state(),
    lastActivity: ago(3 * DAY),
    summary: summary({ C1: ago(3 * DAY) }),
    requested: false,
    now: NOW,
    ...patch,
  });
}

describe('planConversation', () => {
  it('skips a conversation Slack reports nothing new in, that was read recently', () => {
    expect(plan()).toEqual({ read: false, reason: 'unchanged' });
  });

  it('reads one Slack reports a newer message in', () => {
    expect(plan({ summary: summary({ C1: ago(60_000) }) })).toEqual({ read: true, reason: 'new' });
  });

  it('reads one that was active in the last 2 days, for thread replies, edits and reactions', () => {
    expect(plan({ lastActivity: ago(ACTIVE_WINDOW_MS - HOUR) })).toEqual({ read: true, reason: 'active' });
    expect(plan({ lastActivity: ago(ACTIVE_WINDOW_MS + HOUR) })).toEqual({ read: false, reason: 'unchanged' });
  });

  it('re-reads quiet conversations daily and silent or empty ones weekly', () => {
    /** Reads over `days` daily syncs after one at NOW, when nothing new is reported. */
    const reads = (lastActivity: string | null, days: number, latest: string | null = ago(3 * DAY)) => {
      let lastRead = NOW;
      let count = 0;
      for (let d = 1; d <= days; d++) {
        const now = NOW + d * DAY;
        const p = plan({
          now,
          lastActivity,
          state: state({ latest_ts: latest, last_synced_at: lastRead }),
          summary: summary({ C1: latest }),
        });
        if (p.read) [count, lastRead] = [count + 1, now];
      }
      return count;
    };
    expect(reads(ago(10 * DAY), 14)).toBe(14);
    expect(reads(ago(40 * DAY), 14)).toBe(2);
    // Nothing archived (e.g. everything is older than the Free plan's 90 days): weekly too.
    expect(reads(null, 14, null)).toBe(2);
    // Read a whole interval ago: always due, whatever the conversation's phase.
    const quiet = { lastActivity: ago(10 * DAY) };
    expect(plan({ ...quiet, state: state({ last_synced_at: NOW - RECHECK_INTERVAL_MS }) }).reason).toBe('due');
    const silent = { lastActivity: ago(40 * DAY) };
    expect(plan({ ...silent, state: state({ last_synced_at: NOW - DORMANT_RECHECK_INTERVAL_MS }) }).reason).toBe('due');
  });

  it('reads everything without a usable summary', () => {
    expect(plan({ summary: null })).toEqual({ read: true, reason: 'unknown' });
  });

  it('always reads first syncs, unfinished backfills, conversations that failed, and requested ones', () => {
    expect(plan({ state: null }).reason).toBe('first');
    expect(plan({ state: state({ latest_ts: null, backfill_complete: false }) }).reason).toBe('first');
    expect(plan({ state: state({ backfill_complete: false }) }).reason).toBe('backfill');
    expect(plan({ state: state({ last_error: 'HTTP 500' }) }).reason).toBe('retry');
    expect(plan({ requested: true }).reason).toBe('requested');
  });

  it('an empty conversation that finished its first sync waits for Slack to report a message', () => {
    const empty = state({ latest_ts: null, oldest_ts: null });
    expect(plan({ state: empty, lastActivity: null, summary: summary({ C1: null }) }).reason).toBe('unchanged');
    expect(plan({ state: empty, lastActivity: null, summary: summary({ C1: ago(60_000) }) }).reason).toBe('new');
  });

  it('doesn’t take a message the last read couldn’t see for a new one (Free-plan limit, thread reply)', () => {
    const readAt = NOW - DAY / 2;
    // Nothing archived: the newest message is older than the 90 days Slack shows.
    const empty = state({ latest_ts: null, oldest_ts: null, last_synced_at: readAt });
    expect(plan({ state: empty, lastActivity: null, summary: summary({ C1: ago(100 * DAY) }) }).reason).toBe(
      'unchanged',
    );
    // Something Slack counts but history doesn't return, from before the last read.
    const s = state({ last_synced_at: readAt });
    expect(plan({ state: s, summary: summary({ C1: ago(DAY) }) }).reason).toBe('unchanged');
    // After the read (or just before it, allowing for clock skew) it is new.
    expect(plan({ state: s, summary: summary({ C1: ago(DAY / 2 + 60_000) }) }).reason).toBe('new');
    expect(plan({ state: s, summary: summary({ C1: ago(HOUR) }) }).reason).toBe('new');
  });

  it('treats a conversation missing from the summary as unchanged (closed in the sidebar)', () => {
    expect(plan({ summary: summary({ OTHER: ago(HOUR) }) }).reason).toBe('unchanged');
  });

  it('never reads less because Slack reports an older newest message (the newest was deleted)', () => {
    expect(plan({ summary: summary({ C1: ago(9 * DAY) }) }).reason).toBe('unchanged');
  });
});

describe('isDue / phaseOf', () => {
  it('comes due once per interval, at a time of day set by the phase', () => {
    for (const phase of [0, 5 * HOUR, 23 * HOUR]) {
      const boundary = Math.ceil((NOW - phase) / DAY) * DAY + phase; // the next one after NOW
      expect(isDue(NOW, boundary - 1, DAY, phase)).toBe(false);
      expect(isDue(NOW, boundary, DAY, phase)).toBe(true);
      expect(isDue(NOW - DAY, NOW, DAY, phase)).toBe(true); // a whole interval always passes one
    }
    expect(isDue(NOW + HOUR, NOW, DAY, 0)).toBe(true); // clock moved back: read rather than wait
  });

  it('spreads re-reads across the interval instead of one big sync a day', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `C${(i * 7919).toString(36).toUpperCase()}X`);
    const last = NOW - 60_000; // all read together a minute ago
    const duePerSync = [1, 2, 3, 4].map(
      (k) => ids.filter((id) => isDue(last, last + k * 6 * HOUR, DAY, phaseOf(id, DAY))).length,
    );
    // Every 6-hour sync takes roughly a quarter more; after a day all of them came due.
    expect(duePerSync[0]).toBeGreaterThan(60);
    expect(duePerSync[0]).toBeLessThan(140);
    expect(duePerSync[3]).toBe(ids.length);
    expect(new Set(ids.map((id) => phaseOf(id, DAY))).size).toBeGreaterThan(390);
    expect(phaseOf('C1', DAY)).toBe(phaseOf('C1', DAY));
  });
});

describe('parseActivitySummary', () => {
  it('reads channels, DMs and group DMs; "0000000000.000000" means no messages', () => {
    const parsed = parseActivitySummary({
      ok: true,
      channels: [{ id: 'C1', latest: '1790000000.000100', last_read: '1790000000.000100', has_unreads: false }],
      ims: [{ id: 'D1', latest: '0000000000.000000' }],
      mpims: [{ id: 'G1', latest: '1780000000.123456' }],
      threads: { has_unreads: false },
    });
    expect(parsed).toEqual(
      new Map([
        ['C1', '1790000000.000100'],
        ['D1', null],
        ['G1', '1780000000.123456'],
      ]),
    );
  });

  it('trusts nothing in an answer it doesn’t fully understand', () => {
    expect(parseActivitySummary(null)).toBeNull();
    expect(parseActivitySummary({ ok: true })).toBeNull();
    expect(parseActivitySummary({ ok: true, channels: [] })).toBeNull();
    expect(parseActivitySummary({ ok: true, channels: [{ id: 'C1', latest: 1790000000 }] })).toBeNull();
    expect(parseActivitySummary({ ok: true, channels: [{ id: 'C1' }] })).toBeNull();
    expect(parseActivitySummary({ ok: true, channels: [{ id: 'C1', latest: 'soon' }] })).toBeNull();
  });
});

describe('summaryMissed', () => {
  const s = summary({ C1: ago(3 * DAY) });

  it('flags a plain message the summary should have reported', () => {
    expect(summaryMissed(s, 'C1', ago(3 * DAY), ago(HOUR))).toBe(true);
    expect(summaryMissed(s, 'MISSING', ago(3 * DAY), ago(HOUR))).toBe(true);
  });

  it('ignores messages posted around the time Slack was asked, and nothing new', () => {
    expect(summaryMissed(s, 'C1', ago(3 * DAY), ago(60_000))).toBe(false);
    expect(summaryMissed(s, 'C1', ago(3 * DAY), ago(3 * DAY))).toBe(false);
    expect(summaryMissed(s, 'C1', ago(3 * DAY), null)).toBe(false);
  });

  it('only plain top-level messages count (joins or broadcasts might not move the summary)', () => {
    expect(isPlainMessage({ ts: '1.1', text: 'hi' })).toBe(true);
    expect(isPlainMessage({ ts: '1.1', subtype: 'bot_message' })).toBe(true);
    expect(isPlainMessage({ ts: '1.1', subtype: 'channel_join' })).toBe(false);
    expect(isPlainMessage({ ts: '1.2', thread_ts: '1.1', subtype: 'thread_broadcast' })).toBe(false);
    expect(isPlainMessage({ ts: '1.1', thread_ts: '1.1', reply_count: 2 })).toBe(true);
  });
});
