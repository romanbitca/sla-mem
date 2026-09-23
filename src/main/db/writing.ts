/**
 * My style's writing checks: habits that make work messages read as professional, counted over
 * everything you wrote (notes to yourself aside), each with one of your own messages as it is
 * and as it could read.
 *
 *  - capitals: sentences start with a capital, "I" not "i", "I'm" not "im" (English messages);
 *  - greetAndAsk: a conversation opened with only "Hi, how are you?", the question left for later;
 *  - greeting: conversations you start (a DM or group DM after 3 quiet hours) open with a hello;
 *  - please: "can you …" requests say please (or "could you");
 *  - oneMessage: three or more messages in a row within a minute each, instead of one;
 *  - casual: "yeah", "gonna", "pls", "thanks man" (English messages).
 *
 * A check needs enough to go on (MIN_*); without it, it is left out rather than guessed.
 */
import type { ConversationType, StyleCheckDTO, StyleCheckId, StyleExampleDTO } from '../../shared/types';
import { listUsers, notesToSelfId } from './read';
import { stmt } from './stmt';
import {
  askPolitely,
  asksAfterThem,
  casualWords,
  hasWords,
  isEnglish,
  isGreetingOnly,
  isPlainRequest,
  isPolite,
  isReplaceable,
  joinMessages,
  missingApostrophes,
  polish,
  prose,
  readable,
  smallIs,
  startsSmall,
  startsWithGreeting,
  withGreeting,
  withoutCasual,
} from './style-text';
import type { DB } from './types';

/** A DM or group DM quiet this long before your message: you are starting a conversation. */
export const OPENER_QUIET_SECONDS = 3 * 3600;
/** Your latest messages read: plenty to judge habits by, and quick in any archive. */
export const WRITING_MESSAGES = 5_000;
/** Messages this close together (and in the same place) are one burst. */
export const BURST_GAP_SECONDS = 60;
export const BURST_MIN = 3;
/** Examples are recent messages of a readable length. */
export const EXAMPLE_DAYS = 120;

/**
 * When a check counts as a habit: percentages, or counts per 100 of the messages it reads. The
 * page's explanations show these same numbers (StyleDTO.rules).
 */
export const HABITS = {
  smallStarts: 20,
  smallIPer100: 2,
  apostrophesPer100: 2,
  greeting: 80,
  helloOnly: 5,
  please: 50,
  runsPer100: 1.5,
  casualPer100: 1,
  friendlyGreeting: 60,
  friendlyPlease: 50,
} as const;
const H = HABITS;
const EXAMPLE_MAX_CHARS = 220;
/** A hello-only opener's question: your next message there within this long. */
const FOLLOW_UP_SECONDS = 2 * 3600;

const MIN_OPENERS = 5;
const MIN_ENGLISH = 10;
const MIN_REQUESTS = 5;
const MIN_MESSAGES = 20;

interface MineRow {
  id: number;
  conversation_id: string;
  ts: string;
  time: number;
  thread_ts: string | null;
  is_reply: number;
  text: string;
  has_links: number;
}

interface Mine extends MineRow {
  type: ConversationType;
  dm_user_id: string | null;
  prose: string;
  english: boolean;
}

export interface WritingResult {
  /** Your messages read (at most WRITING_MESSAGES). */
  messageCount: number;
  englishCount: number;
  firstTime: number | null;
  checks: StyleCheckDTO[];
  tone: 'professional' | 'friendly' | 'polished' | 'casual' | null;
}

