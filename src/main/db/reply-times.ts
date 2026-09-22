/**
 * How long questions and requests waited for an answer, on the working-hours clock
 * (work-calendar.ts), both ways: what people asked you (in a DM, or tagging you anywhere) and
 * what you asked them.
 *
 * A wait starts at the first message that asks something (looksLikeAsk, or a hello in a DM) and
 * ends at the answerer's next message there: in a DM or group DM, anything they write next; in a
 * channel, their reply in the thread or, for a top-level question, their next top-level message
 * within a day (the rules People uses for open questions). Several questions answered by one
 * message count once, from the first. Left out: questions that arrived on a day that isn't a
 * working day for the one asked (the other weekdays, their days off), answers after more than
 * MAX_WAIT_DAYS working days (by then rarely an answer to that), and questions never answered in
 * Slack.
 *
 * Only questions asked since `since` are read (a year, in getStyle): the query plans below keep
 * that quick in an archive of half a million messages.
 */
import type { ReplyPeriodDTO, ReplyPersonDTO, ReplyStatsDTO } from '../../shared/types';
import { addressedPart, looksLikeAsk, speaksTo } from './people';
import { stmt } from './stmt';
import { isGreetingOnly, prose } from './style-text';
import type { DB } from './types';
import { WorkCalendar } from './work-calendar';

export const MAX_WAIT_DAYS = 3;
/** A top-level question in a channel is answered by a top-level message this soon. */
const CHANNEL_ANSWER_SECONDS = 24 * 3600;
/** Fewer answers than this say little: no numbers are shown. */
export const MIN_ANSWERS = 5;
/** Bars in the chart: the last 12 weeks, or the last 12 months. */
export const PERIODS = 12;
/** People in each of the fastest and slowest lists, and the answers each needs to be ranked. */
export const RANKED = 10;
export const RANK_MIN_ANSWERS = 3;

export interface ReplySample {
  kind: 'dm' | 'mention';
  /** The other person: who asked (your answers), or who answered (answers to you). */
  who: string;
  /** When the question arrived (epoch seconds). */
  at: number;
  /** Working seconds until the answer. */
  waited: number;
}

export interface ReplyTimes {
  /** Your answers. */
  you: ReplySample[];
  /** Answers to you. */
  them: ReplySample[];
}

interface Asked {
  conversation_id: string;
  ts: string;
  time: number;
  thread_ts: string | null;
  user_id: string;
  text: string;
  type: string;
}

