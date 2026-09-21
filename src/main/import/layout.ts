/**
 * Pure path analysis of a Slack export (admin export or slackdump `export`): which listing
 * files exist, which folders hold day files, and where local copies of uploaded files live.
 * slackdump v3 writes either layout below (researched against its source for the previous
 * implementation).
 */

export type ListingName = 'users' | 'channels' | 'groups' | 'dms' | 'mpims';

export const LISTING_NAMES: readonly ListingName[] = ['users', 'channels', 'groups', 'dms', 'mpims'];
export const LISTING_FILES: ReadonlySet<string> = new Set(LISTING_NAMES.map((n) => `${n}.json`));

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;
const FILE_ID_RE = /^F[A-Z0-9]{8,}$/;
const FILE_ID_PREFIX_RE = /^(F[A-Z0-9]{8,})(?=[-_. ]|$)/;
/** slackdump's mattermost layout keeps every upload under this top-level folder. */
export const UPLOADS_DIR = '__uploads';

export function isDayFileName(name: string): boolean {
  return DAY_FILE_RE.test(name);
}

export interface ExportLayout {
  /** Listing files present at the export root. */
  listings: Set<ListingName>;
  /** Conversation folder name → its day-file entry paths, oldest first. */
  folders: Map<string, string[]>;
  /** Slack file id → entry paths holding a local copy of that file. */
  attachments: Map<string, string[]>;
}

export function analyzeLayout(paths: Iterable<string>): ExportLayout {
  const layout: ExportLayout = { listings: new Set(), folders: new Map(), attachments: new Map() };
  for (const p of paths) {
    const parts = p.split('/');
    if (parts.length === 1) {
      if (LISTING_FILES.has(p)) layout.listings.add(p.slice(0, -'.json'.length) as ListingName);
      continue; // other top-level files (canvases.json, integration_logs.json, …) are not needed
    }
    if (parts.length === 2 && isDayFileName(parts[1]) && !parts[0].startsWith('__')) {
      push(layout.folders, parts[0], p);
      continue;
    }
    const fileId = fileIdFromPath(p);
    if (fileId) push(layout.attachments, fileId, p);
  }
  for (const days of layout.folders.values()) days.sort();
  // Directory walks return entries in arbitrary order; a stable folder order keeps imports
  // (and their logs) reproducible.
  layout.folders = new Map([...layout.folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return layout;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The Slack file id a local attachment copy belongs to, or null. Recognized layouts:
 *  - slackdump mattermost: `__uploads/<FILE_ID>/<name>`
 *  - slackdump standard:   `<conversation>/attachments/<FILE_ID>-<name>`
 *  - fallback (other tools): a non-JSON path with a directory named like a file id, or whose
 *    file name starts with one (`F0123ABCD-name.png`, `F0123ABCD_name.png`, `F0123ABCD.png`).
 * Day files and listing files are never attachments (callers filter them out first).
 */
export function fileIdFromPath(p: string): string | null {
  const parts = p.split('/');
  const base = parts[parts.length - 1];
  if (parts.length === 3 && parts[0] === UPLOADS_DIR && FILE_ID_RE.test(parts[1])) return parts[1];
  if (parts.length === 3 && parts[1] === 'attachments') {
    const m = FILE_ID_PREFIX_RE.exec(base);
    if (m && base.startsWith(`${m[1]}-`)) return m[1];
  }
  // Uploaded .json files are only trusted in the layouts above; elsewhere JSON is export data.
  if (base.toLowerCase().endsWith('.json')) return null;
  for (let i = parts.length - 2; i >= 0; i--) {
    if (FILE_ID_RE.test(parts[i])) return parts[i];
  }
  return FILE_ID_PREFIX_RE.exec(base)?.[1] ?? null;
}

/**
 * The original-ish file name of a local copy, for files whose metadata lacks a name:
 * strips the `<FILE_ID>-` prefix of standard-layout attachments.
 */
export function localFileName(entryPath: string, fileId: string): string {
  const base = entryPath.slice(entryPath.lastIndexOf('/') + 1);
  for (const sep of ['-', '_']) {
    if (base.startsWith(fileId + sep) && base.length > fileId.length + 1) return base.slice(fileId.length + 1);
  }
  return base;
}

/** Folder names that are conversation ids (DM folders; any type may be exported by id). */
export function looksLikeConversationId(name: string): boolean {
  return /^[CDG][A-Z0-9]{6,}$/.test(name);
}
