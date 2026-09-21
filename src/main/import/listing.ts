import type { SlackConversation, SlackMessage, SlackUser } from '../slack/types';
import { looksLikeConversationId, type ListingName } from './layout';

/**
 * Turns an export's listing files (users/channels/groups/dms/mpims.json) into the Slack shapes
 * the db layer understands, and maps conversation folders to conversation ids.
 */

export type Listings = Partial<Record<ListingName, Record<string, unknown>[]>>;

/** Parses one listing file. Malformed listings abort the import before anything is written. */
export function parseListing(name: ListingName, text: string): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`Malformed Slack export: ${name}.json is not valid JSON (${(err as Error).message})`, {
      cause: err,
    });
  }
  if (!Array.isArray(value)) throw new Error(`Malformed Slack export: ${name}.json must contain a JSON array`);
  return value.filter(hasStringId);
}

function hasStringId(v: unknown): v is Record<string, unknown> & { id: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { id?: unknown }).id === 'string' &&
    (v as { id: string }).id !== ''
  );
}

function membersOf(entry: Record<string, unknown>): string[] {
  const m = entry.members;
  return Array.isArray(m) ? [...new Set(m.filter((x): x is string => typeof x === 'string' && x !== ''))] : [];
}

/**
 * The exporting user is the only member present in every dms.json entry (slackdump writes
 * `[other, me]`, a self-DM as `[me, me]`). With a single DM both members qualify, so the
 * answer is ambiguous and we return null rather than guess.
 */
export function exportingUserFromDms(dms: readonly Record<string, unknown>[] | undefined): string | null {
  const lists = (dms ?? []).map(membersOf).filter((m) => m.length > 0);
  if (lists.length === 0) return null;
  let common = new Set(lists[0]);
  for (const members of lists.slice(1)) common = new Set(members.filter((m) => common.has(m)));
  return common.size === 1 ? [...common][0] : null;
}

export interface ConversationPlan {
  conversations: SlackConversation[];
  /** Folder name (conversation name or id) → conversation id. */
  folderToConversation: Map<string, string>;
}

/**
 * The listing file decides the type (the export entries carry no reliable flags). slackdump
 * also puts modern private channels (`is_private: true`, `is_group: false`) into channels.json,
 * so explicit privacy flags on an entry are kept.
 */
export function planConversations(listings: Listings, selfUserId: string | null): ConversationPlan {
  const plan: ConversationPlan = { conversations: [], folderToConversation: new Map() };
  const add = (conv: SlackConversation, folderNames: (string | undefined)[]): void => {
    plan.conversations.push(conv);
    for (const name of folderNames) {
      if (name && !plan.folderToConversation.has(name)) plan.folderToConversation.set(name, conv.id);
    }
  };
  for (const c of listings.channels ?? []) add(asConversation(c, { is_channel: true }), [c.id as string, nameOf(c)]);
  for (const c of listings.groups ?? []) add(asConversation(c, { is_private: true }), [c.id as string, nameOf(c)]);
  for (const c of listings.mpims ?? []) add(asConversation(c, { is_mpim: true }), [c.id as string, nameOf(c)]);
  for (const d of listings.dms ?? []) add(dmConversation(d, selfUserId), [d.id as string]);
  return plan;
}

function nameOf(entry: Record<string, unknown>): string | undefined {
  return typeof entry.name === 'string' && entry.name !== '' ? entry.name : undefined;
}

function asConversation(entry: Record<string, unknown>, flags: Partial<SlackConversation>): SlackConversation {
  return { ...entry, ...flags, ...keptFlags(entry) } as SlackConversation;
}

/** Explicit, more specific flags an entry already carries win over the listing-file default. */
function keptFlags(entry: Record<string, unknown>): Partial<SlackConversation> {
  const kept: Partial<SlackConversation> = {};
  if (entry.is_mpim === true) kept.is_mpim = true;
  if (entry.is_private === true) kept.is_private = true;
  if (entry.is_group === true) kept.is_group = true;
  return kept;
}

function dmConversation(entry: Record<string, unknown>, selfUserId: string | null): SlackConversation {
  const members = membersOf(entry);
  const conv: SlackConversation = { ...entry, id: entry.id as string, is_im: true, members };
  const explicit = typeof entry.user === 'string' && entry.user !== '' ? entry.user : null;
  const other = explicit ?? otherMember(members, selfUserId);
  if (other) conv.user = other;
  else delete conv.user; // unknown beats guessed: a later import or API sync fills it in
  return conv;
}

/** The DM partner; the self user for a self-DM; null when we don't know who "self" is. */
function otherMember(members: string[], selfUserId: string | null): string | null {
  if (!selfUserId) return null;
  return members.find((m) => m !== selfUserId) ?? (members.includes(selfUserId) ? selfUserId : null);
}

/** Unlisted folders are importable only when named by a conversation id. */
export function unlistedConversation(folder: string): SlackConversation | null {
  return looksLikeConversationId(folder) ? { id: folder } : null;
}

// ---------------------------------------------------------------------------------------------
// Users synthesized from messages (exports without users.json)
// ---------------------------------------------------------------------------------------------

/** A minimal user record from the `user_profile` Slack embeds in exported messages. */
export function userFromMessage(msg: SlackMessage): SlackUser | null {
  const p = msg.user_profile;
  if (!p || typeof msg.user !== 'string' || msg.user === '') return null;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const team = str(msg.user_team) ?? str(p.team);
  return {
    id: msg.user,
    ...(team ? { team_id: team } : {}),
    name: str(p.name),
    real_name: str(p.real_name),
    profile: { real_name: str(p.real_name), display_name: str(p.display_name), image_72: str(p.image_72) },
    synthesized_from: 'user_profile',
  };
}
