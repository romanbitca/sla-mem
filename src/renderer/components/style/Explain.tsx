/**
 * What the "i" beside each part of My style explains: how that part is worked out, in short
 * sections, with the reader's own numbers and the ones the main process actually used
 * (StyleDTO.rules and the working hours), so the words can't drift from the code.
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { StyleCheckDTO, StyleCheckId, StyleDTO } from '../../../shared/types';
import { joinNames, pluralize } from '../../lib/format';
import { useDirectory } from '../../lib/directory';
import {
  clock,
  daysOffChannels,
  formatWait,
  hoursLabel,
  percent,
  TONE_LABEL,
  WEEK_ORDER,
  zoneCity,
} from '../../lib/style';
import { CheckIcon } from '../icons';

// ─── building blocks ─────────────────────────────────────────────────────────────────────────

function Lead({ children }: { children: ReactNode }) {
  return <p className="text-[14px] leading-relaxed text-ink">{children}</p>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11.5px] font-semibold tracking-wide text-ink-faint uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-ink-faint">{children}</ul>;
}

/** Terms and what they mean, the reader's own number beside each. */
function Terms({ items }: { items: { term: string; value?: string; text: ReactNode }[] }) {
  return (
    <dl className="flex flex-col gap-2.5">
      {items.map((item) => (
        <div key={item.term} className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
          <dt className="font-medium text-ink">
            {item.term}
            {item.value && <span className="ml-1.5 font-normal text-ink-faint tabular-nums">{item.value}</span>}
          </dt>
          <dd>{item.text}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A worked example, set apart. */
function Worked({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-inset px-3 py-2 text-[13px] text-ink">{children}</p>;
}

function Footnote({ children }: { children: ReactNode }) {
  return <p className="border-t border-line pt-3 text-xs text-ink-faint">{children}</p>;
}

// ─── the headline ────────────────────────────────────────────────────────────────────────────

/** How the headline ("Friendly, but casual") is decided: two questions, four answers. */
export function ToneInfo({ style }: { style: StyleDTO }) {
  const h = style.rules.habits;
  const by = checksById(style.checks);
  const friendly = style.tone === 'professional' || style.tone === 'friendly';
  const polished = style.tone === 'professional' || style.tone === 'polished';
  const cell = (tone: keyof typeof TONE_LABEL) => (
    <td
      className={clsx(
        'rounded-md px-3 py-2 text-center',
        style.tone === tone ? 'bg-accent-soft font-medium text-accent-text' : 'bg-inset text-ink-muted',
      )}
    >
      {TONE_LABEL[tone]}
      {style.tone === tone && <span className="block text-[11.5px] font-normal">You</span>}
    </td>
  );
  return (
    <>
      <Lead>The headline sums up the writing checks with two questions: are you friendly, and are you polished?</Lead>
      <table className="w-full border-separate border-spacing-1.5 text-[13px]">
        <thead>
          <tr className="text-[11.5px] tracking-wide text-ink-faint uppercase">
            <th />
            <th className="font-semibold">Polished</th>
            <th className="font-semibold">Not polished</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th className="pr-2 text-left font-medium text-ink">Friendly</th>
            {cell('professional')}
            {cell('friendly')}
          </tr>
          <tr>
            <th className="pr-2 text-left font-medium text-ink">Not friendly</th>
            {cell('polished')}
            {cell('casual')}
          </tr>
        </tbody>
      </table>
      <Section title="Friendly">
        <p>
          At least {h.friendlyGreeting}% of the chats you start open with a hello, or at least {h.friendlyPlease}% of
          your “can you …” requests say please.
          {by.greeting || by.please ? (
            <>
              {' '}
              You:{' '}
              {[by.greeting && `${share(by.greeting)} greet`, by.please && `${share(by.please)} say please`]
                .filter(Boolean)
                .join(', ')}
              {friendly ? ', so yes.' : ', so not yet.'}
            </>
          ) : null}
        </p>
      </Section>
      <Section title="Polished">
        <p>
          Capital letters and apostrophes, one message instead of several, and few casual words: all three are habits
          already.{' '}
          {(() => {
            const three = (['capitals', 'oneMessage', 'casual'] as const).map((id) => by[id]).filter(Boolean);
            if (!three.length) return null;
            const habits = three.filter((c) => c!.good).length;
            return `You: ${habits} of ${three.length}, so ${polished ? 'yes' : 'not yet'}.`;
          })()}
        </p>
      </Section>
      <Footnote>
        Worked out on this computer from your latest {pluralize(style.messageCount, 'message')}. Notes to yourself
        aren’t read, and nothing is sent anywhere.
      </Footnote>
    </>
  );
}

// ─── reply time ──────────────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A question half an hour before the end of the last working day in a row, answered a quarter of
 * an hour into the next working day: "Thursday at 20:00 … Monday at 09:15".
 */
function clockExample(hours: StyleDTO['hours']): ReactNode {
  if (hours.end - hours.start < 45) return null;
  const days = new Set(hours.days);
  const last = WEEK_ORDER.find((d) => days.has(d) && !days.has((d + 1) % 7));
  const asked = clock(hours.end - 30);
  const answered = clock(hours.start + 15);
  if (last == null) {
    return (
      <>
        A question at {asked}, answered at {answered} the next day, waited <b className="text-ink">45 minutes</b>.
      </>
    );
  }
  let next = (last + 1) % 7;
  while (!days.has(next)) next = (next + 1) % 7;
  return (
    <>
      A question on {DAY_NAMES[last]} at {asked}, answered on {next === last ? 'the next ' : ''}
      {DAY_NAMES[next]} at {answered}, waited <b className="text-ink">45 minutes</b>: 30 before the day ended and 15
      after the next one began.
    </>
  );
}

/** What reply time counts, when the clock runs, what is left out, and what the numbers mean. */
export function ReplyInfo({ style }: { style: StyleDTO }) {
  const r = style.rules;
  const you = style.you;
  const { conversations } = useDirectory();
  const sources = daysOffChannels(style.daysOffSources, (id) => conversations.get(id));
  const example = clockExample(style.hours);
  return (
    <>
      <Lead>How long people waited for your answer when they asked you something, counted in working hours only.</Lead>
      <Section title="What counts as a question">
        <Bullets>
          <li>In a DM: a question or a request, or a plain hello.</li>
          <li>In a channel or group DM: a message that speaks to you with a mention (@you) and asks something.</li>
          <li>Not: “thanks”, “ok”, news, or a message about you rather than to you.</li>
        </Bullets>
      </Section>
      <Section title="What counts as your answer">
        <Bullets>
          <li>In a DM or group DM: whatever you write there next.</li>
          <li>In a thread: your reply in that thread.</li>
          <li>
            A top-level question in a channel: your reply in its thread, or your next top-level message there within{' '}
            {r.channelAnswerHours} hours.
          </li>
          <li>Several questions answered by one message count once, from the first.</li>
        </Bullets>
      </Section>
      <Section title="When the clock runs">
        <p>
          Only {hoursLabel(style.hours)}. Nights, the other days and days off don’t count. Change hours, under the
          chart, sets them.
        </p>
        {example && <Worked>{example}</Worked>}
      </Section>
      <Section title="Left out">
        <Bullets>
          <li>Questions that came in on a day that isn’t counted, or on your day off.</li>
          <li>Answers more than {pluralize(r.maxWaitDays, 'working day')} later: by then it’s rarely an answer.</li>
          <li>Questions never answered in Slack. A reaction has no time, so it can’t be timed.</li>
        </Bullets>
      </Section>
      <Section title="Days off">
        <p>Read from the archive, for everyone:</p>
        <Bullets>
          <li>leave lists: a bot’s “on leave today” post naming people (with their dates), or “I’m off today”;</li>
          <li>channels of absence notices, like a sick-leave channel: each post there is its author’s day off.</li>
        </Bullets>
        {style.yourDaysOff > 0 && (
          <p>
            {pluralize(style.yourDaysOff, 'day')} of yours found
            {sources.length ? `, from ${joinNames(sources)}` : ''}.
          </p>
        )}
      </Section>
      {you && (
        <Section title="The numbers">
          <Terms
            items={[
              {
                term: 'On average',
                value: formatWait(you.averageSeconds),
                text: `Every wait added up and divided by your ${you.count.toLocaleString()} answers. A few long waits pull it up.`,
              },
              {
                term: 'Half within',
                value: formatWait(you.medianSeconds),
                text: 'The middle wait: half your answers came sooner, half later.',
              },
              {
                term: 'Within an hour',
                value: percent(you.buckets[0] + you.buckets[1], you.count),
                text: 'Answers that came within 60 minutes of working time.',
              },
              ...(style.them
                ? [
                    {
                      term: 'People answer yours',
                      value: formatWait(style.them.averageSeconds),
                      text: 'The same rules the other way round, for your questions to others, on their days off.',
                    },
                  ]
                : []),
            ]}
          />
        </Section>
      )}
      <Footnote>The year before your latest message counts.</Footnote>
    </>
  );
}

/** What a bar in the chart stands for. */
export function ChartInfo({ style }: { style: StyleDTO }) {
  return (
    <>
      <Lead>Your average reply time per week or per month, so you can see it change.</Lead>
      <Bullets>
        <li>
          Each bar is the average wait for the questions that came in that week (Monday to Sunday) or month, in{' '}
          {zoneCity(style.hours.timeZone)} time. Taller means slower.
        </li>
        <li>Point at a bar, or move along the bars with the arrow keys, for its numbers.</li>
        <li>The last bar is this week or month, still filling up.</li>
        <li>A week without answers shows as a low grey bar; the chart starts where your answers do.</li>
      </Bullets>
      <Footnote>Every bar follows the rules of Reply time: working hours only, days off left out.</Footnote>
    </>
  );
}

/** How the fastest and slowest lists are made. */
export function RankingInfo({ style }: { style: StyleDTO }) {
  const r = style.rules;
  return (
    <>
      <Lead>Your average reply time for each person, on the same rules as Reply time.</Lead>
      <Bullets>
        <li>
          Only people you answered at least {pluralize(r.rankMinAnswers, 'time')}, so a single slow day doesn’t decide.
        </li>
        <li>
          At most {r.ranked} in each list. With fewer than {r.ranked * 2} such people, they’re split into a quicker and
          a slower half, so nobody is on both.
        </li>
        <li>Their days off don’t count against you, and yours don’t either.</li>
        <li>A name opens their page.</li>
      </Bullets>
    </>
  );
}

// ─── writing ─────────────────────────────────────────────────────────────────────────────────

const CHECK_TITLES: Record<StyleCheckId, string> = {
  capitals: 'Capital letters and apostrophes',
  greeting: 'A hello when you start a chat',
  greetAndAsk: 'Hello and your question together',
  please: '“Please” when you ask',
  oneMessage: 'One message instead of several',
  casual: 'Casual words',
};

/** What each writing check looks at, when it counts as a habit, and where you are. */
export function WritingInfo({ style }: { style: StyleDTO }) {
  const r = style.rules;
  const h = r.habits;
  const by = checksById(style.checks);
  const rows: { id: StyleCheckId; rule: ReactNode; you: (c: StyleCheckDTO) => string }[] = [
    {
      id: 'capitals',
      rule: (
        <>
          At most {h.smallStarts}% of messages start with a small letter (one that opens with a mention reads on); “i”
          for “I” at most {h.smallIPer100}, and a missing apostrophe (“im”, “dont”) at most {h.apostrophesPer100}, per
          100 messages.
        </>
      ),
      you: (c) => `${share(c)} start small`,
    },
    {
      id: 'greeting',
      rule: (
        <>
          At least {h.greeting}% of the chats you start open with a greeting. A chat starts with your message in a DM or
          group DM after {pluralize(r.openerQuietHours, 'quiet hour')}.
        </>
      ),
      you: (c) => `${share(c)} greet`,
    },
    {
      id: 'greetAndAsk',
      rule: <>At most {h.helloOnly}% of those chats open with nothing but hello (“Hi, how are you?”) and wait.</>,
      you: (c) => `${c.count} of ${c.total}`,
    },
    {
      id: 'please',
      rule: <>At least {h.please}% of your “can you …” requests say please, or ask “could you”.</>,
      you: (c) => `${share(c)} say please`,
    },
    {
      id: 'oneMessage',
      rule: (
        <>
          {r.burstMin} or more messages in a row, each within {r.burstSeconds} seconds of the last, at most{' '}
          {h.runsPer100} times per 100 messages.
        </>
      ),
      you: (c) => pluralize(c.count, 'time'),
    },
    {
      id: 'casual',
      rule: <>“yeah”, “gonna”, “pls”, “thanks man”, laughs and swearing: at most {h.casualPer100} per 100 messages.</>,
      you: (c) => pluralize(c.count, 'time'),
    },
  ];
  return (
    <>
      <Lead>
        Six habits that make work messages read as professional, checked by rules on this computer. Nothing is sent
        anywhere.
      </Lead>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-[11.5px] tracking-wide text-ink-faint uppercase">
              <th className="px-1 pb-2 font-semibold">Check</th>
              <th className="px-1 pb-2 font-semibold">A habit when</th>
              <th className="px-1 pb-2 text-right font-semibold">You</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line align-top">
            {rows.map((row) => {
              const c = by[row.id];
              return (
                <tr key={row.id}>
                  <td className="w-44 px-1 py-2.5 font-medium text-ink">{CHECK_TITLES[row.id]}</td>
                  <td className="px-1 py-2.5">{row.rule}</td>
                  <td className="px-1 py-2.5 text-right whitespace-nowrap">
                    {c ? (
                      <span className={clsx('inline-flex items-center gap-1.5', c.good ? 'text-success' : 'text-ink')}>
                        {c.good ? (
                          <CheckIcon size={13} aria-hidden="true" />
                        ) : (
                          <span aria-hidden="true" className="size-1.5 rounded-full bg-warn" />
                        )}
                        {row.you(c)}
                      </span>
                    ) : (
                      <span className="text-ink-faint">Too few yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Section title="What is read">
        <Bullets>
          <li>
            Your latest {r.writingMessages.toLocaleString()} messages; notes to yourself aren’t read. Here:{' '}
            {pluralize(style.messageCount, 'message')}, {style.englishCount.toLocaleString()} of them in English.
          </li>
          <li>The checks on wording (capitals, apostrophes, please, casual words) read English messages only.</li>
          <li>A check is shown only when there’s enough to go on.</li>
        </Bullets>
      </Section>
      <Section title="The examples">
        <Bullets>
          <li>Each comes from your last {r.exampleDays} days, a message short and plain enough to read on its own.</li>
          <li>“Could read” fixes only what that check is about, with the same rules, not AI.</li>
          <li>“Open the message” shows it where you wrote it.</li>
        </Bullets>
      </Section>
    </>
  );
}

// ─── Claude's review ─────────────────────────────────────────────────────────────────────────

/** What Claude's review sends, where, what comes back, and what it costs. */
export function ReviewInfo({ model, messages }: { model: string; messages: number }) {
  return (
    <>
      <Lead>A second opinion from Claude, on what rules can’t see. It runs only when you click the button.</Lead>
      <Terms
        items={[
          {
            term: 'What is sent',
            text: (
              <>
                Your latest {messages} messages that have words in them, as Slack shows them: names for mentions, code
                as [code], quotes left out. Nobody else’s messages.
              </>
            ),
          },
          {
            term: 'To whom',
            text: <>Anthropic, with your own API key from Settings → Ask AI, using {model}.</>,
          },
          {
            term: 'What comes back',
            text: (
              <>
                How you come across, what already works, three or four tips each with one of your messages rewritten,
                and the words you misspell. The six checks are left to Slamem: Claude looks at tone, clarity, and how
                you put requests and bad news.
              </>
            ),
          },
          {
            term: 'Where it’s kept',
            text: (
              <>
                On this computer, readable only by you. It shows every time you open the page, until you click Review
                again: nothing is sent before that.
              </>
            ),
          },
          {
            term: 'Cost',
            text: <>A few cents a review, added to what Ask AI has cost in Settings.</>,
          },
        ]}
      />
    </>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

function checksById(checks: readonly StyleCheckDTO[]): Partial<Record<StyleCheckId, StyleCheckDTO>> {
  return Object.fromEntries(checks.map((c) => [c.id, c]));
}

function share(c: StyleCheckDTO): string {
  return percent(c.count, c.total);
}
