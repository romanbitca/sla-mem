/**
 * My style's words: how waits, working hours, periods and the writing checks read on the page.
 * Main sends numbers (StyleDTO); everything said about them is here.
 */
import type {
  ConversationDTO,
  DaysOffSourceDTO,
  ReplyPeriodDTO,
  StyleCheckDTO,
  StyleCheckId,
  StyleDTO,
  WorkHoursDTO,
} from '../../shared/types';

// ─── waits ───────────────────────────────────────────────────────────────────────────────────

/** "under a minute", "12 min", "1 h 05 min", "26 h". */
export function formatWait(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 10 || m === 0) return `${h} h`;
  return `${h} h ${String(m).padStart(2, '0')} min`;
}

/** The same, compact: "<1m", "12m", "1h 05m". */
export function formatWaitShort(seconds: number): string {
  if (seconds < 60) return '<1m';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 || h >= 10 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}

export function percent(count: number, total: number): string {
  return total > 0 ? `${Math.round((count / total) * 100)}%` : '–';
}

// ─── working hours ───────────────────────────────────────────────────────────────────────────

/** Monday first, the way the week reads at work. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon–Thu", "Sun–Thu", "Mon, Wed, Fri", "every day". */
export function daysLabel(days: readonly number[]): string {
  const set = new Set(days);
  if (set.size === 7) return 'every day';
  // Monday first, unless a run of days goes on from Sunday into Monday: then it starts where it starts.
  let order: number[] = [...WEEK_ORDER];
  if (set.has(0) && set.has(1)) {
    const lastGap = order.findLastIndex((d) => !set.has(d));
    order = [...order.slice(lastGap + 1), ...order.slice(0, lastGap + 1)];
  }
  const runs: number[][] = [];
  let previous = -1;
  for (const [i, d] of order.entries()) {
    if (!set.has(d)) continue;
    if (previous === i - 1 && runs.length) runs[runs.length - 1].push(d);
    else runs.push([d]);
    previous = i;
  }
  return runs
    .map((r) =>
      r.length >= 3 ? `${DAY_SHORT[r[0]]}–${DAY_SHORT[r[r.length - 1]]}` : r.map((d) => DAY_SHORT[d]).join(', '),
    )
    .join(', ');
}

/** 540 → "09:00". */
export function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** "09:00" → 540; null when it isn't a time. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 24 && min < 60 && h * 60 + min <= 24 * 60 ? h * 60 + min : null;
}

/** "Europe/Amsterdam" → "Amsterdam"; "UTC" stays. */
export function zoneCity(zone: string): string {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
}

/** "Mon–Thu, 09:00–20:30 Amsterdam time". */
export function hoursLabel(hours: Pick<WorkHoursDTO, 'days' | 'start' | 'end'> & { timeZone: string }): string {
  return `${daysLabel(hours.days)}, ${clock(hours.start)}–${clock(hours.end)} ${zoneCity(hours.timeZone)} time`;
}

/**
 * The channels most days off came from, as "#name": a single "I'm off today" somewhere else isn't
 * worth naming (at least 3 days, and 5% of all of them).
 */
export function daysOffChannels(
  sources: readonly DaysOffSourceDTO[],
  conversation: (id: string) => ConversationDTO | undefined,
): string[] {
  const total = sources.reduce((n, s) => n + s.days, 0);
  return sources
    .filter((s) => s.days >= Math.max(3, total * 0.05))
    .map((s) => conversation(s.conversationId))
    .filter((c): c is ConversationDTO => c != null && (c.type === 'channel' || c.type === 'private_channel'))
    .slice(0, 3)
    .map((c) => `#${c.label}`);
}

// ─── periods ─────────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number);
  return [y, m, d];
}

