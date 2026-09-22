/**
 * People: the list's sections, local times across time zones, and the question "Brief me" hands
 * to Ask AI. Pure helpers; the screens are pages/PeoplePage.tsx and pages/PersonPage.tsx.
 */
import type { PersonSummaryDTO, UserDTO } from '../../shared/types';

export type PeopleSectionId = 'talk' | 'channels' | 'left';

export interface PeopleSection {
  id: PeopleSectionId;
  title: string;
  people: PersonSummaryDTO[];
}

const SECTION_TITLES: Record<PeopleSectionId, string> = {
  talk: 'People you message',
  channels: 'In your channels',
  left: 'Left the workspace',
};

const newest = (a: string | null, b: string | null) => Number(b ?? 0) - Number(a ?? 0);

/**
 * People you DM or share a group DM with, most recently first; then people you only see in
 * channels, by their latest message; then people deactivated in Slack, whose messages stay here.
 * The filter matches names, the Slack handle and the title.
 */
export function peopleSections(
  people: readonly PersonSummaryDTO[],
  users: ReadonlyMap<string, UserDTO>,
  filter = '',
): PeopleSection[] {
  const needle = filter.trim().toLowerCase();
  const sections: Record<PeopleSectionId, PersonSummaryDTO[]> = { talk: [], channels: [], left: [] };
  for (const p of people) {
    const user = users.get(p.userId);
    if (needle && !matches(p, user, needle)) continue;
    if (user?.deleted) sections.left.push(p);
    else if (p.lastTalkedTs) sections.talk.push(p);
    else sections.channels.push(p);
  }
  sections.talk.sort((a, b) => newest(a.lastTalkedTs, b.lastTalkedTs));
  sections.channels.sort((a, b) => newest(a.lastMessageTs, b.lastMessageTs));
  sections.left.sort((a, b) => newest(a.lastTalkedTs ?? a.lastMessageTs, b.lastTalkedTs ?? b.lastMessageTs));
  return (['talk', 'channels', 'left'] as const)
    .map((id) => ({ id, title: SECTION_TITLES[id], people: sections[id] }))
    .filter((s) => s.people.length > 0);
}

function matches(p: PersonSummaryDTO, user: UserDTO | undefined, needle: string): boolean {
  return [user?.label, user?.realName, user?.displayName, user?.name, p.title].some((v) =>
    v?.toLowerCase().includes(needle),
  );
}

/** "Dana Whitfield" → "Dana": how the page names someone in its headings. */
export function firstName(label: string): string {
  const first = label.trim().split(/\s+/)[0] ?? '';
  return first.length >= 2 ? first : label.trim();
}

// ─── time zones ─────────────────────────────────────────────────────────────────────────────

export interface LocalTimeInfo {
  /** Their clock now, e.g. "4:12 PM". */
  time: string;
  /** Minutes their clock is ahead of the reader's (negative: behind). */
  diffMinutes: number;
}

/** Their local time from an IANA zone; null when the zone is unknown to this computer. */
export function localTimeIn(tz: string, now: Date): LocalTimeInfo | null {
  try {
    const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(now);
    const theirs = offsetMinutes(tz, now);
    if (theirs == null) return null;
    return { time, diffMinutes: theirs - -now.getTimezoneOffset() };
  } catch {
    return null;
  }
}

/** A zone's offset from UTC at `date`, in minutes ("GMT+05:30" → 330). */
function offsetMinutes(tz: string, date: Date): number | null {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  if (name === 'GMT') return 0;
  const m = name ? /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name) : null;
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -minutes : minutes;
}

/** "1 hour ahead", "3½ hours ahead", "2 hours behind", "45 minutes ahead"; null when the same. */
export function timeDifferenceLabel(diffMinutes: number): string | null {
  if (diffMinutes === 0) return null;
  const direction = diffMinutes > 0 ? 'ahead' : 'behind';
  const total = Math.abs(diffMinutes);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  let amount: string;
  if (minutes === 0) amount = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  else if (minutes === 30) amount = hours === 0 ? '30 minutes' : `${hours}½ hours`;
  else if (hours === 0) amount = `${minutes} minutes`;
  else amount = `${hours} h ${minutes} min`;
  return `${amount} ${direction}`;
}

// ─── links ─────────────────────────────────────────────────────────────────────────────────

/** "https://docs.google.com/document/d/abc/edit?tab=1" → "docs.google.com/document/d/abc/edit". */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

// ─── Ask AI ────────────────────────────────────────────────────────────────────────────────

/**
 * What "Brief me" puts in Ask AI's box. The Slack handle lets Claude search `from:` and `in:@`
 * for them; the question names what's worth knowing before talking to someone.
 */
export function briefQuestion(user: Pick<UserDTO, 'label' | 'realName' | 'name'>): string {
  const name = user.realName || user.label;
  const who = user.name && user.name !== name ? `${name} (@${user.name})` : name;
  return (
    `Brief me on ${who} before we talk: what we’re working on together, what we decided lately, ` +
    `and what’s still open between us (questions either of us hasn’t answered, anything I promised).`
  );
}