export function writingChecks(db: DB, self: string, opts: { now?: number; limit?: number } = {}): WritingResult {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  // Newest first down the author index, stopping at the limit (joined to conversations, SQLite
  // sorted everything they ever wrote: 250 ms for 155k messages); notes to yourself left out.
  const rows = stmt<MineRow>(
    db,
    `SELECT id, conversation_id, ts, time, thread_ts, is_reply, text, has_links FROM messages
     WHERE user_id = ? AND (subtype IS NULL OR subtype = 'thread_broadcast') AND is_deleted = 0 AND conversation_id <> ?
     ORDER BY time DESC LIMIT ?`,
  )
    .all(self, notesToSelfId(db) ?? '', opts.limit ?? WRITING_MESSAGES)
    .reverse();
  const places = conversationTypes(db);
  const mine: Mine[] = rows.map((r) => {
    const p = prose(r.text);
    const place = places.get(r.conversation_id);
    return {
      ...r,
      type: place?.type ?? 'channel',
      dm_user_id: place?.dm_user_id ?? null,
      prose: p,
      english: hasWords(p) && isEnglish(p),
    };
  });
  const english = mine.filter((m) => m.english);
  const people = labels(db);
  const exampleSince = now - EXAMPLE_DAYS * 86400;
  const ctx: Ctx = { db, self, people, exampleSince };

  const openers = findOpeners(db, mine);
  const checks = [
    capitals(ctx, english),
    greetAndAsk(ctx, mine, openers),
    greeting(ctx, openers),
    please(ctx, english),
    oneMessage(ctx, mine),
    casual(ctx, english),
  ].filter((c): c is ScoredCheck => c != null);

  return {
    messageCount: mine.length,
    englishCount: english.length,
    firstTime: mine[0]?.time ?? null,
    checks: checks
      .sort((a, b) => Number(a.check.good) - Number(b.check.good) || b.severity - a.severity)
      .map((c) => c.check),
    tone: tone(checks),
  };
}

interface Ctx {
  db: DB;
  self: string;
  people: Map<string, { label: string; first: string }>;
  exampleSince: number;
}

interface ScoredCheck {
  check: StyleCheckDTO;
  /** How far from a habit, for ordering tips: 0 is at the line. */
  severity: number;
}

function scored(
  id: StyleCheckId,
  count: number,
  total: number,
  good: boolean,
  severity: number,
  example: StyleExampleDTO | null,
  words: { word: string; count: number }[] = [],
): ScoredCheck {
  return { check: { id, good, count, total, words, example: good ? null : example }, severity };
}

// ─── capitals and apostrophes ────────────────────────────────────────────────────────────────

function capitals(ctx: Ctx, english: Mine[]): ScoredCheck | null {
  if (english.length < MIN_ENGLISH) return null;
  let small = 0;
  let is = 0;
  const apostrophes = new Map<string, number>();
  let best: { m: Mine; fixes: number } | null = null;
  for (const m of english) {
    // "@Ana can you check" reads on after the name: only a sentence that starts on its own counts.
    const startSmall = !/^\s*<@/.test(m.text) && startsSmall(m.prose);
    const iCount = smallIs(m.prose);
    const missing = missingApostrophes(m.prose);
    if (startSmall) small++;
    is += iCount;
    for (const w of missing) apostrophes.set(w, (apostrophes.get(w) ?? 0) + 1);
    const fixes = Number(startSmall) + iCount + missing.length;
    if (fixes > 0 && exampleWorthy(ctx, m) && (!best || fixes >= best.fixes)) best = { m, fixes };
  }
  const missingTotal = [...apostrophes.values()].reduce((a, b) => a + b, 0);
  const n = english.length;
  const good =
    small <= (H.smallStarts / 100) * n &&
    is <= (H.smallIPer100 / 100) * n &&
    missingTotal <= (H.apostrophesPer100 / 100) * n;
  const words = [{ word: 'i', count: is }, ...sortedWords(apostrophes)].filter((w) => w.count > 0);
  return scored(
    'capitals',
    small,
    n,
    good,
    (small * 100) / n / H.smallStarts +
      (is * 100) / n / H.smallIPer100 / 4 +
      (missingTotal * 100) / n / H.apostrophesPer100 / 4,
    best ? example(ctx, [best.m], polish(best.m.text)) : null,
    words,
  );
}

// ─── conversations you start ─────────────────────────────────────────────────────────────────

/** Your first message in a DM or group DM after a quiet spell. */
function findOpeners(db: DB, mine: Mine[]): Mine[] {
  // The message just before, through the (conversation_id, ts) key: one row read.
  const before = stmt<{ time: number }>(
    db,
    'SELECT time FROM messages WHERE conversation_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1',
  );
  return mine.filter((m) => {
    if ((m.type !== 'im' && m.type !== 'mpim') || m.is_reply === 1 || !hasWords(m.prose)) return false;
    const last = before.get(m.conversation_id, m.ts)?.time;
    return last == null || m.time - last >= OPENER_QUIET_SECONDS;
  });
}

