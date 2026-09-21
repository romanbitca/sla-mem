import type { NormalizeResolvers } from './normalize';
import { stmt } from './stmt';
import type { DB } from './types';

export interface UserNameColumns {
  id: string;
  name: string | null;
  real_name: string | null;
  display_name: string | null;
}

/** Best human label: displayName || realName || name || id (matches UserDTO.label). */
export function userLabelOf(u: UserNameColumns): string {
  return nonEmpty(u.display_name) ?? nonEmpty(u.real_name) ?? nonEmpty(u.name) ?? u.id;
}

export function nonEmpty(s: string | null | undefined): string | null {
  return typeof s === 'string' && s.trim() !== '' ? s : null;
}

/** Resolvers backed by the users/conversations tables, memoized for one batch of work. */
export function dbResolvers(db: DB): NormalizeResolvers {
  const users = new Map<string, string | undefined>();
  const channels = new Map<string, string | undefined>();
  return {
    userLabel(id) {
      if (!users.has(id)) {
        const row = stmt<UserNameColumns>(db, 'SELECT id, name, real_name, display_name FROM users WHERE id = ?').get(
          id,
        );
        users.set(id, row ? userLabelOf(row) : undefined);
      }
      return users.get(id);
    },
    channelName(id) {
      if (!channels.has(id)) {
        const row = stmt<{ name: string | null }>(db, 'SELECT name FROM conversations WHERE id = ?').get(id);
        channels.set(id, nonEmpty(row?.name) ?? undefined);
      }
      return channels.get(id);
    },
  };
}

/** Eager variant for whole-table passes (reindex): two queries instead of one per reference. */
export function preloadedResolvers(db: DB): NormalizeResolvers {
  const users = new Map<string, string>();
  for (const row of stmt<UserNameColumns>(db, 'SELECT id, name, real_name, display_name FROM users').all()) {
    users.set(row.id, userLabelOf(row));
  }
  const channels = new Map<string, string>();
  for (const row of stmt<{ id: string; name: string | null }>(db, 'SELECT id, name FROM conversations').all()) {
    const name = nonEmpty(row.name);
    if (name) channels.set(row.id, name);
  }
  return { userLabel: (id) => users.get(id), channelName: (id) => channels.get(id) };
}
