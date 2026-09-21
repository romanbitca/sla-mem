/**
 * Synthetic archive generator (dev only): writes a realistic, entirely fictional workspace
 * ("Brightwave") straight into an archive folder, so the UI can be built and performance measured
 * without Slack. PLAN §11 Stage 1.
 *
 * The data has threads (one with ~40 replies), broadcasts, reactions with skin tones, edits with
 * revision history, deleted-in-Slack messages, mentions, unfurls, code, bot messages (legacy
 * attachments and Block Kit), custom emoji, and attachments (PNG, PDF, HTML, text, a video that
 * was never downloaded and a Free-plan `hidden_by_limit` stub). Timestamps are relative to now,
 * so part of the history is older than Slack Free's 90-day window.
 *
 * Usage: npm run seed -- [--out DIR] [--messages N] [--days N] [--seed N]
 *   --out       archive folder (default ./.demo-data); wiped first, but only if this script made it
 *   --messages  approximate message count (default ~10,000); e.g. 300000 for performance runs
 *   --days      history length in days (default 200, or longer for big --messages)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  SlackAttachment,
  SlackBlock,
  SlackConversation,
  SlackFile,
  SlackMessage,
  SlackReaction,
  SlackUser,
} from '../src/main/slack/types';
import {
  markFileDownloaded,
  openDb,
  setMeta,
  upsertConversations,
  upsertCustomEmoji,
  upsertMessages,
  upsertUsers,
  type DB,
} from '../src/main/db';
import { makePdf, makePng, PAINTERS, type Paint } from './lib/media';
import { Rng } from './lib/rng';

// =============================================================================================
// Options
// =============================================================================================

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '.slack-archive-demo';

interface Options {
  out: string;
  seed: number;
  days: number | null;
  messages: number;
}

function parseOptions(argv: string[]): Options {
  const opts: Options = { out: path.join(ROOT, '.demo-data'), seed: 42, days: null, messages: 10_000 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    const value = () => inline ?? argv[++i] ?? '';
    if (flag === '--out') opts.out = path.resolve(process.env.INIT_CWD ?? process.cwd(), value());
    else if (flag === '--seed') opts.seed = Number(value()) || 42;
    else if (flag === '--days') opts.days = Math.max(30, Math.min(3000, Number(value()) || 200));
    else if (flag === '--messages') opts.messages = Math.max(500, Math.min(2_000_000, Number(value()) || 10_000));
    else throw new Error(`Unknown option ${argv[i]} (expected --out, --messages, --days, --seed)`);
  }
  return opts;
}

// =============================================================================================
// Workspace: people and conversations
// =============================================================================================

const TEAM_ID = 'T0DEMO0001';
const TEAM_NAME = 'Brightwave';
const TEAM_DOMAIN = 'brightwave-demo';
const DAY = 86_400;
/** Scales every conversation's activity; 1.6 gives ~9k messages over 200 days. Set by main(). */
let RATE_SCALE = 1.6;

interface Person {
  id: string;
  name: string;
  realName: string;
  displayName: string;
  title: string;
  deleted?: boolean;
  bot?: { botId: string; appId: string };
}

const SELF = 'U0DEMOJLEE';

const PEOPLE: Person[] = [
  { id: SELF, name: 'jordan', realName: 'Jordan Lee', displayName: 'Jordan', title: 'Engineering Manager' },
  { id: 'U0DEMOPRIY', name: 'priya', realName: 'Priya Patel', displayName: 'Priya', title: 'Staff Engineer' },
  { id: 'U0DEMOMARC', name: 'marcus', realName: 'Marcus Chen', displayName: 'marcus.c', title: 'Backend Engineer' },
  { id: 'U0DEMOSOFI', name: 'sofia', realName: 'Sofia Rossi', displayName: 'Sofia', title: 'Product Designer' },
  { id: 'U0DEMOLIAM', name: 'liam', realName: "Liam O'Brien", displayName: "Liam O'B", title: 'SRE' },
  { id: 'U0DEMOAISH', name: 'aisha', realName: 'Aisha Khan', displayName: 'Aisha', title: 'Head of Product' },
  { id: 'U0DEMOTOMS', name: 'tomas', realName: 'Tomás García', displayName: 'Tomás', title: 'Frontend Engineer' },
  { id: 'U0DEMOEMMA', name: 'emma', realName: 'Emma Schmidt', displayName: '', title: 'Recruiter' },
  { id: 'U0DEMONOAH', name: 'noah', realName: 'Noah Williams', displayName: 'noah', title: 'Support Lead' },
  { id: 'U0DEMOYUKI', name: 'yuki', realName: 'Yuki Tanaka', displayName: 'Yuki', title: 'Data Engineer' },
  { id: 'U0DEMOOLIV', name: 'olivia', realName: 'Olivia Brown', displayName: 'Liv', title: 'CEO' },
  { id: 'U0DEMOZARA', name: 'zara', realName: 'Zara Ahmed', displayName: 'Zara', title: 'QA Engineer' },
  {
    id: 'U0DEMODANK',
    name: 'daniel',
    realName: 'Daniel Kim',
    displayName: 'Dan',
    title: 'Mobile Engineer',
    deleted: true,
  },
  {
    id: 'U0DEMOGHUB',
    name: 'github',
    realName: 'GitHub',
    displayName: '',
    title: '',
    bot: { botId: 'B0DEMOGHUB', appId: 'A0DEMOGHUB' },
  },
  {
    id: 'U0DEMODPLY',
    name: 'deploybot',
    realName: 'Deploy Bot',
    displayName: '',
    title: '',
    bot: { botId: 'B0DEMODPLY', appId: 'A0DEMODPLY' },
  },
];

const PERSON = new Map(PEOPLE.map((p) => [p.id, p]));
const HUMANS = PEOPLE.filter((p) => !p.bot).map((p) => p.id);
const GITHUB = PERSON.get('U0DEMOGHUB')!;
const DEPLOY_BOT = PERSON.get('U0DEMODPLY')!;
/** Daniel left the company this many days ago; he posts nothing after that. */
const DANIEL_LEFT_DAYS_AGO = 140;

type Kind = 'channel' | 'private' | 'im' | 'mpim';

interface Conv {
  id: string;
  kind: Kind;
  /** Folder name in the export: channel/mpim name, DM id. */
  folder: string;
  members: string[];
  /** Mean top-level messages on a weekday while active. */
  rate: number;
  /** Probability that a top-level message gets a thread. */
  threadP: number;
  theme: keyof typeof TEMPLATES;
  /** Active window in days ago (inclusive), e.g. an archived project channel went quiet. */
  activeFrom: number;
  activeTo: number;
  topic?: string;
  purpose?: string;
  archived?: boolean;
}

const ALL = HUMANS;

function channel(
  id: string,
  name: string,
  kind: 'channel' | 'private',
  members: string[],
  extra: Partial<Conv> & Pick<Conv, 'rate' | 'theme'>,
): Conv {
  return { id, kind, folder: name, members, threadP: 0.14, activeFrom: Infinity, activeTo: 0, ...extra };
}

function dm(id: string, other: string, rate: number, extra: Partial<Conv> = {}): Conv {
  return {
    id,
    kind: 'im',
    folder: id,
    members: [SELF, other],
    rate,
    threadP: 0.04,
    theme: 'dm',
    activeFrom: Infinity,
    activeTo: 0,
    ...extra,
  };
}

