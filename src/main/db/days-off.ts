/**
 * Days people were away, as far as the archive shows them. My style leaves these days out of
 * reply times: someone on leave obviously doesn't answer.
 *
 *  - Leave lists: a post saying who is away today, like 9H's bot every morning in #general
 *    ("The following people are on leave today: • *Ana Pop* (22/09/26 to 23/09/26) • …"). Each
 *    person named (or mentioned) is away for every day of their range, or on the post's day when
 *    it gives none. "I'm not on leave today" from someone on the list takes that day back.
 *  - "I'm off today" and the like, anywhere: its author is away that day.
 *  - Absence channels, named for it (#sick-leave, #ooo, #9h-sick-emergency-leave) and read like it
 *    (most posts say "unwell", "emergency", "offline"…): each post there is its author's notice
 *    ("not feeling well, will start later", "power cut", "back online"), so that day is theirs off;
 *    posted after working hours, it is about the next day.
 *
 * Leave lists are found through the search index, so this stays quick in any archive.
 */
import { stmt } from './stmt';
import type { DB } from './types';
import { WorkCalendar } from './work-calendar';

export interface DaysOff {
  /** User id → local day keys ("2026-09-22"). */
  byUser: Map<string, Set<string>>;
  /** Where days off were found, most first. */
  sources: { conversationId: string; kind: 'list' | 'notices'; days: number }[];
}

/** What finding days off needs from the calendar: local days, and when working hours end. */
export type DayKeys = Pick<WorkCalendar, 'local'> & { hours: { end: number } };

/** A leave range is taken at its word up to a year. */
const MAX_RANGE_DAYS = 366;

/** Channel names that say what the channel is for: sick-leave, ooo, out-of-office, pto, time-off… */
const ABSENCE_CHANNEL =
  /(?:^|[-_.])(?:sick|leaves?|absences?|absent|ooo|out-of-office|pto|vacations?|holidays?|time-?off|away|emergency)(?:$|[-_.])/i;

/** Posts that say who is away today (phrases, for the search index). */
const TODAY_PHRASES = [
  'on leave today',
  'off today',
  'out today',
  'away today',
  'absent today',
  'out of office today',
  'ooo today',
  'on holiday today',
  'on vacation today',
];
const NOT_AWAY_PHRASES = ['not on leave', 'not off', 'not away', 'not ooo', 'not out of office'];

/**
 * Words of an absence notice. A channel whose name says absence counts only when most of its posts
 * use them: "#holiday-campaign" is about work.
 */
const ABSENCE_WORDS =
  /\b(?:unwell|sick|ill|fever|flu|migraine|headache|pain|doctor|dentist|hospital|appointment|emergency|leave|day off|rest of the day|offline|online|on and off|in and out|power|internet|outage|late|later|feeling|ooo|out of office|pto|bbhr|bamboo)\b/i;
/** Share of a channel's posts that must read like notices. */
const NOTICE_SHARE = 0.5;

/** "I'm off today", "I will be on leave today", "I am out of office": the author is away. */
const SELF_AWAY =
  /\bI(?:\s*['’]?m|\s+am|\s+will\s+be|\s*['’]ll\s+be)\s+(?:\w+\s+){0,2}?(?:off|on\s+leave|out\s+of\s+(?:the\s+)?office|ooo|away|absent|on\s+holiday|on\s+vacation)\b/i;
const NOT_AWAY = /\bnot\s+(?:on\s+leave|off|away|ooo|out\s+of\s+(?:the\s+)?office)\b/i;

