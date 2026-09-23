/**
 * What the "i" beside each part of My style says: how that part is worked out, with the numbers
 * the main process actually used (StyleDTO.rules and the working hours), so the words can't drift
 * from the code.
 */
import type { StyleDTO } from '../../../shared/types';
import { pluralize } from '../../lib/format';
import { hoursLabel, zoneCity } from '../../lib/style';

/** How the headline ("Friendly, but casual") is decided. */
export function ToneInfo({ style }: { style: StyleDTO }) {
  const h = style.rules.habits;
  return (
    <>
      <p>The headline sums up the writing checks further down.</p>
      <ul>
        <li>
          <b>Friendly</b>: at least {h.friendlyGreeting}% of the chats you start open with a hello, or at least{' '}
          {h.friendlyPlease}% of your “can you …” requests say please.
        </li>
        <li>
          <b>Polished</b>: capital letters and apostrophes, one message instead of several, and few casual words are all
          habits already.
        </li>
      </ul>
      <p>
        Both make “Professional and friendly”; friendly only, “Friendly, but casual”; polished only, “Professional, but
        brief”; neither, “Casual”.
      </p>
      <p>
        Worked out on this computer from your latest {pluralize(style.messageCount, 'message')}. Notes to yourself
        aren’t read, and nothing is sent anywhere.
      </p>
    </>
  );
}

/** What reply time counts, when the clock runs, and what is left out. */
export function ReplyInfo({ style }: { style: StyleDTO }) {
  const r = style.rules;
  return (
    <>
      <p>
        <b>What counts.</b> A question or request someone sends you in a DM (a plain hello too), or a message in a
        channel or group DM that speaks to you with a mention and asks something. “Thanks”, “ok” and news don’t wait for
        an answer.
      </p>
      <p>
        <b>Your answer.</b> Your next message there: anything in the DM or group DM, a reply in the thread, or for a
        top-level question in a channel, your next top-level message within {r.channelAnswerHours} hours. Several
        questions answered by one message count once, from the first.
      </p>
      <p>
        <b>The clock</b> runs only {hoursLabel(style.hours)}. A question that comes in at the end of the day and is
        answered first thing on the next working day waited only the minutes in between.
      </p>
      <p>
        <b>Left out:</b> questions that arrive on a day that isn’t counted or on your day off, answers more than{' '}
        {pluralize(r.maxWaitDays, 'working day')} later, and questions never answered in Slack (a reaction has no time).
      </p>
      <p>
        <b>Days off</b> are read from the archive for everyone: leave lists (a bot’s “on leave today” post, or “I’m off
        today”) and channels of absence notices, like a sick-leave channel.
      </p>
      <p>
        <b>On average</b> adds up every wait and divides by the answers; <b>half within</b> is the middle wait, so half
        your answers came sooner; <b>within an hour</b> is the share answered within 60 minutes of working time.{' '}
        <b>People answer yours</b> uses the same rules for your questions to others, on their days off. The year before
        your latest message counts.
      </p>
    </>
  );
}

/** What a bar in the chart stands for. */
export function ChartInfo({ style }: { style: StyleDTO }) {
  return (
    <>
      <p>
        Each bar is your average wait for the questions that came in that week (Monday to Sunday) or month, in{' '}
        {zoneCity(style.hours.timeZone)} time. Taller means slower.
      </p>
      <p>
        The last bar is this week or month, still filling up. A week without answers shows as a low grey bar, and the
        chart starts where your answers do.
      </p>
    </>
  );
}

/** How the fastest and slowest lists are made. */
export function RankingInfo({ style }: { style: StyleDTO }) {
  const r = style.rules;
  return (
    <>
      <p>Your average wait for each person, on the same rules as Reply time.</p>
      <ul>
        <li>
          Only people you answered at least {pluralize(r.rankMinAnswers, 'time')}, so a single slow day doesn’t decide.
        </li>
        <li>
          At most {r.ranked} in each list. With fewer than {r.ranked * 2} people, they’re split into a quicker and a
          slower half, so nobody is on both.
        </li>
        <li>A name opens their page.</li>
      </ul>
    </>
  );
}

/** What each writing check looks at, and when it counts as a habit. */
export function WritingInfo({ style }: { style: StyleDTO }) {
  const r = style.rules;
  const h = r.habits;
  return (
    <>
      <p>
        Rules, run on this computer over your latest {r.writingMessages.toLocaleString()} messages (notes to yourself
        aren’t read). The checks about wording read your English messages, and a check shows only when there’s enough to
        go on. It counts as a habit when:
      </p>
      <ul>
        <li>
          <b>Capital letters and apostrophes:</b> at most {h.smallStarts}% of your messages start with a small letter
          (one that opens with a mention reads on), “i” for “I” comes up at most {h.smallIPer100} times per 100
          messages, and a missing apostrophe (“im”, “dont”) at most {h.apostrophesPer100}.
        </li>
        <li>
          <b>A hello when you start a chat:</b> your first message in a DM or group DM after{' '}
          {pluralize(r.openerQuietHours, 'quiet hour')} opens with a greeting at least {h.greeting}% of the time.
        </li>
        <li>
          <b>Hello and your question together:</b> at most {h.helloOnly}% of those chats open with nothing but hello.
        </li>
        <li>
          <b>“Please” when you ask:</b> at least {h.please}% of your “can you …” requests say please or “could you”.
        </li>
        <li>
          <b>One message instead of several:</b> {r.burstMin} or more messages in a row, each within {r.burstSeconds}{' '}
          seconds of the last, at most {h.runsPer100} times per 100 messages.
        </li>
        <li>
          <b>Casual words</b> (“yeah”, “gonna”, “pls”, “thanks man”, laughs, swearing): at most {h.casualPer100} per 100
          messages.
        </li>
      </ul>
      <p>Examples come from your last {r.exampleDays} days, and each rewrite fixes only what its check is about.</p>
    </>
  );
}

/** What Claude's review sends, where, and what it costs. */
export function ReviewInfo({ model, messages }: { model: string; messages: number }) {
  return (
    <ul>
      <li>
        <b>Sent:</b> your latest {messages} messages that have words in them, as Slack shows them (names for mentions,
        code as [code], quotes left out). Nobody else’s messages.
      </li>
      <li>
        <b>To</b> Anthropic, with your API key from Settings → Ask AI, using {model}.
      </li>
      <li>
        <b>Back:</b> how you come across, what works, three or four tips each with one of your messages rewritten, and
        the words you misspell. The checks above are left to Slamem: Claude looks at tone, clarity and how you put
        requests and bad news.
      </li>
      <li>
        <b>Kept</b> on this computer, readable only by you, and shown until you click Review again. Nothing is sent
        before that click.
      </li>
      <li>
        <b>Cost:</b> a few cents a review, added to Ask AI’s spending in Settings.
      </li>
    </ul>
  );
}