const CONVERSATIONS: Conv[] = [
  channel('C0DEMOGENL', 'general', 'channel', ALL, {
    rate: 3.2,
    theme: 'general',
    topic: 'Company-wide announcements :mega: | All-hands every other Thursday',
    purpose: 'This channel is for workspace-wide communication and announcements.',
  }),
  channel(
    'C0DEMOENGR',
    'engineering',
    'channel',
    ALL.filter((u) => !['U0DEMOEMMA', 'U0DEMOOLIV'].includes(u)).concat(GITHUB.id),
    {
      rate: 6.5,
      threadP: 0.2,
      theme: 'engineering',
      topic: 'On call this week: <@U0DEMOLIAM> | Runbooks: <https://wiki.brightwave.dev/runbooks|wiki>',
      purpose: 'Engineering discussions, reviews and incidents',
    },
  ),
  channel(
    'C0DEMODSGN',
    'design',
    'channel',
    [SELF, 'U0DEMOSOFI', 'U0DEMOAISH', 'U0DEMOTOMS', 'U0DEMOPRIY', 'U0DEMOYUKI'],
    {
      rate: 2.2,
      theme: 'design',
      topic: 'Figma: <https://www.figma.com/files/team/brightwave|Brightwave team>',
      purpose: 'Design reviews, mockups and the design system',
    },
  ),
  channel('C0DEMORAND', 'random', 'channel', ALL, {
    rate: 2.4,
    threadP: 0.1,
    theme: 'random',
    purpose: 'Non-work banter and water cooler conversation',
  }),
  channel(
    'C0DEMODPLY',
    'deploys',
    'channel',
    [SELF, 'U0DEMOPRIY', 'U0DEMOMARC', 'U0DEMOLIAM', 'U0DEMOTOMS', DEPLOY_BOT.id, GITHUB.id],
    {
      rate: 0.8,
      threadP: 0.08,
      theme: 'deploys',
      purpose: 'Deploy notifications from CI',
    },
  ),
  channel(
    'C0DEMOATLS',
    'project-atlas',
    'channel',
    [SELF, 'U0DEMOPRIY', 'U0DEMOMARC', 'U0DEMOAISH', 'U0DEMODANK', 'U0DEMOYUKI'],
    {
      rate: 4,
      threadP: 0.2,
      theme: 'atlas',
      activeFrom: 195,
      activeTo: 112,
      archived: true,
      topic: 'Atlas: the new data platform (shipped!)',
      purpose: 'Project Atlas working channel',
    },
  ),
  channel('C0DEMOLEAD', 'leadership', 'private', [SELF, 'U0DEMOAISH', 'U0DEMOOLIV', 'U0DEMOPRIY'], {
    rate: 1.1,
    threadP: 0.22,
    theme: 'leadership',
    topic: 'Confidential: budget, hiring, strategy',
  }),
  channel('C0DEMOHIRE', 'hiring', 'private', [SELF, 'U0DEMOEMMA', 'U0DEMOAISH', 'U0DEMOSOFI', 'U0DEMOPRIY'], {
    rate: 0.8,
    threadP: 0.22,
    theme: 'hiring',
    purpose: 'Candidates, interview loops and offers',
  }),
  dm('D0DEMOPRIY', 'U0DEMOPRIY', 2.2),
  dm('D0DEMOMARC', 'U0DEMOMARC', 1.4),
  dm('D0DEMOSOFI', 'U0DEMOSOFI', 1.0),
  dm('D0DEMOAISH', 'U0DEMOAISH', 1.1),
  dm('D0DEMODANK', 'U0DEMODANK', 1.2, { activeFrom: 200, activeTo: DANIEL_LEFT_DAYS_AGO }),
  { ...dm('D0DEMOSELF', SELF, 0.35), members: [SELF, SELF], theme: 'self' },
  {
    id: 'G0DEMOMPD1',
    kind: 'mpim',
    folder: 'mpdm-jordan--priya--marcus-1',
    members: [SELF, 'U0DEMOPRIY', 'U0DEMOMARC'],
    rate: 0.9,
    threadP: 0.05,
    theme: 'mpim',
    activeFrom: Infinity,
    activeTo: 0,
  },
  {
    id: 'G0DEMOMPD2',
    kind: 'mpim',
    folder: 'mpdm-jordan--sofia--emma--yuki-1',
    members: [SELF, 'U0DEMOSOFI', 'U0DEMOEMMA', 'U0DEMOYUKI'],
    rate: 0.6,
    threadP: 0.05,
    theme: 'mpim',
    activeFrom: Infinity,
    activeTo: 0,
  },
];

const CONV = new Map(CONVERSATIONS.map((c) => [c.id, c]));
const conv = (id: string) => CONV.get(id)!;

// =============================================================================================
// Message text (already in Slack's escaped mrkdwn: &amp; &lt; &gt;)
// =============================================================================================

const TEMPLATES = {
  general: [
    'Reminder: all-hands is on {day} at {time} UTC :calendar: Agenda in {doc}',
    'Welcome {@} to the team! :wave::skin-tone-3: Say hi in {#}',
    'The office will be closed on {day} for maintenance &amp; cleaning :broom:',
    'Huge thanks to {@} for organizing the offsite :raised_hands::skin-tone-4:',
    'Q{q} OKRs are published: {doc}',
    'Heads-up: we are switching payroll providers next month. Please double-check your invoice details by {day}',
    "Who's up for lunch at the new ramen place? :ramen:",
    'Friendly reminder to fill in the engagement survey by {day} :memo:',
    'The new onboarding checklist is live :sparkles: {doc}',
    'Please set your Slack status when you are OOO :palm_tree:',
    '*Company update*: we closed {num} new customers last month :chart_with_upwards_trend:',
    '<!here> the VPN certificate expires on {day}, grab the new profile from {link}',
    'Status page: <https://status.brightwave.dev> (all green :white_check_mark:)',
    'Parking lot will be repainted on {date}, please use the side entrance',
    'Great read on remote work culture: <https://blog.brightwave.dev/remote-first|Remote first, not remote only>',
    'Security reminder: never share 2FA codes, even with IT :lock:',
    'Shoutout to {@} and {@} for shipping the {proj} beta :rocket:',
    'Donuts in the kitchen :doughnut: first come first served',
  ],
  engineering: [
    'Anyone else seeing flaky tests in `{comp}`? CI failed twice on main :thinking_face:',
    'PR up for review: {pr} refactors the {comp} retry logic',
    'Heads-up: deploying {comp} at {time} UTC, expect a short blip',
    '{@} can you take a look at {ticket}? Latency on {comp} went from 120ms to 900ms',
    'TIL: `git worktree` makes reviewing PRs so much easier',
    'Migration for {comp} is done :white_check_mark: Rollback plan in {doc}',
    "Here's the query I used:\n```SELECT customer_id, count(*)\nFROM invoices\nWHERE status = 'failed'\n  AND created_at &gt; now() - interval '7 days'\nGROUP BY 1\nORDER BY 2 DESC;```",
    'We should bump Node to 22 before the {proj} launch. Thoughts?',
    '~The old endpoint~ is deprecated, please use `/v2/{slug}` from now on',
    'Postmortem for the outage last week: {doc}',
    'Can someone review {pr}? It blocks the {proj} release :pray:',
    'Load test results: p95 {num}ms at 2k rps :fire:',
    "I'll pair with {@} on the {comp} memory leak this afternoon",
    'Reminder: code freeze starts {day} at 18:00 :snowflake:',
    'Quick fix for the race condition:\n```if (queue.length &gt; 0 &amp;&amp; !worker.busy) {\n  worker.run(queue.shift());\n}```',
    "Error on staging: `TypeError: Cannot read properties of undefined (reading 'id')` in {comp}",
    'Feature flag `{flag}` is now at 50% :rocket:',
    '<!subteam^S0DEMOBACK|@backend> please update your local env, the `.env.example` changed',
    'Dependabot opened {num} PRs overnight :sweat_smile: I merged the patch bumps',
    '&gt; Make it work, make it right, make it fast\nApplies to {comp} too :100:',
    'Docs for the new webhooks API: <https://docs.brightwave.dev/api/webhooks|Webhooks guide> and the changelog {link}',
    'Checklist before the {proj} release:\n• feature flags cleaned up\n• dashboards updated\n• runbook reviewed by {@}',
    'Does anyone know why `{comp}` pins `openssl` to 1.1? Blocking the base image upgrade',
    'Sentry is quiet today :relieved: first time in weeks',
    'Invoice generation job took {num} minutes last night, investigating :mag:',
  ],
  design: [
    'New mockups for the {proj} onboarding flow in Figma: <https://www.figma.com/file/{hash}/Onboarding|{proj} onboarding v{n}>',
    'Feedback round on the empty states closes {day}',
    'I think the primary button contrast is too low in dark mode :eyes:',
    'Updated the icon set, 24 new icons :art:',
    '{@} what do you think about moving search to the top bar?',
    'Accessibility audit notes: {doc}',
    'Color tokens are now synced with the design system :sparkles:',
    'User interviews this week: {num} sessions booked for the {proj} dashboard',
    'Typography scale v{n}: we dropped the 13px size, too many near-duplicates',
    'Moodboard for the rebrand is pinned, add your favourites :pushpin:',
  ],
  random: [
    'Anyone watching the match tonight? :soccer:',
    'My cat just walked across the keyboard and pushed to a branch :joy:',
    'The coffee machine on the 3rd floor is fixed :coffee: :tada:',
    'Book recommendation: _The Pragmatic Programmer_ :books:',
    'Friday playlist thread :musical_note:',
    'Who took my stapler :eyes:',
    'Happy birthday {@}! :birthday: :tada:',
    'Hot take: tabs &gt; spaces :fire:',
    'Is it just me or is the office freezing today :cold_face:',
    'Found this gem: <https://xkcd.com/1205/|Is it worth the time?>',
    'Plant update: the office monstera has a new leaf :seedling:',
    'Board games night on {day}? :game_die:',
  ],
  deploys: [
    ':rocket: `web` {version} deployed to *production* by {@}',
    ':white_check_mark: `billing-api` {version} deployed to staging',
    ':warning: Deploy of `{slug}` to production was rolled back',
  ],
  atlas: [
    'Atlas kickoff notes: {doc}',
    'Atlas API contract v{n} is frozen :lock:',
    'Data migration dry run #{num} passed :white_check_mark:',
    'Blocking issue: {ticket} (auth tokens expire too early)',
    'Atlas beta now has {num} active users :rocket:',
    '{@} can you share the ingestion throughput numbers?',
    'Schema review for the `events` table on {day}, invite sent',
    'The Atlas dashboards are live: <https://grafana.brightwave.dev/d/atlas|Atlas overview>',
    'Backfill of {num}M rows finished overnight :tada:',
    'We need a decision on Parquet vs Avro by {day}',
  ],
  leadership: [
    'Draft budget for Q{q} is ready for review, numbers are *confidential*',
    'We need to decide on the {proj} pricing by {day}',
    'Hiring plan: 2 engineers + 1 designer in Q{q}',
    'Board meeting prep: {doc}',
    'Revenue is {num}% above plan this month :chart_with_upwards_trend:',
    "Let's discuss the vendor invoice issue in our 1:1",
    'Offsite dates confirmed for {day} + Friday :airplane:',
    'Churn is down to {n}% after the onboarding changes',
  ],
  hiring: [
    'New candidate for the senior backend role, strong on distributed systems. Interview on {day}',
    'Scorecard is in {link}',
    'Offer accepted :tada: start date in {n} weeks',
    'Can someone cover the design interview on {day} at {time}?',
    'Take-home review for the frontend role is due {day}',
    'Referral bonus reminder: send candidates to <mailto:jobs@brightwave.dev|jobs@brightwave.dev>',
    'Pipeline this week: {num} applicants, {n} phone screens',
  ],
  dm: [
    'Hey, got a minute?',
    'Can you review my PR when you have time? {pr}',
    'Thanks for the help yesterday :pray::skin-tone-2:',
    'Running 5 min late to our 1:1',
    'Did you see the numbers from the {proj} launch?',
    "Sure, let's do {day} at {time}",
    'Sending the invoice over now',
    'lol :joy:',
    'Sounds good :+1::skin-tone-3:',
    "I'll be OOO on {day}",
    'Can we move our sync to {time}?',
    'Here is the doc I mentioned: {doc}',
    'Nice job in the demo today :clap::skin-tone-5:',
    'Quick question about {ticket}: is that still on your plate?',
  ],
  self: [
    'TODO: renew passport before {day}',
    'Ideas for the {proj} retro:\n• what went well\n• what to change\n• shoutouts for {@}',
    'Read later: <https://martinfowler.com/articles/{slug}.html>',
    '&gt; Simple things should be simple, complex things should be possible.',
    '1:1 notes with {@}: career growth, {proj} ownership, conference budget',
    'Reminder: expense the conference ticket :memo:',
  ],
  mpim: [
    'Lunch? :pizza:',
    'Can we sync on the {proj} demo before {day}?',
    "I'll book a room",
    'Slides are here: {doc}',
    'Running late, start without me',
    'Thanks both :raised_hands:',
  ],
};

