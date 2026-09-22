/**
 * Performance check for PLAN §11 Stage 1 / §6.3: builds (or reuses) a large synthetic archive and
 * times the hot read paths against the targets.
 *
 * Usage: npm run bench -- [--messages 300000] [--out ./.test-data/bench-300k] [--fresh]
 * Targets: conversation list < 10 ms, message page < 50 ms, typical search < 50 ms, worst < 300 ms,
 * the People list and a person's page < 50 ms.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMessages, getPerson, listConversations, listPeople, openDb, search, type DB } from '../src/main/db';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const messages = Number(option('messages', '300000'));
const out = path.resolve(ROOT, option('out', `./.test-data/bench-${Math.round(messages / 1000)}k`));
const fresh = process.argv.includes('--fresh');

function ensureArchive(): void {
  if (!fresh && fs.existsSync(path.join(out, 'archive.db'))) return;
  const seed = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'scripts/seed.ts', '--out', out, '--messages', String(messages)],
    {
      cwd: ROOT,
      stdio: 'inherit',
    },
  );
  if (seed.status !== 0) process.exit(seed.status ?? 1);
}

function time(fn: () => unknown, runs = 15): { median: number; max: number } {
  fn(); // warm the statement cache and page cache
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return { median: samples[Math.floor(samples.length / 2)], max: samples[samples.length - 1] };
}

interface Check {
  name: string;
  run: () => unknown;
  target: number;
}

function checks(db: DB): Check[] {
  const convs = listConversations(db);
  const biggest = [...convs].sort((a, b) => b.messageCount - a.messageCount)[0];
  const middle =
    biggest.oldestTs && biggest.latestTs
      ? String((Number(biggest.oldestTs) + Number(biggest.latestTs)) / 2)
      : undefined;
  const typical = 50;
  const worst = 300;
  const busiest = [...listPeople(db)].sort((a, b) => b.messageCount - a.messageCount)[0];
  return [
    { name: 'conversation list', run: () => listConversations(db), target: 10 },
    {
      name: `latest page (#${biggest.label}, ${biggest.messageCount} msgs)`,
      run: () => getMessages(db, { conversationId: biggest.id, limit: 100 }),
      target: 50,
    },
    {
      name: 'page around the middle',
      run: () => getMessages(db, { conversationId: biggest.id, around: middle, limit: 100 }),
      target: 50,
    },
    {
      name: 'page before the middle',
      run: () => getMessages(db, { conversationId: biggest.id, before: middle, limit: 100 }),
      target: 50,
    },
    ...[
      'deploy',
      'checkout latency',
      '"quick question"',
      'from:@priya deploy',
      'in:#engineering incident',
      'rollback -staging',
      'has:file',
      'has:link from:me',
      'is:thread design',
      'after:2026-01-01 migration',
    ].map((q) => ({ name: `search ${q}`, run: () => search(db, { q, limit: 30 }), target: typical })),
    ...['de', 'a', 'the'].map((q) => ({
      name: `search ${q} (pathological prefix)`,
      run: () => search(db, { q, limit: 30 }),
      target: worst,
    })),
    { name: 'search newest sort', run: () => search(db, { q: 'deploy', sort: 'newest', limit: 30 }), target: typical },
    { name: 'search page 20', run: () => search(db, { q: 'deploy', limit: 30, offset: 600 }), target: typical },
    { name: 'people list', run: () => listPeople(db), target: typical },
    {
      name: `person page (${busiest.messageCount} messages by them)`,
      run: () => getPerson(db, busiest.userId),
      target: typical,
    },
  ];
}

ensureArchive();
const db = openDb(path.join(out, 'archive.db'));
const total = (db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n;
console.log(`Archive: ${out} (${total.toLocaleString()} messages)\n`);
let failed = 0;
for (const c of checks(db)) {
  const { median, max } = time(c.run);
  const ok = median <= c.target;
  if (!ok) failed++;
  console.log(
    `${ok ? 'ok  ' : 'SLOW'} ${c.name.padEnd(52)} median ${median.toFixed(1).padStart(7)} ms   max ${max.toFixed(1).padStart(7)} ms   (target ${c.target} ms)`,
  );
}
db.close();
console.log(failed ? `\n${failed} check(s) over target` : '\nAll checks within target');
process.exit(failed ? 1 : 0);