export function findDaysOff(db: DB, cal: DayKeys): DaysOff {
  const byUser = new Map<string, Set<string>>();
  const counts = new Map<string, { conversationId: string; kind: 'list' | 'notices'; days: number }>();
  const add = (user: string, day: string, conversationId: string, kind: 'list' | 'notices') => {
    let days = byUser.get(user);
    if (!days) byUser.set(user, (days = new Set()));
    if (days.has(day)) return;
    days.add(day);
    const key = `${conversationId}:${kind}`;
    const source = counts.get(key) ?? { conversationId, kind, days: 0 };
    source.days += 1;
    counts.set(key, source);
  };

  const names = nameIndex(db);
  const humans = humanIds(db);
  // Days a list put someone away, so a "not on leave" can take one back.
  const listed = new Map<string, { conversationId: string }>();

  for (const post of phrasePosts(db, TODAY_PHRASES)) {
    const postDay = cal.local(post.time).day;
    const entries = listEntries(post.text, names).filter((e) => e.userId !== post.user_id);
    if (entries.length) {
      for (const e of entries) {
        for (const day of rangeDays(e.range, postDay)) {
          add(e.userId, day, post.conversation_id, 'list');
          listed.set(`${e.userId}:${day}`, { conversationId: post.conversation_id });
        }
      }
    } else if (
      post.user_id &&
      humans.has(post.user_id) &&
      SELF_AWAY.test(post.plain_text) &&
      !NOT_AWAY.test(post.plain_text)
    ) {
      add(post.user_id, postDay, post.conversation_id, 'list');
    }
  }
  // "Hey, I'm not on leave today": the list was wrong about them.
  for (const post of phrasePosts(db, NOT_AWAY_PHRASES)) {
    if (!post.user_id || !NOT_AWAY.test(post.plain_text)) continue;
    const day = cal.local(post.time).day;
    const key = `${post.user_id}:${day}`;
    const from = listed.get(key);
    if (!from) continue;
    byUser.get(post.user_id)?.delete(day);
    listed.delete(key);
    const source = counts.get(`${from.conversationId}:list`);
    if (source) source.days -= 1;
  }

  const endOfDay = cal.hours.end * 60;
  for (const channel of stmt<{ id: string; name: string | null }>(
    db,
    "SELECT id, name FROM conversations WHERE type IN ('channel', 'private_channel')",
  ).all()) {
    if (!channel.name || !ABSENCE_CHANNEL.test(channel.name)) continue;
    const posts = stmt<{ user_id: string; time: number; plain_text: string }>(
      db,
      `SELECT user_id, time, plain_text FROM messages
       WHERE conversation_id = ? AND user_id IS NOT NULL AND is_deleted = 0
         AND (subtype IS NULL OR subtype = 'thread_broadcast') AND (is_reply = 0 OR subtype = 'thread_broadcast')`,
    )
      .all(channel.id)
      .filter((post) => humans.has(post.user_id));
    if (posts.filter((post) => ABSENCE_WORDS.test(post.plain_text)).length < posts.length * NOTICE_SHARE) continue;
    for (const post of posts) {
      const { day, seconds } = cal.local(post.time);
      add(post.user_id, seconds >= endOfDay ? WorkCalendar.nextDay(day) : day, channel.id, 'notices');
    }
  }

  const sources = [...counts.values()].filter((s) => s.days > 0).sort((a, b) => b.days - a.days);
  return { byUser, sources };
}

interface PostRow {
  conversation_id: string;
  user_id: string | null;
  time: number;
  text: string;
  plain_text: string;
}

/** Messages holding any of the phrases, through the search index. */
function phrasePosts(db: DB, phrases: readonly string[]): PostRow[] {
  const match = phrases.map((p) => `"${p}"`).join(' OR ');
  return stmt<PostRow>(
    db,
    `SELECT m.conversation_id, m.user_id, m.time, m.text, m.plain_text
     FROM messages_fts f JOIN messages m ON m.id = f.rowid
     WHERE messages_fts MATCH ? AND m.is_deleted = 0
     ORDER BY m.time`,
  ).all(match);
}

function humanIds(db: DB): Set<string> {
  return new Set(
    stmt<{ id: string }>(db, "SELECT id FROM users WHERE is_bot = 0 AND id <> 'USLACKBOT'")
      .all()
      .map((r) => r.id),
  );
}

// ─── leave lists ─────────────────────────────────────────────────────────────────────────────

