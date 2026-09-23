/**
 * Working time, as My style counts it: the hours between `start` and `end` on the chosen weekdays,
 * in one time zone, less each person's days off. Reply times run on this clock, so a question
 * asked on Friday at 18:00 and answered on Monday at 09:15 waited 45 minutes (with 09:00–18:30,
 * Monday to Friday), not two and a half days.
 *
 * Days are keyed "YYYY-MM-DD" in the calendar's time zone. Each day's opening and closing
 * instants are worked out from the zone's own offset that day, so a daylight-saving change moves
 * them with the clocks.
 */

export interface WorkHours {
  /** Weekdays counted, 0 = Sunday … 6 = Saturday. */
  days: readonly number[];
  /** Minutes after midnight, start < end. */
  start: number;
  end: number;
  /** IANA zone. */
  timeZone: string;
}

/** Days off per person: user id → day keys. */
export type DaysOffMap = ReadonlyMap<string, ReadonlySet<string>>;

interface LocalDay {
  weekday: number;
  /** Epoch seconds when the working hours begin and end that day. */
  open: number;
  close: number;
}

/** Days walked at most for one span: a year, however long a wait was. */
const MAX_DAYS_WALKED = 400;

/**
 * Offsets are looked up once per quarter of an hour: zones change their offset only on such
 * boundaries (every offset in use is a multiple of 15 minutes), and Intl is slow per call.
 */
const OFFSET_BUCKET_SECONDS = 900;

export class WorkCalendar {
  private readonly fmt: Intl.DateTimeFormat;
  private readonly days: ReadonlySet<number>;
  private readonly dayCache = new Map<string, LocalDay>();
  private readonly offsetCache = new Map<number, number>();

  constructor(
    readonly hours: WorkHours,
    private readonly daysOff: DaysOffMap = new Map(),
  ) {
    this.fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: hours.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    this.days = new Set(hours.days);
  }

  /** Working seconds in one full day. */
  get dayLength(): number {
    return (this.hours.end - this.hours.start) * 60;
  }

  /** The local day an instant falls on, and the seconds since its midnight. */
  local(t: number): { day: string; seconds: number } {
    const wall = new Date((Math.floor(t) + this.offset(t)) * 1000);
    return {
      day: `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`,
      seconds: wall.getUTCHours() * 3600 + wall.getUTCMinutes() * 60 + wall.getUTCSeconds(),
    };
  }

  dayKey(t: number): string {
    return this.local(t).day;
  }

  /** The local day after `day`. */
  static nextDay(day: string): string {
    const [y, m, d] = day.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  }

  /** Whether `day` is a working day for `user` (a counted weekday that isn't one of their days off). */
  isWorkingDay(user: string, day: string): boolean {
    return this.days.has(this.localDay(day).weekday) && !this.daysOff.get(user)?.has(day);
  }

  /** A message sent at `t` counts for whoever should answer it only on their working day. */
  counts(user: string, t: number): boolean {
    return this.isWorkingDay(user, this.dayKey(t));
  }

  /**
   * Working seconds between `a` and `b` for `user`: the parts of their working days' hours that
   * fall in between. Stops early once past `max`.
   */
  between(user: string, a: number, b: number, max = Infinity): number {
    if (b <= a) return 0;
    let total = 0;
    let day = this.dayKey(a);
    for (let walked = 0; walked < MAX_DAYS_WALKED; walked++) {
      const d = this.localDay(day);
      if (d.open >= b) break;
      if (this.isWorkingDay(user, day)) {
        const from = Math.max(a, d.open);
        const to = Math.min(b, d.close);
        if (to > from) total += to - from;
        if (total > max) break;
      }
      day = WorkCalendar.nextDay(day);
    }
    return total;
  }

  private localDay(day: string): LocalDay {
    let d = this.dayCache.get(day);
    if (!d) {
      const [y, m, dd] = day.split('-').map(Number);
      d = {
        weekday: new Date(Date.UTC(y, m - 1, dd)).getUTCDay(),
        open: this.instant(y, m, dd, this.hours.start),
        close: this.instant(y, m, dd, this.hours.end),
      };
      this.dayCache.set(day, d);
    }
    return d;
  }

  /** Epoch seconds of a local wall-clock time (minutes after midnight) on a local date. */
  private instant(y: number, m: number, d: number, minutes: number): number {
    const wall = Date.UTC(y, m - 1, d, 0, minutes) / 1000;
    let t = wall - this.offset(wall);
    // Near a daylight-saving change the first guess can land on the other side of it.
    const second = wall - this.offset(t);
    if (second !== t) t = second;
    return t;
  }

  /** The zone's offset from UTC at an instant, in seconds. */
  private offset(t: number): number {
    const bucket = Math.floor(t / OFFSET_BUCKET_SECONDS);
    let offset = this.offsetCache.get(bucket);
    if (offset === undefined) {
      const at = bucket * OFFSET_BUCKET_SECONDS;
      const p = this.parts(at);
      offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - at;
      this.offsetCache.set(bucket, offset);
    }
    return offset;
  }

  private parts(t: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
    const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
    for (const part of this.fmt.formatToParts(new Date(Math.floor(t) * 1000))) {
      if (part.type in out) out[part.type as keyof typeof out] = Number(part.value);
    }
    return out;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** A zone name Intl knows ("Europe/Amsterdam", "UTC"). */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