function greeting(ctx: Ctx, openers: Mine[]): ScoredCheck | null {
  if (openers.length < MIN_OPENERS) return null;
  const greeted = openers.filter((m) => startsWithGreeting(m.prose)).length;
  const share = greeted / openers.length;
  const missing = [...openers]
    .reverse()
    .find((m) => !startsWithGreeting(m.prose) && m.english && exampleWorthy(ctx, m));
  const name = missing
    ? missing.type === 'im'
      ? (ctx.people.get(missing.dm_user_id ?? '')?.first ?? null)
      : 'all'
    : null;
  return scored(
    'greeting',
    greeted,
    openers.length,
    atLeast(greeted, openers.length, H.greeting),
    (H.greeting - share * 100) / H.greeting,
    missing ? example(ctx, [missing], withGreeting(missing.text, name)) : null,
    [{ word: 'how are you', count: openers.filter((m) => asksAfterThem(m.prose)).length }],
  );
}

function greetAndAsk(ctx: Ctx, mine: Mine[], openers: Mine[]): ScoredCheck | null {
  if (openers.length < MIN_OPENERS) return null;
  const helloOnly = openers.filter((m) => m.prose.length <= 120 && isGreetingOnly(m.prose));
  const allowed = Math.max(1, (H.helloOnly / 100) * openers.length);
  const good = helloOnly.length <= allowed;
  const position = new Map(mine.map((m, i) => [m.id, i]));
  let shown: StyleExampleDTO | null = null;
  for (const m of [...helloOnly].reverse()) {
    if (m.time < ctx.exampleSince) break;
    // Your next message there (mine is in time order): the question the hello left for later.
    let next: Mine | undefined;
    for (
      let i = (position.get(m.id) ?? mine.length) + 1;
      i < mine.length && mine[i].time - m.time <= FOLLOW_UP_SECONDS;
      i++
    ) {
      const n = mine[i];
      if (
        n.conversation_id === m.conversation_id &&
        hasWords(n.prose) &&
        !(n.prose.length <= 120 && isGreetingOnly(n.prose))
      ) {
        next = n;
        break;
      }
    }
    if (!next || next.text.length > EXAMPLE_MAX_CHARS) continue;
    shown = example(ctx, [m, next], joinMessages([m.text, next.text]));
    break;
  }
  if (!shown && helloOnly.length) {
    const last = helloOnly[helloOnly.length - 1];
    shown = example(ctx, [last], null);
  }
  return scored('greetAndAsk', helloOnly.length, openers.length, good, helloOnly.length / allowed / 4, shown);
}

// ─── requests ────────────────────────────────────────────────────────────────────────────────

function please(ctx: Ctx, english: Mine[]): ScoredCheck | null {
  const requests = english.filter((m) => isPlainRequest(m.prose));
  if (requests.length < MIN_REQUESTS) return null;
  const polite = requests.filter((m) => isPolite(m.prose)).length;
  const share = polite / requests.length;
  const blunt = [...requests].reverse().find((m) => !isPolite(m.prose) && exampleWorthy(ctx, m));
  return scored(
    'please',
    polite,
    requests.length,
    atLeast(polite, requests.length, H.please),
    (H.please - share * 100) / H.please,
    blunt ? example(ctx, [blunt], askPolitely(blunt.text)) : null,
  );
}

// ─── several messages in a row ───────────────────────────────────────────────────────────────

function oneMessage(ctx: Ctx, mine: Mine[]): ScoredCheck | null {
  if (mine.length < MIN_MESSAGES) return null;
  const runs: Mine[][] = [];
  let run: Mine[] = [];
  const place = (m: Mine) => `${m.conversation_id}:${m.is_reply ? m.thread_ts : ''}`;
  for (const m of mine) {
    const prev = run[run.length - 1];
    if (prev && place(prev) === place(m) && m.time - prev.time <= BURST_GAP_SECONDS) run.push(m);
    else {
      if (run.length >= BURST_MIN) runs.push(run);
      run = [m];
    }
  }
  if (run.length >= BURST_MIN) runs.push(run);
  const perHundred = (runs.length / mine.length) * 100;
  const good = perHundred <= H.runsPer100;
  const shown = [...runs]
    .reverse()
    .find(
      (r) =>
        r[0].time >= ctx.exampleSince &&
        r.length <= 5 &&
        r.every((m) => hasWords(m.prose) && m.has_links === 0 && !m.text.includes('`')) &&
        r.reduce((n, m) => n + m.text.length, 0) <= EXAMPLE_MAX_CHARS * 1.5,
    );
  return scored(
    'oneMessage',
    runs.length,
    mine.length,
    good,
    perHundred / H.runsPer100 / 3,
    shown ? example(ctx, shown, joinMessages(shown.map((m) => m.text))) : null,
  );
}