const REPLIES = [
  '+1',
  'Agreed :+1:',
  'On it',
  'Looking now :eyes:',
  'Done :white_check_mark:',
  'Good catch!',
  'Can you share more context?',
  'I think {@} knows more about this',
  'Fixed in {pr}',
  "Let's discuss at standup",
  'Makes sense to me',
  'Thanks!',
  'Nice work :clap::skin-tone-4:',
  "Not sure that's right, the {comp} config is different on staging",
  'Merged :rocket:',
  'Will do',
  'Should we open a ticket? {ticket}',
  'Yep, same here',
  'Sounds good :+1::skin-tone-2:',
  'Here are the logs:\n```2026-01-12T10:32:11Z WARN retrying request attempt=3\n2026-01-12T10:32:14Z ERROR upstream timeout after 3000ms```',
  'Love it :heart:',
  'Can we wait until after the {proj} release?',
  ':joy:',
  'Updated the doc: {doc}',
];

const INCIDENT_REPLIES = [
  'Looking. Error rate on `billing-api` is at 12% :eyes:',
  'Dashboards: <https://grafana.brightwave.dev/d/checkout|Checkout overview>',
  'DB CPU is fine, but the connection pool is maxed out',
  'Started right after the 2.14 deploy, 14:02 UTC',
  '{@} can you check whether the new retry middleware is retrying on 503?',
  'It is. Every 503 triggers 3 immediate retries, no backoff :grimacing:',
  "That's our amplification then",
  'Paging <!subteam^S0DEMOBACK|@backend> for more hands',
  'Customers are reporting failed payments, support has {num} tickets',
  'Status page updated: <https://status.brightwave.dev>',
  'Rolling back `billing-api` to 2.13.4 now',
  'Rollback done, watching the graphs',
  'p95 back to 180ms :white_check_mark:',
  'Error rate below 0.1%',
  'Keeping the incident open for another 30 min',
  'Reprocessing the failed payments with the idempotency keys',
  "Here's the fix:\n```const delay = Math.min(30_000, 250 * 2 ** attempt);\nawait sleep(delay + Math.random() * delay);```",
  'PR with backoff + jitter: {pr}',
  'Approved :+1::skin-tone-3:',
  'Deploying the fix to staging',
  'Load test on staging looks good, p95 {num}ms',
  'Resolved :tada: postmortem draft: {doc}',
];