export function measureReplies(db: DB, self: string, cal: WorkCalendar, since = 0): ReplyTimes {
  const cap = MAX_WAIT_DAYS * cal.dayLength;
  const out: ReplyTimes = { you: [], them: [] };
  const humans = new Set(
    stmt<{ id: string }>(db, "SELECT id FROM users WHERE is_bot = 0 AND id <> 'USLACKBOT'")
      .all()
      .map((r) => r.id),
  );
  const record = (asker: string, answerer: string, at: number, answeredAt: number, kind: ReplySample['kind']) => {
    if (!cal.counts(answerer, at)) return;
    const waited = cal.between(answerer, at, answeredAt, cap);
    if (waited > cap) return;
    if (answerer === self) out.you.push({ kind, who: asker, at, waited });
    else out.them.push({ kind, who: answerer, at, waited });
  };

  // DMs: whoever asked waits for the other's next message.
  for (const dm of stmt<{ id: string; other: string }>(
    db,
    "SELECT id, dm_user_id AS other FROM conversations WHERE type = 'im' AND dm_user_id IS NOT NULL AND dm_user_id <> ?",
  ).all(self)) {
    if (!humans.has(dm.other)) continue;
    let waiting: { by: string; since: number | null } | null = null;
    // In time order through messages_conv_time; the two people are picked out here (a DM holds
    // little else), which keeps SQLite on that index.
    for (const m of stmt<{ user_id: string | null; time: number; text: string }>(
      db,
      `SELECT user_id, time, text FROM messages
       WHERE conversation_id = ? AND time >= ? AND (subtype IS NULL OR subtype = 'thread_broadcast') AND is_deleted = 0
       ORDER BY time`,
    ).all(dm.id, since)) {
      if (m.user_id !== self && m.user_id !== dm.other) continue;
      if (waiting && waiting.by !== m.user_id) {
        if (waiting.since != null) record(waiting.by, m.user_id, waiting.since, m.time, 'dm');
        waiting = null;
      }
      if (!waiting) waiting = { by: m.user_id, since: needsAnswer(m.text, true) ? m.time : null };
      else if (waiting.since == null && needsAnswer(m.text, true)) waiting.since = m.time;
    }
  }

  // Tagged: others' questions to you in channels and group DMs. Through the time index, the
  // conversation's kind checked here (joined, SQLite went channel by channel through every author).
  const kinds = new Map(
    stmt<{ id: string; type: string }>(db, 'SELECT id, type FROM conversations')
      .all()
      .map((c) => [c.id, c.type]),
  );
  const shared = (id: string) => {
    const kind = kinds.get(id);
    return kind === 'channel' || kind === 'private_channel' || kind === 'mpim';
  };
  const answered = new Set<string>();
  for (const row of stmt<Omit<Asked, 'type'>>(
    db,
    `SELECT conversation_id, ts, time, thread_ts, user_id, text FROM messages
     WHERE time >= ? AND user_id IS NOT NULL AND +user_id <> ?
       AND (subtype IS NULL OR subtype = 'thread_broadcast') AND is_deleted = 0
       AND (instr(text, ?) > 0 OR instr(text, ?) > 0)
     ORDER BY time`,
  ).all(since, self, `<@${self}>`, `<@${self}|`)) {
    if (!shared(row.conversation_id) || !humans.has(row.user_id)) continue;
    const m: Asked = { ...row, type: kinds.get(row.conversation_id)! };
    const part = addressedPart(m.text, self, false);
    if (!part || !needsAnswer(part.text, false)) continue;
    const at = firstAnswer(db, m, self);
    if (at == null) continue;
    // One answer to several questions is timed from the first.
    const key = `${self}:${m.conversation_id}:${at}`;
    if (answered.has(key)) continue;
    answered.add(key);
    record(m.user_id, self, m.time, at, 'mention');
  }

  // Yours, tagging others there: the first of them to answer.
  for (const row of stmt<Omit<Asked, 'type'>>(
    db,
    `SELECT conversation_id, ts, time, thread_ts, user_id, text FROM messages
     WHERE user_id = ? AND time >= ? AND (subtype IS NULL OR subtype = 'thread_broadcast') AND is_deleted = 0
       AND instr(text, '<@') > 0
     ORDER BY time`,
  ).all(self, since)) {
    if (!shared(row.conversation_id)) continue;
    const m: Asked = { ...row, type: kinds.get(row.conversation_id)! };
    let first: { who: string; at: number } | null = null;
    for (const who of speaksTo(m.text)) {
      if (who === self || !humans.has(who)) continue;
      const part = addressedPart(m.text, who, false);
      if (!part || !needsAnswer(part.text, false)) continue;
      const at = firstAnswer(db, m, who);
      if (at != null && (!first || at < first.at)) first = { who, at };
    }
    if (!first) continue;
    const key = `${first.who}:${m.conversation_id}:${first.at}`;
    if (answered.has(key)) continue;
    answered.add(key);
    record(self, first.who, m.time, first.at, 'mention');
  }
  return out;
}

/** A question or request; in a DM, a plain hello waits for an answer too. */
function needsAnswer(text: string, inDm: boolean): boolean {
  if (looksLikeAsk(text)) return true;
  if (!inDm) return false;
  const p = prose(text);
  return p.length <= 120 && isGreetingOnly(p);
}

/**
 * When `who` first answered `m` (epoch seconds), or null. Each lookup reads the first match in
 * index order (ORDER BY … LIMIT 1): as min(time), SQLite walked the whole conversation in time
 * order from its first message.
 */
function firstAnswer(db: DB, m: Asked, who: string): number | null {
  let first: number | null = null;
  const earliest = (at: number | undefined) => {
    if (at != null && (first == null || at < first)) first = at;
  };
  // Its thread: the one it is in, or the one under it (a parent without its thread_ts yet).
  earliest(
    stmt<{ time: number }>(
      db,
      `SELECT time FROM messages WHERE conversation_id = ? AND thread_ts = ? AND ts > ? AND +user_id = ? AND is_deleted = 0
       ORDER BY ts LIMIT 1`,
    ).get(m.conversation_id, m.thread_ts ?? m.ts, m.ts, who)?.time,
  );
  if (m.type === 'mpim') {
    // A small group: whatever they wrote next.
    earliest(
      stmt<{ time: number }>(
        db,
        `SELECT time FROM messages WHERE conversation_id = ? AND user_id = ? AND time >= ? AND ts > ? AND is_deleted = 0
         ORDER BY time LIMIT 1`,
      ).get(m.conversation_id, who, m.time, m.ts)?.time,
    );
  } else if (!m.thread_ts || m.thread_ts === m.ts) {
    earliest(
      stmt<{ time: number }>(
        db,
        `SELECT time FROM messages WHERE conversation_id = ? AND user_id = ? AND time >= ? AND time <= ? AND ts > ?
         AND (is_reply = 0 OR subtype = 'thread_broadcast') AND is_deleted = 0
         ORDER BY time LIMIT 1`,
      ).get(m.conversation_id, who, m.time, m.time + CHANNEL_ANSWER_SECONDS, m.ts)?.time,
    );
  }
  return first;
}

