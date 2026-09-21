import { stmt } from './stmt';
import type { DB } from './types';

export function getMeta(db: DB, key: string): string | null {
  const row = stmt<{ value: string }>(db, 'SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  stmt(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function deleteMeta(db: DB, key: string): void {
  stmt(db, 'DELETE FROM meta WHERE key = ?').run(key);
}

export function getWorkspaceMeta(db: DB): {
  teamId: string | null;
  teamName: string | null;
  teamDomain: string | null;
  selfUserId: string | null;
} {
  return {
    teamId: getMeta(db, 'team_id'),
    teamName: getMeta(db, 'team_name'),
    teamDomain: getMeta(db, 'team_domain'),
    selfUserId: getMeta(db, 'self_user_id'),
  };
}