const PROJECTS = ['Atlas', 'Beacon', 'Comet', 'Nova', 'Orbit'];
const COMPONENTS = [
  'checkout service',
  'billing-api',
  'search indexer',
  'auth gateway',
  'notifications worker',
  'web app',
  'mobile API',
];
const SLUGS = ['invoices', 'customers', 'webhooks', 'sessions', 'reports', 'exports'];
const FLAGS = ['new_checkout', 'dark_mode_v2', 'smart_search', 'bulk_export', 'sso_login'];
const DOC_TITLES = [
  'Q3 planning',
  'Runbook: rollbacks',
  'Postmortem',
  'Hiring plan',
  'Design principles',
  'Onboarding guide',
  'Architecture RFC',
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const REACTIONS = [
  '+1',
  '+1',
  'tada',
  'eyes',
  'white_check_mark',
  'heart',
  'joy',
  'rocket',
  'raised_hands',
  'pray',
  'fire',
  '100',
  'clap::skin-tone-3',
  '+1::skin-tone-2',
  'thinking_face',
  'raised_hands::skin-tone-5',
  'sweat_smile',
];

// =============================================================================================
// Generation state
// =============================================================================================

interface Gen {
  rng: Rng;
  now: number;
  days: number;
  /** Messages per conversation id. */
  messages: Map<string, SlackMessage[]>;
  usedTs: Map<string, Set<string>>;
  files: DemoFile[];
}

function newGen(seed: number, days: number): Gen {
  const now = Math.floor(Date.now() / 1000);
  return { rng: new Rng(seed), now, days, messages: new Map(), usedTs: new Map(), files: [] };
}

/** A unique ts in the conversation at (or just after) `seconds`. */
function allocTs(g: Gen, convId: string, seconds: number): string {
  let used = g.usedTs.get(convId);
  if (!used) g.usedTs.set(convId, (used = new Set()));
  let micros = g.rng.int(100, 999_000);
  let ts = `${Math.floor(seconds)}.${String(micros).padStart(6, '0')}`;
  while (used.has(ts)) {
    micros += 1;
    ts = `${Math.floor(seconds)}.${String(micros).padStart(6, '0')}`;
  }
  used.add(ts);
  return ts;
}

function push(g: Gen, convId: string, msg: SlackMessage): SlackMessage {
  let list = g.messages.get(convId);
  if (!list) g.messages.set(convId, (list = []));
  list.push(msg);
  return msg;
}

function fill(g: Gen, template: string, c: Conv, author: string, at: number): string {
  const r = g.rng;
  const others = c.members.filter((m) => m !== author && !PERSON.get(m)?.bot && canPost(m, at, g.now));
  return template.replace(/\{(@|#|\w+)\}/g, (_, key: string) => {
    switch (key) {
      case '@':
        return `<@${others.length ? r.pick(others) : r.pick(HUMANS)}>`;
      case '#': {
        const target = r.pick(CONVERSATIONS.filter((x) => x.kind === 'channel' && x.id !== c.id && !x.archived));
        return `<#${target.id}|${target.folder}>`;
      }
      case 'proj':
        return r.pick(PROJECTS);
      case 'comp':
        return r.pick(COMPONENTS);
      case 'slug':
        return r.pick(SLUGS);
      case 'flag':
        return r.pick(FLAGS);
      case 'pr': {
        const n = r.int(900, 2400);
        return `<https://github.com/brightwave/app/pull/${n}|#${n}>`;
      }
      case 'ticket': {
        const n = r.int(100, 999);
        return `<https://linear.app/brightwave/issue/BW-${n}|BW-${n}>`;
      }
      case 'doc':
        return `<https://docs.google.com/document/d/${r.hex(20)}/edit|${r.pick(DOC_TITLES)}>`;
      case 'link':
        return `<https://wiki.brightwave.dev/${r.pick(SLUGS)}>`;
      case 'hash':
        return r.hex(22);
      case 'day':
        return r.pick(WEEKDAYS);
      case 'time':
        return `${r.int(8, 17)}:${r.pick(['00', '15', '30', '45'])}`;
      case 'num':
        return String(r.int(3, 97));
      case 'n':
        return String(r.int(2, 9));
      case 'q':
        return String(r.int(1, 4));
      case 'version':
        return `v2.${r.int(10, 30)}.${r.int(0, 9)}`;
      case 'date': {
        const when = at + r.int(2, 20) * DAY;
        const fallback = new Date(when * 1000).toUTCString().slice(0, 16);
        return `<!date^${when}^{date_short_pretty}|${fallback}>`;
      }
      default:
        return key;
    }
  });
}

function canPost(userId: string, at: number, now: number): boolean {
  return !(userId === 'U0DEMODANK' && at > now - DANIEL_LEFT_DAYS_AGO * DAY);
}

// =============================================================================================
// Message factories
// =============================================================================================

function userProfile(p: Person): SlackMessage['user_profile'] {
  const [first] = p.realName.split(' ');
  return {
    avatar_hash: p.id.slice(-4).toLowerCase(),
    first_name: first,
    real_name: p.realName,
    display_name: p.displayName,
    team: TEAM_ID,
    name: p.name,
    is_restricted: false,
    is_ultra_restricted: false,
  };
}

function userMessage(
  g: Gen,
  c: Conv,
  author: string,
  at: number,
  text: string,
  extra: Partial<SlackMessage> = {},
): SlackMessage {
  const p = PERSON.get(author)!;
  const msg: SlackMessage = {
    type: 'message',
    user: author,
    text,
    ts: allocTs(g, c.id, at),
    client_msg_id: `${g.rng.hex(8)}-${g.rng.hex(4)}-4${g.rng.hex(3)}-a${g.rng.hex(3)}-${g.rng.hex(12)}`,
    team: TEAM_ID,
    user_team: TEAM_ID,
    source_team: TEAM_ID,
    user_profile: userProfile(p),
    ...extra,
  };
  decorate(g, c, msg, at);
  return push(g, c.id, msg);
}

/** Edits and reactions, sprinkled at realistic rates. */
function decorate(g: Gen, c: Conv, msg: SlackMessage, at: number): void {
  const r = g.rng;
  const isReply = msg.thread_ts != null && msg.thread_ts !== msg.ts;
  // Draw both numbers unconditionally so scripted fields don't shift the random sequence.
  const edit = r.chance(0.05);
  const react = r.chance(isReply ? 0.08 : c.kind === 'im' ? 0.1 : 0.2);
  if (edit && !msg.edited) {
    const editedAt = Math.min(g.now - 60, at + r.int(30, 3600));
    if (editedAt > at) msg.edited = { user: msg.user, ts: `${editedAt}.000000` };
  }
  if (react && !msg.reactions) msg.reactions = reactions(g, c);
}

function reactions(g: Gen, c: Conv): SlackReaction[] {
  const r = g.rng;
  const names = [...new Set(r.sample(REACTIONS, r.int(1, 3)))];
  const pool = c.members.filter((m) => !PERSON.get(m)?.bot);
  return names.map((name) => {
    const users = [...new Set(r.sample(pool, r.int(1, Math.min(4, pool.length))))];
    return { name, users, count: users.length };
  });
}

function botMessage(g: Gen, c: Conv, bot: Person, at: number, fields: Partial<SlackMessage>): SlackMessage {
  return push(g, c.id, {
    type: 'message',
    subtype: 'bot_message',
    ts: allocTs(g, c.id, at),
    bot_id: bot.bot!.botId,
    username: bot.realName,
    text: '',
    ...fields,
  });
}

function eventMessage(
  g: Gen,
  c: Conv,
  user: string,
  at: number,
  subtype: string,
  text: string,
  extra: Partial<SlackMessage> = {},
): SlackMessage {
  return push(g, c.id, { type: 'message', subtype, user, text, ts: allocTs(g, c.id, at), ...extra });
}

function githubPr(g: Gen, c: Conv, at: number): SlackMessage {
  const r = g.rng;
  const n = r.int(900, 2400);
  const author = PERSON.get(r.pick(['U0DEMOPRIY', 'U0DEMOMARC', 'U0DEMOTOMS', 'U0DEMOLIAM', 'U0DEMOYUKI']))!;
  const merged = r.chance(0.6);
  const title = `${r.pick(['Fix', 'Add', 'Refactor', 'Speed up', 'Remove'])} ${r.pick(COMPONENTS)} ${r.pick(['retries', 'caching', 'logging', 'pagination', 'timeouts'])}`;
  const attachment: SlackAttachment = {
    id: 1,
    color: merged ? '6f42c1' : '2cbe4e',
    fallback: `[brightwave/app] Pull request ${merged ? 'merged' : 'opened'}: #${n} ${title}`,
    pretext: `Pull request ${merged ? 'merged' : 'opened'} by ${author.name}`,
    title: `#${n} ${title}`,
    title_link: `https://github.com/brightwave/app/pull/${n}`,
    text: `${r.pick(['Closes', 'Fixes', 'Relates to'])} BW-${r.int(100, 999)}. ${r.pick(['Adds tests.', 'No behaviour change.', 'Needs a migration.', 'Behind a feature flag.'])}`,
    fields: [
      { title: 'Reviewers', value: `<@${r.pick(HUMANS.slice(0, 7))}>`, short: true },
      { title: 'Labels', value: r.pick(['backend', 'frontend, ui', 'infra', 'bug']), short: true },
    ],
    footer: 'brightwave/app',
    ts: at,
  };
  return botMessage(g, c, GITHUB, at, { attachments: [attachment] });
}

/** Blocks-only bot message: `text` is empty, so the archive derives the text from blocks. */
function deployNotice(g: Gen, c: Conv, at: number): SlackMessage {
  const r = g.rng;
  const service = r.pick(['web', 'billing-api', 'auth-gateway', 'search-indexer']);
  const version = `v2.${r.int(10, 30)}.${r.int(0, 9)}`;
  const ok = r.chance(0.9);
  const blocks: SlackBlock[] = [
    {
      type: 'header',
      block_id: 'h',
      text: { type: 'plain_text', text: ok ? 'Deploy succeeded' : 'Deploy failed', emoji: true },
    },
    {
      type: 'section',
      block_id: 's',
      text: {
        type: 'mrkdwn',
        text: `${ok ? ':white_check_mark:' : ':x:'} *${service}* \`${version}\` → *${r.pick(['production', 'staging'])}* by <@${r.pick(['U0DEMOPRIY', 'U0DEMOMARC', 'U0DEMOLIAM', 'U0DEMOTOMS'])}>`,
      },
      fields: [
        { type: 'mrkdwn', text: `*Commit*\n<https://github.com/brightwave/app/commit/${r.hex(40)}|${r.hex(7)}>` },
        { type: 'mrkdwn', text: `*Duration*\n${r.int(2, 9)}m ${r.int(0, 59)}s` },
      ],
    },
    {
      type: 'context',
      block_id: 'c',
      elements: [{ type: 'mrkdwn', text: `Pipeline #${r.int(10000, 99999)} · <https://ci.brightwave.dev|CI>` }],
    },
  ];
  return botMessage(g, c, DEPLOY_BOT, at, { blocks, icons: { emoji: ':rocket:' } });
}

/** A user message sharing a link that Slack unfurled into an attachment card. */
function unfurlMessage(g: Gen, c: Conv, author: string, at: number): SlackMessage {
  const r = g.rng;
  const article = r.pick([
    {
      url: 'https://engineering.brightwave.dev/posts/scaling-postgres',
      title: 'Scaling Postgres to 10k writes per second',
      service: 'Brightwave Engineering',
      text: 'How we partitioned the invoices table without downtime, and what we would do differently.',
    },
    {
      url: 'https://www.figma.com/blog/design-systems-102',
      title: 'Design Systems 102: How to build your design system',
      service: 'Figma',
      text: 'A practical guide to tokens, components and documentation.',
    },
    {
      url: 'https://github.com/brightwave/app/issues/1834',
      title: 'Checkout fails when the cart has more than 50 items · Issue #1834',
      service: 'GitHub',
      text: 'Steps to reproduce: add 51 items and press *Pay*.',
    },
    {
      url: 'https://blog.brightwave.dev/remote-first',
      title: 'Remote first, not remote only',
      service: 'Brightwave Blog',
      text: 'Three years of running a distributed team across nine time zones.',
    },
  ]);
  const text = `${r.pick(['Worth a read:', 'Interesting:', 'FYI', 'This one is relevant for us'])} <${article.url}>`;
  return userMessage(g, c, author, at, text, {
    attachments: [
      {
        id: 1,
        service_name: article.service,
        title: article.title,
        title_link: article.url,
        text: article.text,
        fallback: `${article.service}: ${article.title}`,
        from_url: article.url,
        original_url: article.url,
      },
    ],
  });
}

// =============================================================================================
// Threads
// =============================================================================================

function replyCount(r: Rng): number {
  const x = r.next();
  if (x < 0.6) return r.int(1, 3);
  if (x < 0.88) return r.int(4, 9);
  if (x < 0.97) return r.int(10, 20);
  return r.int(21, 34);
}

/** Adds replies to `parent` and fills in the parent's thread metadata the way Slack exports do. */
function addThread(g: Gen, c: Conv, parent: SlackMessage, count: number, lines?: readonly string[]): void {
  const r = g.rng;
  const start = Number(parent.ts);
  const pool = c.members.filter((m) => !PERSON.get(m)?.bot && canPost(m, start, g.now));
  const participants = [
    ...new Set([...r.sample(pool, r.int(1, Math.min(4, pool.length))), parent.user ?? r.pick(pool)]),
  ];
  let at = start;
  const replies: SlackMessage[] = [];
  for (let i = 0; i < count; i++) {
    at += r.chance(0.1) ? r.int(2 * 3600, 30 * 3600) : r.int(30, 20 * 60);
    if (at > g.now - 60) break;
    const author = r.pick(participants);
    // Scripted lines first, then ordinary chatter once the story has been told.
    const template = lines && i < lines.length ? lines[i] : r.pick(REPLIES);
    const broadcast = i > 0 && c.kind !== 'im' && r.chance(lines ? 0.08 : 0.04);
    const extra: Partial<SlackMessage> = { thread_ts: parent.ts, parent_user_id: parent.user };
    if (broadcast) {
      extra.subtype = 'thread_broadcast';
      extra.root = { ts: parent.ts, user: parent.user, text: parent.text, thread_ts: parent.ts };
    }
    replies.push(userMessage(g, c, author, at, fill(g, template, c, author, at), extra));
  }
  if (!replies.length) return;
  const users = [...new Set(replies.map((m) => m.user!))];
  Object.assign(parent, {
    thread_ts: parent.ts,
    reply_count: replies.length,
    reply_users_count: users.length,
    latest_reply: replies[replies.length - 1].ts,
    reply_users: users.slice(0, 5),
    replies: replies.map((m) => ({ user: m.user, ts: m.ts })),
    is_locked: false,
    subscribed: parent.user === SELF,
  });
}

// =============================================================================================
// Daily chatter
// =============================================================================================

function isActive(c: Conv, daysAgo: number): boolean {
  return daysAgo <= c.activeFrom && daysAgo >= c.activeTo;
}

function generateChatter(g: Gen): void {
  const r = g.rng;
  for (let daysAgo = g.days; daysAgo >= 0; daysAgo--) {
    const dayStart = Math.floor((g.now - daysAgo * DAY) / DAY) * DAY;
    const weekday = new Date(dayStart * 1000).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // A gentle ramp: the team (and its Slack usage) grew over the period.
    const growth = 0.75 + 0.35 * (1 - daysAgo / g.days);
    for (const c of CONVERSATIONS) {
      if (!isActive(c, daysAgo)) continue;
      const mean = c.rate * RATE_SCALE * growth * (weekend ? 0.12 : 1);
      generateDay(g, c, dayStart, r.poisson(mean));
    }
  }
}

/** Messages arrive in short bursts; consecutive lines by one author collapse in the UI. */
function generateDay(g: Gen, c: Conv, dayStart: number, count: number): void {
  const r = g.rng;
  let remaining = count;
  while (remaining > 0) {
    const burst = Math.min(remaining, r.int(1, 4));
    remaining -= burst;
    let at = dayStart + r.int(7 * 3600, 18 * 3600);
    let author = pickAuthor(g, c, at);
    for (let i = 0; i < burst && at < g.now - 600 && author; i++) {
      oneMessage(g, c, author, at);
      at += r.int(15, 240);
      if (!r.chance(0.35)) author = pickAuthor(g, c, at) ?? author;
    }
  }
}

function pickAuthor(g: Gen, c: Conv, at: number): string | null {
  const pool = c.members.filter((m) => !PERSON.get(m)?.bot && canPost(m, at, g.now));
  if (!pool.length) return null;
  // Jordan (the archive owner) talks a bit more than average in every conversation.
  return g.rng.chance(0.22) && pool.includes(SELF) ? SELF : g.rng.pick(pool);
}

function oneMessage(g: Gen, c: Conv, author: string, at: number): void {
  const r = g.rng;
  if (c.theme === 'deploys') {
    if (r.chance(0.55)) deployNotice(g, c, at);
    else if (r.chance(0.5)) githubPr(g, c, at);
    else userMessage(g, c, author, at, fill(g, r.pick(TEMPLATES.deploys), c, author, at));
    return;
  }
  if (c.id === 'C0DEMOENGR' && r.chance(0.08)) {
    githubPr(g, c, at);
    return;
  }
  if ((c.kind === 'channel' || c.kind === 'private') && r.chance(0.04)) {
    unfurlMessage(g, c, author, at);
    return;
  }
  const msg = userMessage(g, c, author, at, fill(g, r.pick(TEMPLATES[c.theme]), c, author, at));
  if (r.chance(c.threadP)) addThread(g, c, msg, replyCount(r));
}

// =============================================================================================
// Scripted moments (so the demo has memorable things to search for)
// =============================================================================================

function atDaysAgo(g: Gen, daysAgo: number, hour: number, minute = 0): number {
  return Math.floor((g.now - daysAgo * DAY) / DAY) * DAY + hour * 3600 + minute * 60;
}

function generateStories(g: Gen): void {
  const general = conv('C0DEMOGENL');
  const eng = conv('C0DEMOENGR');
  const atlas = conv('C0DEMOATLS');
  const design = conv('C0DEMODSGN');

  // Channel lifecycle events.
  for (const c of CONVERSATIONS.filter((x) => x.kind === 'channel' || x.kind === 'private')) {
    const from = Math.min(g.days, c.activeFrom);
    const creator = c.members.includes(SELF) ? SELF : c.members[0];
    eventMessage(g, c, creator, atDaysAgo(g, from, 6, 5), 'channel_join', `<@${creator}> has joined the channel`);
  }
  eventMessage(
    g,
    general,
    'U0DEMOZARA',
    atDaysAgo(g, 64, 8, 1),
    'channel_join',
    '<@U0DEMOZARA> has joined the channel',
  );
  userMessage(
    g,
    general,
    'U0DEMOOLIV',
    atDaysAgo(g, 64, 8, 30),
    'Please welcome <@U0DEMOZARA>, our first QA engineer! :wave::skin-tone-4: :tada:',
    {
      reactions: [
        { name: 'wave::skin-tone-2', users: ['U0DEMOPRIY', 'U0DEMOTOMS', SELF], count: 3 },
        { name: 'tada', users: ['U0DEMOAISH', 'U0DEMONOAH'], count: 2 },
      ],
    },
  );
  eventMessage(
    g,
    eng,
    'U0DEMOLIAM',
    atDaysAgo(g, 30, 9, 2),
    'channel_topic',
    'set the channel topic: On call this week: <@U0DEMOLIAM> | Runbooks: <https://wiki.brightwave.dev/runbooks|wiki>',
    {
      topic: 'On call this week: <@U0DEMOLIAM>',
    },
  );

  // Daniel's farewell, before his account was deactivated.
  userMessage(
    g,
    general,
    'U0DEMODANK',
    atDaysAgo(g, DANIEL_LEFT_DAYS_AGO + 1, 16),
    'Last day today, it was a pleasure &amp; an honour. Keep shipping :wave::skin-tone-3: :heart:',
    {
      reactions: [{ name: 'heart', users: [SELF, 'U0DEMOPRIY', 'U0DEMOMARC', 'U0DEMOAISH'], count: 4 }],
    },
  );

  // The incident: a long thread with broadcasts, code and a chart image.
  const incidentAt = atDaysAgo(g, 45, 14, 9);
  const incident = userMessage(
    g,
    eng,
    'U0DEMOLIAM',
    incidentAt,
    ':rotating_light: *Incident*: checkout latency is spiking in production, p95 at 4.2s and climbing. Investigating. <!here>',
    {
      reactions: [{ name: 'eyes', users: [SELF, 'U0DEMOPRIY', 'U0DEMOMARC'], count: 3 }],
    },
  );
  addThread(g, eng, incident, 38, INCIDENT_REPLIES);
  const chartAt = Number(incident.ts) + 25 * 60;
  const chart = userMessage(
    g,
    eng,
    'U0DEMOPRIY',
    chartAt,
    'p95 latency during the incident, the drop is the rollback',
    {
      thread_ts: incident.ts,
      parent_user_id: incident.user,
      upload: true,
    },
  );
  attachFile(g, chart, 'U0DEMOPRIY', {
    id: 'F0DEMOPNG02',
    name: 'latency-p95.png',
    title: 'p95 latency',
    kind: 'png',
    paint: 'chart',
    w: 600,
    h: 300,
  });
  bumpThread(incident, chart);

  userMessage(
    g,
    eng,
    SELF,
    atDaysAgo(g, 44, 10),
    "Postmortem for yesterday's checkout incident is up: <https://docs.google.com/document/d/1incidentpm|Checkout latency postmortem>. Action items:\n1. Backoff + jitter everywhere\n2. Alert on pool saturation\n3. Load test retries before release",
    {
      reactions: [{ name: 'pray', users: ['U0DEMOLIAM', 'U0DEMOAISH'], count: 2 }],
    },
  );

  // Atlas: kickoff, milestones, then the channel is archived.
  const kickoff = userMessage(
    g,
    atlas,
    'U0DEMOAISH',
    atDaysAgo(g, 194, 10),
    '*Project Atlas kickoff* :rocket:\nGoal: one data platform for analytics &amp; billing by the end of the quarter.\n• Owner: <@U0DEMOPRIY>\n• Design: <@U0DEMOSOFI>\n• Weekly demo on Thursdays',
  );
  addThread(g, atlas, kickoff, 12);
  userMessage(
    g,
    atlas,
    'U0DEMOPRIY',
    atDaysAgo(g, 113, 15),
    'Atlas is live for all customers :tada: :tada: Thanks everyone, archiving this channel tomorrow. Follow-ups go to <#C0DEMOENGR|engineering>',
    {
      reactions: [
        { name: 'tada', users: [SELF, 'U0DEMOAISH', 'U0DEMOMARC', 'U0DEMOYUKI'], count: 4 },
        { name: 'rocket', users: ['U0DEMOAISH'], count: 1 },
      ],
    },
  );
  eventMessage(g, atlas, 'U0DEMOPRIY', atDaysAgo(g, 112, 9), 'channel_archive', '<@U0DEMOPRIY> archived the channel');

  // Files.
  const mockup = userMessage(
    g,
    design,
    'U0DEMOSOFI',
    atDaysAgo(g, 12, 11),
    'Latest onboarding mockups, feedback welcome :art:',
    { upload: true },
  );
  attachFile(g, mockup, 'U0DEMOSOFI', {
    id: 'F0DEMOPNG01',
    name: 'onboarding-mockup-v3.png',
    title: 'Onboarding mockup v3',
    kind: 'png',
    paint: 'mockup',
    w: 640,
    h: 400,
  });
  addThread(g, design, mockup, 6);

  const logos = userMessage(
    g,
    design,
    'U0DEMOSOFI',
    atDaysAgo(g, 100, 14),
    'Logo explorations for the rebrand, 4 directions',
    { upload: true },
  );
  attachFile(g, logos, 'U0DEMOSOFI', {
    id: 'F0DEMOPNG05',
    name: 'logo-explorations.png',
    title: 'Logo explorations',
    kind: 'png',
    paint: 'logo',
    w: 480,
    h: 480,
  });

  // An old upload Slack Free no longer serves: the export only has a stub.
  const moodboard = userMessage(g, design, 'U0DEMOSOFI', atDaysAgo(g, 130, 13), 'Moodboard from the brand workshop', {
    upload: true,
  });
  moodboard.files = [{ id: 'F0DEMOHIDE1', mode: 'hidden_by_limit' }];

  const offsite = userMessage(
    g,
    conv('C0DEMORAND'),
    'U0DEMOTOMS',
    atDaysAgo(g, 70, 19),
    'Offsite views :sunny: :camera_with_flash:',
    { upload: true },
  );
  attachFile(g, offsite, 'U0DEMOTOMS', {
    id: 'F0DEMOPNG03',
    name: 'offsite-sunset.png',
    title: 'Offsite sunset',
    kind: 'png',
    paint: 'sunset',
    w: 600,
    h: 360,
  });

  const shot = userMessage(
    g,
    conv('D0DEMOPRIY'),
    'U0DEMOPRIY',
    atDaysAgo(g, 5, 10, 32),
    'This is what I see on staging, is that expected?',
    { upload: true },
  );
  attachFile(g, shot, 'U0DEMOPRIY', {
    id: 'F0DEMOPNG04',
    name: `Screenshot ${isoDay(atDaysAgo(g, 5, 10))} at 10.32.11.png`,
    title: 'Screenshot',
    kind: 'png',
    paint: 'screenshot',
    w: 720,
    h: 450,
  });

  const roadmap = userMessage(
    g,
    conv('C0DEMOLEAD'),
    'U0DEMOAISH',
    atDaysAgo(g, 30, 9, 40),
    'Q4 roadmap draft attached, please comment by Friday. Numbers are *confidential*',
    { upload: true },
  );
  attachFile(g, roadmap, 'U0DEMOAISH', { id: 'F0DEMOPDF01', name: 'Q4 roadmap.pdf', title: 'Q4 roadmap', kind: 'pdf' });
  addThread(g, conv('C0DEMOLEAD'), roadmap, 5);

  const report = userMessage(
    g,
    eng,
    'U0DEMOLIAM',
    atDaysAgo(g, 20, 16),
    'Load test report from last night (HTML export from k6)',
    { upload: true },
  );
  attachFile(g, report, 'U0DEMOLIAM', {
    id: 'F0DEMOHTML1',
    name: 'load-test-report.html',
    title: 'Load test report',
    kind: 'html',
  });

  const notes = userMessage(
    g,
    conv('C0DEMODPLY'),
    'U0DEMOMARC',
    atDaysAgo(g, 8, 17),
    'Deploy notes for v2.21, heads-up on the migration',
    { upload: true },
  );
  attachFile(g, notes, 'U0DEMOMARC', {
    id: 'F0DEMOTEXT1',
    name: 'deploy-notes.txt',
    title: 'deploy-notes.txt',
    kind: 'txt',
    standardLayout: true,
  });

  // A file the export didn't include: it stays "pending" (API mode could fetch it later).
  const recording = userMessage(
    g,
    general,
    'U0DEMOOLIV',
    atDaysAgo(g, 3, 17),
    "Recording of today's all-hands for those who missed it :movie_camera:",
    { upload: true },
  );
  attachFile(g, recording, 'U0DEMOOLIV', {
    id: 'F0DEMOVID01',
    name: 'all-hands-recording.mp4',
    title: 'All-hands recording',
    kind: 'missing',
  });
}

/** Keeps a parent's thread metadata right after a scripted reply is added. */
function bumpThread(parent: SlackMessage, reply: SlackMessage): void {
  const replies = [
    ...((parent.replies as { user?: string; ts: string }[] | undefined) ?? []),
    { user: reply.user, ts: reply.ts },
  ];
  replies.sort((a, b) => Number(a.ts) - Number(b.ts));
  parent.replies = replies;
  parent.reply_count = replies.length;
  parent.latest_reply = replies[replies.length - 1].ts;
  const users = [...new Set(replies.map((x) => x.user).filter((u): u is string => !!u))];
  parent.reply_users = users.slice(0, 5);
  parent.reply_users_count = users.length;
}

function isoDay(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

// =============================================================================================
// Files: tiny but valid PNG / PDF / HTML / text payloads
// =============================================================================================

interface DemoFileSpec {
  id: string;
  name: string;
  title: string;
  kind: 'png' | 'pdf' | 'html' | 'txt' | 'missing';
  paint?: Paint;
  w?: number;
  h?: number;
  /** Store under `<conversation>/attachments/<id>-<name>` (slackdump "standard") instead of __uploads. */
  standardLayout?: boolean;
}

interface DemoFile extends DemoFileSpec {
  folder: string;
  bytes: Buffer | null;
}

const MIME: Record<DemoFileSpec['kind'], [string, string, string]> = {
  png: ['image/png', 'png', 'PNG'],
  pdf: ['application/pdf', 'pdf', 'PDF'],
  html: ['text/html', 'html', 'HTML'],
  txt: ['text/plain', 'text', 'Plain Text'],
  missing: ['video/mp4', 'mp4', 'MPEG 4 Video'],
};

function attachFile(g: Gen, msg: SlackMessage, userId: string, spec: DemoFileSpec): void {
  const bytes = fileBytes(spec);
  const folder = CONVERSATIONS.find((c) => g.messages.get(c.id)?.includes(msg))!.folder;
  g.files.push({ ...spec, folder, bytes: spec.kind === 'missing' ? null : bytes });
  const created = Math.floor(Number(msg.ts)) - 5;
  const [mimetype, filetype, prettyType] = MIME[spec.kind];
  const slug = spec.name.toLowerCase().replace(/[^a-z0-9.]+/g, '_');
  const base = `https://files.slack.com/files-pri/${TEAM_ID}-${spec.id}`;
  const file: SlackFile = {
    id: spec.id,
    created,
    timestamp: created,
    name: spec.name,
    title: spec.title,
    mimetype,
    filetype,
    pretty_type: prettyType,
    user: userId,
    user_team: TEAM_ID,
    editable: false,
    size: bytes.length,
    mode: 'hosted',
    is_external: false,
    external_type: '',
    is_public: true,
    public_url_shared: false,
    url_private: `${base}/${slug}`,
    url_private_download: `${base}/download/${slug}`,
    permalink: `https://${TEAM_DOMAIN}.slack.com/files/${userId}/${spec.id}/${slug}`,
  };
  if (spec.kind === 'png' && spec.w && spec.h) {
    Object.assign(file, {
      original_w: spec.w,
      original_h: spec.h,
      thumb_360: `https://files.slack.com/files-tmb/${TEAM_ID}-${spec.id}-${spec.id.slice(-4).toLowerCase()}/${slug}_360.png`,
      thumb_360_w: 360,
      thumb_360_h: Math.round((360 * spec.h) / spec.w),
    });
  }
  if (spec.kind === 'pdf')
    file.thumb_pdf = `https://files.slack.com/files-tmb/${TEAM_ID}-${spec.id}-pdf/${slug}_thumb_pdf.png`;
  if (spec.kind === 'missing') file.size = 48_318_210;
  msg.files = [...(msg.files ?? []), file];
}

function fileBytes(spec: DemoFileSpec): Buffer {
  switch (spec.kind) {
    case 'png':
      return makePng(spec.w ?? 320, spec.h ?? 200, PAINTERS[spec.paint ?? 'mockup']);
    case 'pdf':
      return makePdf([
        'Brightwave - Q4 roadmap (draft)',
        'CONFIDENTIAL - demo data, not a real company',
        '',
        '1. Atlas v2: self-serve dashboards for every customer',
        '2. Checkout reliability: backoff + jitter, pool saturation alerts',
        '3. Mobile: offline mode for field teams',
        '4. Hiring: 2 backend engineers, 1 product designer',
      ]);
    case 'html':
      return Buffer.from(
        '<!doctype html>\n<html><head><meta charset="utf-8"><title>Load test report</title></head>\n<body>\n<h1>k6 load test: checkout</h1>\n<table border="1"><tr><th>Scenario</th><th>RPS</th><th>p95</th></tr>\n<tr><td>baseline</td><td>2000</td><td>182 ms</td></tr>\n<tr><td>retry storm</td><td>2000</td><td>4210 ms</td></tr></table>\n<script>document.title = "served inline would run this script";</script>\n</body></html>\n',
      );
    case 'txt':
      return Buffer.from(
        'Deploy notes v2.21\n==================\n\n- Runs migration 0042 (adds invoices.retry_count), ~2 min lock on invoices\n- Feature flag new_checkout stays at 50%\n- Rollback: redeploy v2.20.3, migration is backwards compatible\n',
      );
    case 'missing':
      return Buffer.alloc(0);
  }
}

// =============================================================================================
// The follow-up export: what a later sync would see (edits, deletions, new reactions)
// =============================================================================================

interface Update {
  convId: string;
  message: SlackMessage;
}

function generateUpdate(g: Gen): Update[] {
  const r = g.rng;
  const recent = (m: SlackMessage) => Number(m.ts) > g.now - 80 * DAY && Number(m.ts) < g.now - 2 * DAY;
  const candidates: Update[] = [];
  for (const c of CONVERSATIONS) {
    for (const m of g.messages.get(c.id) ?? []) {
      if (recent(m) && m.user && !m.subtype && !m.files && (m.text ?? '').length > 25)
        candidates.push({ convId: c.id, message: m });
    }
  }
  const updates: Update[] = [];
  const chosen = r.sample(candidates, 40);

  // Edits: each becomes a revision in the archive, the old text stays visible in the popover.
  for (const { convId, message } of chosen.slice(0, 14)) {
    const previousEdit = Number(message.edited?.ts ?? message.ts);
    const editedAt = Math.min(g.now - 3600, previousEdit + r.int(2 * 3600, 36 * 3600));
    if (editedAt <= previousEdit) continue;
    const text = r.chance(0.5)
      ? `${message.text}\n_Update: ${r.pick(['resolved, thanks all', 'moved to next week', 'see the thread for details', 'fixed the link above'])}_`
      : (message.text ?? '')
          .replace(/\b(today|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday)\b/, 'next week')
          .concat(r.pick([' :pencil2:', ' (edited for clarity)']));
    updates.push({ convId, message: { ...message, text, edited: { user: message.user, ts: `${editedAt}.000000` } } });
  }

  // New reactions that arrived after the first import.
  for (const { convId, message } of chosen.slice(14, 22)) {
    const extra = { name: r.pick(['tada', 'heart', 'fire', 'eyes']), users: [r.pick(HUMANS.slice(0, 12))], count: 1 };
    const existing = (message.reactions ?? []).filter((x) => x.name !== extra.name);
    updates.push({ convId, message: { ...message, reactions: [...existing, extra] } });
  }

  // Deleted in Slack: thread parents become tombstones; the archive keeps what it saw.
  const touched = new Set(updates.map((u) => `${u.convId}/${u.message.ts}`));
  const parents = CONVERSATIONS.flatMap((c) =>
    (g.messages.get(c.id) ?? [])
      .filter(
        (m) =>
          recent(m) && m.user && !m.subtype && (m.reply_count ?? 0) > 0 && !m.files && !touched.has(`${c.id}/${m.ts}`),
      )
      .map((m) => ({ convId: c.id, message: m })),
  );
  for (const { convId, message } of r.sample(parents, 3)) {
    updates.push({
      convId,
      message: {
        type: 'message',
        subtype: 'tombstone',
        text: 'This message was deleted.',
        user: 'USLACKBOT',
        hidden: true,
        ts: message.ts,
        thread_ts: message.ts,
        reply_count: message.reply_count,
        reply_users: message.reply_users,
        reply_users_count: message.reply_users_count,
        latest_reply: message.latest_reply,
        replies: message.replies,
      },
    });
  }
  return updates;
}

// =============================================================================================
// Writing the archive
// =============================================================================================

function slackUsers(): SlackUser[] {
  return PEOPLE.map((p) => ({
    id: p.id,
    team_id: TEAM_ID,
    name: p.name,
    deleted: !!p.deleted,
    real_name: p.realName,
    is_bot: !!p.bot,
    is_app_user: false,
    profile: {
      title: p.title,
      real_name: p.realName,
      display_name: p.displayName,
      ...(p.bot ? { bot_id: p.bot.botId, api_app_id: p.bot.appId } : {}),
      // Avatars are data: URLs so the demo shows faces without any network access.
      image_72: avatarDataUrl(p),
    },
  }));
}

const AVATAR_COLORS: [number, number, number][] = [
  [79, 70, 229],
  [220, 38, 38],
  [5, 150, 105],
  [217, 119, 6],
  [37, 99, 235],
  [147, 51, 234],
  [219, 39, 119],
  [8, 145, 178],
];

function avatarDataUrl(p: Person): string {
  const [r, g, b] = AVATAR_COLORS[PEOPLE.indexOf(p) % AVATAR_COLORS.length];
  const png = makePng(48, 48, (x, y) => {
    const dx = x - 24;
    const head = dx * dx + (y - 18) ** 2 < 81;
    const body = dx * dx + (y - 46) ** 2 < 300;
    return head || body ? [255, 255, 255] : [r, g, b];
  });
  return `data:image/png;base64,${png.toString('base64')}`;
}

function slackConversations(): SlackConversation[] {
  return CONVERSATIONS.map((c): SlackConversation => {
    const created = 1_690_000_000 + CONVERSATIONS.indexOf(c) * 3_600;
    const common = { id: c.id, created, is_archived: !!c.archived, is_member: true };
    const text = (value?: string) => ({
      value: value ?? '',
      creator: value ? SELF : '',
      last_set: value ? created : 0,
    });
    switch (c.kind) {
      case 'channel':
        return {
          ...common,
          name: c.folder,
          is_channel: true,
          topic: text(c.topic),
          purpose: text(c.purpose),
          members: c.members,
        };
      case 'private':
        return {
          ...common,
          name: c.folder,
          is_group: true,
          is_private: true,
          topic: text(c.topic),
          purpose: text(c.purpose),
          members: c.members,
        };
      case 'im':
        return { ...common, is_im: true, user: c.members[1] };
      case 'mpim':
        return { ...common, name: c.folder, is_mpim: true, members: c.members };
    }
  });
}

/** Custom emoji as data: URLs (the demo needs no network), plus an alias of a standard emoji. */
function customEmoji(): Record<string, string> {
  const dot = (rgb: [number, number, number]) =>
    `data:image/png;base64,${makePng(32, 32, (x, y) => ((x - 16) ** 2 + (y - 16) ** 2 < 196 ? rgb : [255, 255, 255])).toString('base64')}`;
  return {
    brightwave: dot([79, 70, 229]),
    shipit: dot([5, 150, 105]),
    'on-fire': dot([220, 38, 38]),
    yay: 'alias:tada',
    bw: 'alias:brightwave',
  };
}

function writeFiles(db: DB, out: string, g: Gen): number {
  let written = 0;
  for (const f of g.files) {
    if (!f.bytes) continue;
    const rel = path.join(f.id, f.name.replace(/[\\/:*?"<>|]/g, '_'));
    const abs = path.join(out, 'files', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.bytes);
    markFileDownloaded(db, f.id, rel);
    written++;
  }
  return written;
}

function resetOutDir(out: string): void {
  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out);
    if (entries.length && !entries.includes(MARKER)) {
      throw new Error(`${out} exists and wasn't created by this script; refusing to overwrite it. Pick another --out.`);
    }
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, MARKER), 'Synthetic demo archive written by scripts/seed.ts. Safe to delete.\n');
}

function shown(p: string): string {
  const rel = path.relative(ROOT, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

/** Messages per day at RATE_SCALE 1.6 is ~45; big targets also get a longer history. */
function planScale(opts: Options): { days: number; scale: number } {
  const days = opts.days ?? (opts.messages <= 20_000 ? 200 : Math.min(1500, Math.round(200 + opts.messages / 400)));
  const perDayAtBase = 45;
  return { days, scale: Math.max(0.2, (1.6 * opts.messages) / (perDayAtBase * days)) };
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const { days, scale } = planScale(opts);
  RATE_SCALE = scale;
  const started = Date.now();
  const g = newGen(opts.seed, days);
  generateStories(g);
  generateChatter(g);
  const updates = generateUpdate(g);

  resetOutDir(opts.out);
  const db = openDb(path.join(opts.out, 'archive.db'));
  const filesDir = path.join(opts.out, 'files');
  setMeta(db, 'team_id', TEAM_ID);
  setMeta(db, 'team_name', TEAM_NAME);
  setMeta(db, 'team_domain', TEAM_DOMAIN);
  setMeta(db, 'self_user_id', SELF);
  upsertUsers(db, slackUsers());
  upsertConversations(db, slackConversations(), { selfUserId: SELF });
  let total = 0;
  for (const c of CONVERSATIONS) {
    const msgs = g.messages.get(c.id) ?? [];
    for (let i = 0; i < msgs.length; i += 5000) {
      total += upsertMessages(db, c.id, msgs.slice(i, i + 5000), 'api', { filesDir }).inserted;
    }
  }
  const files = writeFiles(db, opts.out, g);
  upsertCustomEmoji(db, customEmoji());
  // A later "sync": edits become revisions, deletions keep their text with a badge.
  let revisions = 0;
  for (const u of updates) revisions += upsertMessages(db, u.convId, [u.message], 'api', { filesDir }).revisions;
  db.pragma('optimize');
  db.close();

  const all = CONVERSATIONS.flatMap((c) => g.messages.get(c.id) ?? []);
  const replies = all.filter((m) => m.thread_ts && m.thread_ts !== m.ts).length;
  const old = all.filter((m) => Number(m.ts) < g.now - 90 * DAY).length;
  console.log(`Synthetic archive written to ${shown(opts.out)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  ${PEOPLE.length} users, ${CONVERSATIONS.length} conversations, ${days} days`);
  console.log(`  ${total} messages (${replies} thread replies, ${old} older than 90 days)`);
  console.log(`  ${files} attachments on disk, ${revisions} edits recorded as revisions`);
  console.log(`\nOpen it with: npm run dev:demo`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