// ─── numbers ─────────────────────────────────────────────────────────────────────────────────

export function replyStats(samples: readonly ReplySample[]): ReplyStatsDTO | null {
  if (samples.length < MIN_ANSWERS) return null;
  const waits = samples.map((s) => s.waited).sort((a, b) => a - b);
  const buckets: [number, number, number, number] = [0, 0, 0, 0];
  for (const w of waits) buckets[w <= 15 * 60 ? 0 : w <= 3600 ? 1 : w <= 4 * 3600 ? 2 : 3]++;
  const part = (kind: ReplySample['kind']) => {
    const of = samples.filter((s) => s.kind === kind);
    return of.length ? { count: of.length, averageSeconds: Math.round(average(of.map((s) => s.waited))) } : null;
  };
  return {
    count: waits.length,
    averageSeconds: Math.round(average(waits)),
    medianSeconds: Math.round(median(waits)),
    buckets,
    dm: part('dm'),
    mentions: part('mention'),
  };
}

/**
 * Your average per week (Monday to Sunday) or per month, in the calendar's time zone: the last
 * PERIODS of them up to the one holding `now`, oldest first, empty ones included.
 */
export function replyPeriods(
  samples: readonly ReplySample[],
  cal: WorkCalendar,
  unit: 'week' | 'month',
  now: number,
): ReplyPeriodDTO[] {
  const startOf = (day: string) => (unit === 'month' ? `${day.slice(0, 7)}-01` : mondayOf(day));
  const starts: string[] = [startOf(cal.dayKey(now))];
  while (starts.length < PERIODS) starts.unshift(previous(starts[0], unit));
  const waits = new Map<string, number[]>(starts.map((s) => [s, []]));
  for (const s of samples) waits.get(startOf(cal.dayKey(s.at)))?.push(s.waited);
  return starts.map((start) => {
    const of = waits.get(start)!;
    return { start, count: of.length, averageSeconds: of.length ? Math.round(average(of)) : null };
  });
}

/**
 * The people you answer fastest and slowest, by your average, among those with at least
 * RANK_MIN_ANSWERS answers. With fewer than 2 × RANKED such people, they are split in two halves, so
 * nobody is on both lists.
 */
export function rankPeople(samples: readonly ReplySample[]): { fastest: ReplyPersonDTO[]; slowest: ReplyPersonDTO[] } {
  const byPerson = new Map<string, number[]>();
  for (const s of samples) {
    if (!byPerson.has(s.who)) byPerson.set(s.who, []);
    byPerson.get(s.who)!.push(s.waited);
  }
  const ranked = [...byPerson]
    .filter(([, waits]) => waits.length >= RANK_MIN_ANSWERS)
    .map(([userId, waits]) => ({ userId, count: waits.length, averageSeconds: Math.round(average(waits)) }))
    .sort((a, b) => a.averageSeconds - b.averageSeconds || b.count - a.count || a.userId.localeCompare(b.userId));
  const fast = Math.min(RANKED, Math.ceil(ranked.length / 2));
  const slow = Math.min(RANKED, ranked.length - fast);
  return { fastest: ranked.slice(0, fast), slowest: ranked.slice(ranked.length - slow).reverse() };
}

function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(d - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function previous(start: string, unit: 'week' | 'month'): string {
  const [y, m, d] = start.split('-').map(Number);
  const date = unit === 'week' ? new Date(Date.UTC(y, m - 1, d - 7)) : new Date(Date.UTC(y, m - 2, 1));
  return date.toISOString().slice(0, 10);
}

function average(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Of sorted numbers. */
function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export { WorkCalendar };