interface ListEntry {
  userId: string;
  range: DateRange | null;
}

interface DateRange {
  from: [number, number, number];
  to: [number, number, number];
}

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/;
/** Where a name ends in an entry: "Ana Pop (…", "Ana Pop - …", "Ana Pop: …", "Ana Pop 22/09…". */
const NAME_END = /\s*(?:[(:–—]|\s-\s|\s(?:from|until|till|to)\s|\d).*$/s;
const DATE = String.raw`(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})`;
const RANGE = new RegExp(`${DATE}(?:\\s*(?:to|-|–|—|until|till|through)\\s*${DATE})?`);

/**
 * The people a leave list names, one per line, bullet or comma: by mention, or by a full name that
 * is exactly one person's in the directory ("Ana Pop (…)", "Ana Pop: …", or "Off today: Ana Pop").
 */
export function listEntries(text: string, names: ReadonlyMap<string, string>): ListEntry[] {
  const out: ListEntry[] = [];
  const seen = new Set<string>();
  for (const segment of text.split(/\n|[•◦▪●;,]|\band\b/)) {
    const mention = MENTION.exec(segment);
    let userId: string | null = mention ? mention[1] : null;
    if (!userId) {
      const plain = segment.replace(/[*_~`]/g, '');
      const afterHeader = plain.slice(plain.lastIndexOf(':') + 1);
      for (const candidate of [plain, afterHeader]) {
        const name = normalizeName(candidate.replace(NAME_END, ''));
        userId = name ? (names.get(name) ?? null) : null;
        if (userId) break;
      }
    }
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    out.push({ userId, range: parseRange(segment) });
  }
  return out;
}

function parseRange(segment: string): DateRange | null {
  const m = RANGE.exec(segment);
  if (!m) return null;
  const n = m.slice(1).map((v) => (v === undefined ? null : Number(v)));
  const from: [number, number, number] = [n[0]!, n[1]!, n[2]!];
  const to: [number, number, number] = n[3] != null ? [n[3], n[4]!, n[5]!] : from;
  return { from, to };
}

/**
 * The days a range covers. Numbers are read as day/month/year first, then month/day/year, then
 * year-month-day; the reading must include the day of the post, which says "today". Without a
 * range, or with one that never fits, the post's own day.
 */
export function rangeDays(range: DateRange | null, postDay: string): string[] {
  if (!range) return [postDay];
  for (const read of READINGS) {
    const from = read(range.from);
    const to = read(range.to);
    if (!from || !to || to < from || from > postDay || to < postDay) continue;
    const days: string[] = [];
    for (let day = from; day <= to && days.length < MAX_RANGE_DAYS; day = WorkCalendar.nextDay(day)) days.push(day);
    return days;
  }
  return [postDay];
}

type Reading = (n: [number, number, number]) => string | null;
const READINGS: Reading[] = [
  ([d, m, y]) => dayKey(fullYear(y), m, d),
  ([m, d, y]) => dayKey(fullYear(y), m, d),
  ([y, m, d]) => (y >= 1000 ? dayKey(y, m, d) : null),
];

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

function dayKey(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null; // 31/02
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Full names (real and display) that belong to exactly one person, normalized. */
function nameIndex(db: DB): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const u of stmt<{ id: string; real_name: string | null; display_name: string | null }>(
    db,
    "SELECT id, real_name, display_name FROM users WHERE is_bot = 0 AND id <> 'USLACKBOT'",
  ).all()) {
    for (const raw of [u.real_name, u.display_name]) {
      const name = raw ? normalizeName(raw) : '';
      // A single word ("Mark") could be anyone's: only full names identify someone.
      if (!name.includes(' ')) continue;
      if (!owners.has(name)) owners.set(name, new Set());
      owners.get(name)!.add(u.id);
    }
  }
  const out = new Map<string, string>();
  for (const [name, ids] of owners) if (ids.size === 1) out.set(name, [...ids][0]);
  return out;
}

export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' -]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
