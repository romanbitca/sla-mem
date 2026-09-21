/**
 * Synthetic archive generator (dev only): writes the fictional "Brightwave" workspace straight
 * into an archive folder, so the UI can be built and performance measured without Slack
 * (PLAN §11 Stage 1).
 *
 * Usage: npm run seed -- [--out DIR] [--messages N] [--days N] [--seed N]
 *   --out       archive folder (default ./.demo-data); wiped first, but only if this script made it
 *   --messages  approximate message count (default ~10,000); e.g. 300000 for performance runs
 *   --days      history length in days (default 200, or longer for big --messages)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  CONVERSATIONS,
  DAY,
  SELF,
  TEAM_DOMAIN,
  TEAM_ID,
  TEAM_NAME,
  generateWorkspace,
  type Gen,
} from '../test/synthetic/workspace';

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

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const started = Date.now();
  const ws = generateWorkspace({ seed: opts.seed, messages: opts.messages, days: opts.days });
  const { gen: g, days, updates } = ws;

  resetOutDir(opts.out);
  const db = openDb(path.join(opts.out, 'archive.db'));
  const filesDir = path.join(opts.out, 'files');
  setMeta(db, 'team_id', TEAM_ID);
  setMeta(db, 'team_name', TEAM_NAME);
  setMeta(db, 'team_domain', TEAM_DOMAIN);
  setMeta(db, 'self_user_id', SELF);
  upsertUsers(db, ws.users);
  upsertConversations(db, ws.conversations, { selfUserId: SELF });
  let total = 0;
  for (const c of CONVERSATIONS) {
    const msgs = g.messages.get(c.id) ?? [];
    for (let i = 0; i < msgs.length; i += 5000) {
      total += upsertMessages(db, c.id, msgs.slice(i, i + 5000), 'api', { filesDir }).inserted;
    }
  }
  const files = writeFiles(db, opts.out, g);
  upsertCustomEmoji(db, ws.customEmoji);
  // A later "sync": edits become revisions, deletions keep their text with a badge.
  let revisions = 0;
  for (const u of updates) revisions += upsertMessages(db, u.convId, [u.message], 'api', { filesDir }).revisions;
  db.pragma('optimize');
  db.close();

  const all = CONVERSATIONS.flatMap((c) => g.messages.get(c.id) ?? []);
  const replies = all.filter((m) => m.thread_ts && m.thread_ts !== m.ts).length;
  const old = all.filter((m) => Number(m.ts) < g.now - 90 * DAY).length;
  console.log(`Synthetic archive written to ${shown(opts.out)} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  ${ws.users.length} users, ${CONVERSATIONS.length} conversations, ${days} days`);
  console.log(`  ${total} messages (${replies} thread replies, ${old} older than 90 days)`);
  console.log(`  ${files} attachments on disk, ${revisions} edits recorded as revisions`);
  console.log(`\nOpen it with: npm run dev:demo`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
