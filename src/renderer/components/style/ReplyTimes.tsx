import { useMemo, useRef, useState, type RefObject } from 'react';
import clsx from 'clsx';
import type { StyleDTO, WorkHoursDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { useDirectory } from '../../lib/directory';
import { formatDate, joinNames, pluralize } from '../../lib/format';
import { useUpdatePreferences } from '../../lib/queries';
import { clock, daysLabel, formatWait, hoursLabel, parseClock, percent, WEEK_ORDER, zoneCity } from '../../lib/style';
import { tsToDate } from '../../lib/ts';
import { ClockIcon } from '../icons';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Dialog } from '../ui/Dialog';
import { ReplyChart } from './ReplyChart';

/**
 * How fast you answer questions and requests in DMs and where you're tagged, on working time only,
 * with how fast people answer yours, the trend by week or month, and which hours count.
 */
export function ReplyTimeCard({ style }: { style: StyleDTO }) {
  const you = style.you;
  return (
    <Card title="Reply time" icon={<ClockIcon size={15} />}>
      {you ? (
        <>
          <dl className="grid grid-cols-3 gap-3">
            <Figure label="On average" value={formatWait(you.averageSeconds)} />
            <Figure label="Half of your replies within" value={formatWait(you.medianSeconds)} />
            <Figure label="Within an hour" value={percent(you.buckets[0] + you.buckets[1], you.count)} />
          </dl>
          <p className="text-[13px] leading-relaxed text-ink-muted">
            From {pluralize(you.count, 'answer')} to questions and requests
            {you.dm && you.mentions
              ? ` (DMs ${formatWait(you.dm.averageSeconds)}, where you’re tagged ${formatWait(you.mentions.averageSeconds)})`
              : ''}
            .{' '}
            {style.them && (
              <>
                People answer yours in <span className="text-ink">{formatWait(style.them.averageSeconds)}</span> on
                average.
              </>
            )}
          </p>
          <ReplyChart weeks={style.weeks} months={style.months} />
        </>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Not enough answers yet: once people have asked you a few questions in DMs or tagged you, how quickly you
          answer shows here.
        </p>
      )}
      <HoursNote style={style} />
    </Card>
  );
}

/** The number above its label (the label comes first for screen readers). */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col-reverse rounded-xl border border-line bg-canvas px-3 py-2">
      <dt className="truncate text-xs text-ink-muted">{label}</dt>
      <dd className="truncate text-lg font-semibold tracking-tight text-ink tabular-nums">{value}</dd>
    </div>
  );
}

/** Which hours count, which days off were left out and where they were found; Change opens the hours. */
function HoursNote({ style }: { style: StyleDTO }) {
  const [editing, setEditing] = useState(false);
  const changeRef = useRef<HTMLButtonElement>(null);
  const { conversations } = useDirectory();
  // The channels most days off came from: a single "I'm off today" elsewhere isn't worth naming.
  const total = style.daysOffSources.reduce((n, s) => n + s.days, 0);
  const sources = style.daysOffSources
    .filter((s) => s.days >= Math.max(3, total * 0.05))
    .map((s) => conversations.get(s.conversationId))
    .filter((c) => c && (c.type === 'channel' || c.type === 'private_channel'))
    .slice(0, 3)
    .map((c) => `#${c!.label}`);
  const since = style.repliesSince ? formatDate(tsToDate(style.repliesSince), 'MMM d, yyyy') : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-line pt-3 text-xs leading-relaxed text-ink-faint">
      <p className="min-w-0 flex-1">
        Counted {hoursLabel(style.hours)}
        {since ? `, since ${since}` : ''}. Nights, other days and days off don’t count
        {style.yourDaysOff > 0 ? ` (${pluralize(style.yourDaysOff, 'day')} of yours` : ''}
        {style.yourDaysOff > 0 && sources.length ? `, from ${joinNames(sources)})` : style.yourDaysOff > 0 ? ')' : ''}.
      </p>
      <button
        ref={changeRef}
        type="button"
        onClick={() => setEditing(true)}
        className="focus-ring shrink-0 rounded-sm font-medium text-accent-text hover:underline"
      >
        Change hours
      </button>
      {/* Mounted while open, so it starts from the hours in use each time. */}
      {editing && (
        <WorkHoursDialog open onClose={() => setEditing(false)} hours={style.hours} returnFocusRef={changeRef} />
      )}
    </div>
  );
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The hours reply times count: the days (Monday to Thursday by default, the days every team works
 * when some work Sunday to Thursday), from and to, and the time zone (the team's by default).
 */
export function WorkHoursDialog({
  open,
  onClose,
  hours,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  hours: StyleDTO['hours'];
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const update = useUpdatePreferences();
  const [days, setDays] = useState<number[]>(hours.days);
  const [start, setStart] = useState(clock(hours.start));
  const [end, setEnd] = useState(clock(hours.end));
  const [zone, setZone] = useState(hours.timeZoneIsDefault ? '' : hours.timeZone);
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  }, []);
  const teamZone = hours.timeZoneIsDefault ? hours.timeZone : null;

  const from = parseClock(start);
  const to = parseClock(end);
  const problem = !days.length
    ? 'Choose at least one day.'
    : from == null || to == null
      ? 'Enter times as hours and minutes, like 09:00.'
      : from >= to
        ? 'The day has to start before it ends.'
        : null;

  const toggle = (d: number) =>
    setDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d].sort((a, b) => a - b)));
  const save = () => {
    if (problem || from == null || to == null) return;
    const next: WorkHoursDTO = { days, start: from, end: to, timeZone: zone || null };
    update.mutate({ workHours: next }, { onSuccess: onClose });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title="Working hours"
      description="Reply times count only these hours: a question that comes in at the end of the day and is answered first thing on the next working day waited minutes, not a night."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={problem != null} loading={update.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[13px] font-medium text-ink">Days</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEK_ORDER.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days.includes(d)}
                aria-label={DAY_NAMES[d]}
                onClick={() => toggle(d)}
                className={clsx(
                  'focus-ring h-8 min-w-11 rounded-lg border px-2 text-[13px] transition-colors',
                  days.includes(d)
                    ? 'border-transparent bg-accent-soft font-medium text-accent-text'
                    : 'border-line text-ink-muted hover:bg-hover hover:text-ink',
                )}
              >
                {DAY_NAMES[d].slice(0, 3)}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink-faint">
            {days.length ? daysLabel(days) : 'No days'}. Monday to Thursday is what every team works when some work
            Sunday to Thursday and others Monday to Friday.
          </p>
        </fieldset>
        <div className="flex gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">From</span>
            <input
              type="time"
              step={300}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="focus-ring h-9 rounded-lg border border-line-strong bg-raised px-2.5 text-sm text-ink tabular-nums"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">To</span>
            <input
              type="time"
              step={300}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="focus-ring h-9 rounded-lg border border-line-strong bg-raised px-2.5 text-sm text-ink tabular-nums"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink">Time zone</span>
          <select
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            className="focus-ring h-9 min-w-0 rounded-lg border border-line-strong bg-raised px-2 text-sm text-ink"
          >
            <option value="">
              {teamZone ? `Your team’s: ${zoneCity(teamZone)}` : 'Your team’s (most people’s in Slack)'}
            </option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        {(problem || update.isError) && (
          <p role="alert" className="text-[13px] text-danger">
            {problem ?? describeError(update.error)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
