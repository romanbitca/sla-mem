/** Shared fixtures for the db unit tests (not a test file itself). */
import type { SlackConversation, SlackMessage, SlackUser } from '../slack/types';
import { openDb } from './open';
import type { DB } from './types';
import { upsertConversations, upsertUsers } from './write';
import { setMeta } from './meta';

/** 2023-11-14T22:13:20Z; far enough in the past that "now"-relative logic is deterministic. */
export const BASE_SECONDS = 1_700_000_000;

/** Slack-style ts `n` minutes after BASE_SECONDS. */
export function tsAt(minutes: number, micros = 0): string {
  return `${BASE_SECONDS + minutes * 60}.${String(micros).padStart(6, '0')}`;
}

export function memDb(): DB {
  return openDb(':memory:');
}

export function msg(ts: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage {
  return { type: 'message', ts, text, user: 'U1', ...extra };
}

export const USERS: SlackUser[] = [
  { id: 'USELF', name: 'me.self', real_name: 'Self Person', profile: { display_name: 'selfie' } },
  {
    id: 'U1',
    name: 'alice',
    real_name: 'Alice Anderson',
    profile: { display_name: 'Ali', image_72: 'https://a/72.png' },
  },
  { id: 'U2', name: 'bob', real_name: 'Bob Brown', profile: { display_name: '' } },
  { id: 'U3', name: 'annabel', real_name: 'Annabel Lee', profile: {} },
  { id: 'U4', name: 'ann', real_name: 'Ann Other', profile: {} },
  { id: 'B1', name: 'deploybot', is_bot: true, profile: { real_name: 'Deploy Bot' } },
];

export const CONVERSATIONS: SlackConversation[] = [
  { id: 'C1', name: 'general', is_channel: true, topic: { value: 'Company-wide' }, purpose: { value: 'All hands' } },
  { id: 'C2', name: 'random', is_channel: true },
  { id: 'G1', name: 'secret-plans', is_group: true, is_private: true, is_archived: true },
  { id: 'D1', is_im: true, user: 'U1' },
  { id: 'D2', is_im: true, user: 'USELF' },
  { id: 'M1', name: 'mpdm-me.self--alice--bob-1', is_mpim: true, members: ['USELF', 'U1', 'U2'] },
];

/** A DB with the users/conversations above and self = USELF. */
export function seededDb(): DB {
  const db = memDb();
  setMeta(db, 'self_user_id', 'USELF');
  upsertUsers(db, USERS);
  upsertConversations(db, CONVERSATIONS, { selfUserId: 'USELF' });
  return db;
}

export function ftsRowids(db: DB, expr: string): number[] {
  return (
    db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid').all(expr) as {
      rowid: number;
    }[]
  ).map((r) => r.rowid);
}

/** Throws if the external-content FTS index disagrees with the messages table. */
export function assertFtsIntegrity(db: DB): void {
  db.prepare("INSERT INTO messages_fts (messages_fts, rank) VALUES ('integrity-check', 1)").run();
}