// ─── casual words ────────────────────────────────────────────────────────────────────────────

function casual(ctx: Ctx, english: Mine[]): ScoredCheck | null {
  if (english.length < MIN_ENGLISH) return null;
  const counts = new Map<string, number>();
  let shown: Mine | null = null;
  let shownReplaces = false;
  for (const m of english) {
    const words = casualWords(m.prose);
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    if (!words.length || !exampleWorthy(ctx, m)) continue;
    // The latest message with a word to swap ("yeah" → "yes") shows more than one losing a "haha".
    const replaces = words.some(isReplaceable);
    if (replaces || !shownReplaces) {
      shown = m;
      shownReplaces = replaces;
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const good = total <= (H.casualPer100 / 100) * english.length;
  return scored(
    'casual',
    total,
    english.length,
    good,
    (total * 100) / english.length / H.casualPer100 / 4,
    shown ? example(ctx, [shown], withoutCasual(shown.text)) : null,
    sortedWords(counts),
  );
}

// ─── the whole picture ───────────────────────────────────────────────────────────────────────

/** Friendly: you greet and say please. Polished: capitals, one message at a time, no slang. */
function tone(checks: ScoredCheck[]): WritingResult['tone'] {
  const by = new Map(checks.map((c) => [c.check.id, c.check]));
  const greeting = by.get('greeting');
  const please = by.get('please');
  const polish = ['capitals', 'oneMessage', 'casual'].map((id) => by.get(id as StyleCheckId)).filter((c) => c != null);
  if (!greeting && !please && polish.length === 0) return null;
  const friendly =
    (greeting != null && atLeast(greeting.count, greeting.total, H.friendlyGreeting)) ||
    (please != null && atLeast(please.count, please.total, H.friendlyPlease));
  const polished = polish.length > 0 && polish.every((c) => c.good);
  if (friendly) return polished ? 'professional' : 'friendly';
  return polished ? 'polished' : 'casual';
}

/** `count` of `total` is at least `percent`, in whole numbers (no rounding at the line). */
function atLeast(count: number, total: number, percent: number): boolean {
  return total > 0 && count * 100 >= percent * total;
}

// ─── examples ────────────────────────────────────────────────────────────────────────────────

/** Recent, short, and plain enough to read out of context: no links, code or quotes. */
function exampleWorthy(ctx: Ctx, m: Mine): boolean {
  return (
    m.time >= ctx.exampleSince &&
    m.has_links === 0 &&
    m.text.length <= EXAMPLE_MAX_CHARS &&
    m.prose.length >= 12 &&
    !m.text.includes('`') &&
    !/^(?:>|&gt;)/m.test(m.text)
  );
}

function example(ctx: Ctx, messages: Mine[], after: string | null): StyleExampleDTO {
  const first = messages[0];
  const before = messages.map((m) => readable(m.text, labelsOnly(ctx))).join('\n');
  const rewritten = after == null ? null : readable(after, labelsOnly(ctx));
  return {
    before,
    after: rewritten && rewritten !== before ? rewritten : null,
    conversationId: first.conversation_id,
    ts: first.ts,
    threadTs: first.thread_ts,
    isReply: first.is_reply === 1,
  };
}

const labelMaps = new WeakMap<Ctx['people'], Map<string, string>>();
function labelsOnly(ctx: Ctx): Map<string, string> {
  let map = labelMaps.get(ctx.people);
  if (!map) {
    map = new Map([...ctx.people].map(([id, p]) => [id, p.label]));
    labelMaps.set(ctx.people, map);
  }
  return map;
}

function conversationTypes(db: DB): Map<string, { type: ConversationType; dm_user_id: string | null }> {
  return new Map(
    stmt<{ id: string; type: ConversationType; dm_user_id: string | null }>(
      db,
      'SELECT id, type, dm_user_id FROM conversations',
    )
      .all()
      .map((c) => [c.id, c]),
  );
}

/** Everyone's name as the app shows it, and their first name for a greeting. */
function labels(db: DB): Map<string, { label: string; first: string }> {
  const out = new Map<string, { label: string; first: string }>();
  for (const u of listUsers(db)) {
    const full = u.realName || u.label;
    const first = full.split(/\s+/)[0] || u.label;
    out.set(u.id, { label: u.label, first });
  }
  return out;
}

function sortedWords(counts: Map<string, number>): { word: string; count: number }[] {
  return [...counts]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}