/** "Week of 15 Sep", "September 2026". */
export function periodLabel(period: ReplyPeriodDTO, unit: 'week' | 'month'): string {
  const [y, m, d] = parts(period.start);
  if (unit === 'month')
    return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${y}`;
  return `Week of ${d} ${MONTHS[m - 1]}`;
}

/** Under the chart's ends: "15 Sep", "Sep". */
export function periodAxis(period: ReplyPeriodDTO, unit: 'week' | 'month'): string {
  const [y, m, d] = parts(period.start);
  if (unit === 'month') return `${MONTHS[m - 1]}${m === 1 ? ` ${y}` : ''}`;
  return `${d} ${MONTHS[m - 1]}`;
}

/** Leading periods without answers go: the chart starts where your answers do. */
export function trimLeadingEmpty(periods: readonly ReplyPeriodDTO[]): ReplyPeriodDTO[] {
  const first = periods.findIndex((p) => p.count > 0);
  return first < 0 ? [] : periods.slice(first);
}

// ─── the checks ──────────────────────────────────────────────────────────────────────────────

export interface CheckCopy {
  title: string;
  /** The numbers in a few words, next to the title. */
  stat: string;
  /** What it means for you, a sentence. */
  detail: string;
}

const word = (w: { word: string; count: number }) => `“${w.word}” ${w.count}×`;

export function checkCopy(c: StyleCheckDTO): CheckCopy {
  const pct = percent(c.count, c.total);
  switch (c.id) {
    case 'capitals': {
      const words = c.words.slice(0, 3).map(word).join(' · ');
      return {
        title: 'Capital letters and apostrophes',
        stat: c.good ? 'Well done' : `${pct} start small`,
        detail: c.good
          ? 'Your sentences start with a capital and keep their apostrophes.'
          : `${pct} of your messages start with a small letter${words ? `; ${words}` : ''}. Start sentences with a capital, write “I” for “i”, and keep the apostrophe in “I'm” and “don't”.`,
      };
    }
    case 'oneMessage':
      return {
        title: 'One message instead of several',
        stat: c.good ? 'Well done' : `${c.count} times`,
        detail: c.good
          ? 'You usually say what you have to say in one message.'
          : `${c.count} times you sent three or more messages in a row. Each one is a separate notification: write the whole thought, then send it once.`,
      };
    case 'please':
      return {
        title: '“Please” when you ask',
        stat: pct,
        detail: c.good
          ? `${pct} of your “can you …” requests say please or “could you”.`
          : `Only ${pct} of your “can you …” requests say please. “Could you please …” asks the same, more kindly.`,
      };
    case 'casual': {
      const words = c.words.slice(0, 3).map(word).join(' · ');
      return {
        title: 'Casual words',
        stat: c.good ? 'Rarely' : `${c.count} times`,
        detail: c.good
          ? 'You rarely use slang in work chats.'
          : `${words}. In work chats “yes”, “going to” and a name read better.`,
      };
    }
    case 'greeting': {
      const warm = c.words.find((w) => w.word === 'how are you')?.count ?? 0;
      return {
        title: 'A hello when you start a chat',
        stat: pct,
        detail: `${pct} of the chats you start open with a greeting${warm ? `, and ${warm} ask how they are` : ''}.${
          c.good ? '' : ' Open with a hello and their name; asking how they are now and then goes a long way.'
        }`,
      };
    }
    case 'greetAndAsk':
      return {
        title: 'Hello and your question together',
        stat: c.good ? 'Well done' : `${c.count} times`,
        detail: c.good
          ? 'Your first message usually says what you need, so people can answer right away.'
          : `${c.count} times you only said hello and waited. Put the question in the same message, so they can answer right away.`,
      };
  }
}

/** How each check reads in the summary: as something you do, or something to try. */
const HABIT: Record<StyleCheckId, string> = {
  capitals: 'write in full sentences',
  oneMessage: 'say it in one message',
  please: 'say please',
  casual: 'keep slang out',
  greeting: 'greet people',
  greetAndAsk: 'ask right away',
};
const TRY: Record<StyleCheckId, string> = {
  capitals: 'capital letters and apostrophes',
  oneMessage: 'one message instead of several',
  please: '“please” in requests',
  casual: 'fewer casual words',
  greeting: 'a hello when you start a chat',
  greetAndAsk: 'your question in the first message',
};

export const TONE_LABEL: Record<NonNullable<StyleDTO['tone']>, string> = {
  professional: 'Professional and friendly',
  friendly: 'Friendly, but casual',
  polished: 'Professional, but brief',
  casual: 'Casual',
};

/** "You already greet people and say please. Capital letters and apostrophes … would make …" */
export function toneSentence(checks: readonly StyleCheckDTO[]): string {
  const good = checks.filter((c) => c.good).map((c) => HABIT[c.id]);
  const tips = checks
    .filter((c) => !c.good)
    .slice(0, 3)
    .map((c) => TRY[c.id]);
  const parts: string[] = [];
  if (good.length) parts.push(`You already ${joinAnd(good)}.`);
  if (tips.length) {
    const list = joinAnd(tips);
    parts.push(`${list[0].toUpperCase()}${list.slice(1)} would make you sound more professional.`);
  } else if (good.length) {
    parts.push('Keep it up.');
  }
  return parts.join(' ');
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
