import { describe, expect, it } from 'vitest';
import type { SearchParams } from '../../shared/types';
import {
  addDays,
  buildMatchExpression,
  createSearchResolvers,
  ftsLiteral,
  parseDay,
  parseSearchQuery,
  search,
  searchTuning,
  type SearchResolvers,
} from './search';
import { msg, seededDb } from './test-helpers';
import type { DB } from './types';
import { upsertMessages } from './write';

const NOW = new Date(2024, 5, 15, 12, 0, 0); // 2024-06-15 local noon

const resolvers: SearchResolvers = createSearchResolvers({
  users: [
    { id: 'USELF', name: 'me.self', realName: 'Self Person', displayName: 'selfie' },
    { id: 'U1', name: 'alice', realName: 'Alice Anderson', displayName: 'Ali' },
    { id: 'U2', name: 'bob', realName: 'Bob Brown', displayName: null },
    { id: 'U3', name: 'annabel', realName: 'Annabel Lee', displayName: null },
    { id: 'U4', name: 'ann', realName: 'Ann Other', displayName: null },
  ],
  conversations: [
    { id: 'C1', type: 'channel', name: 'general', dmUserId: null },
    { id: 'C2', type: 'channel', name: 'random', dmUserId: null },
    { id: 'C3', type: 'channel', name: 'dev-ops', dmUserId: null },
    { id: 'G1', type: 'private_channel', name: 'secret-plans', dmUserId: null },
    { id: 'D1', type: 'im', name: null, dmUserId: 'U1' },
    { id: 'D2', type: 'im', name: null, dmUserId: 'USELF' },
  ],
  selfUserId: 'USELF',
  now: () => NOW,
});

const parse = (q: string) => parseSearchQuery(q, resolvers);

describe('parseSearchQuery: text', () => {
  it('splits words, phrases and exclusions', () => {
    const p = parse('deploy "release notes" -staging -"old build" fix');
    expect(p.terms).toEqual(['deploy', 'fix']);
    expect(p.phrases).toEqual(['release notes']);
    expect(p.excluded).toEqual(['staging']);
    expect(p.excludedPhrases).toEqual(['old build']);
    expect(p.text).toBe('deploy "release notes" -staging -"old build" fix');
    expect(p.unresolved).toEqual([]);
  });

  it('treats an unbalanced quote as a phrase to the end', () => {
    const p = parse('foo "bar baz');
    expect(p.terms).toEqual(['foo']);
    expect(p.phrases).toEqual(['bar baz']);
  });

  it('keeps unknown key:value words, urls and emoji shortcodes as plain words', () => {
    const p = parse('plain_text:x https://example.com/a?b=c :tada: 10:30');
    expect(p.terms).toEqual(['plain_text:x', 'https://example.com/a?b=c', ':tada:', '10:30']);
    expect(p.unresolved).toEqual([]);
  });

  it('drops tokens the FTS tokenizer would ignore', () => {
    const p = parse('* ^ ( ) - "" -"" !!! 🎉');
    expect(p).toMatchObject({ terms: [], phrases: [], excluded: [], text: '' });
  });
});

describe('parseSearchQuery: modifiers', () => {
  it('resolves from: by handle, display name, real name, id and "me"', () => {
    expect(parse('from:@alice').userIds).toEqual(['U1']);
    expect(parse('from:alice').userIds).toEqual(['U1']);
    expect(parse('from:ALI').userIds).toEqual(['U1']);
    expect(parse('from:"Alice Anderson"').userIds).toEqual(['U1']);
    expect(parse('from:u1').userIds).toEqual(['U1']);
    expect(parse('from:me').userIds).toEqual(['USELF']);
    expect(parse('from:@alice from:bob').userIds).toEqual(['U1', 'U2']);
  });

  it('prefers exact matches over prefix matches', () => {
    expect(parse('from:ann').userIds).toEqual(['U4']);
    expect(parse('from:anna').userIds).toEqual(['U3']);
  });

  it('resolves in: channels by name or id, and in:@user to the DM', () => {
    expect(parse('in:#general').conversationIds).toEqual(['C1']);
    expect(parse('in:General').conversationIds).toEqual(['C1']);
    expect(parse('in:c2').conversationIds).toEqual(['C2']);
    expect(parse('in:D1').conversationIds).toEqual(['D1']);
    expect(parse('in:#dev').conversationIds).toEqual(['C3']);
    expect(parse('in:@alice').conversationIds).toEqual(['D1']);
    expect(parse('in:@me').conversationIds).toEqual(['D2']);
    expect(parse('in:alice').conversationIds).toEqual(['D1']); // no channel called alice → DM
  });

  it('reports unresolvable modifiers instead of ignoring them', () => {
    const p = parse('hello from:@nobody in:#nowhere in:@bob has:star is:starred from: before:2024-02-30 -in:#general');
    expect(p.unresolved).toEqual([
      'from:@nobody',
      'in:#nowhere',
      'in:@bob',
      'has:star',
      'is:starred',
      'from:',
      'before:2024-02-30',
      '-in:#general',
    ]);
    expect(p.terms).toEqual(['hello']);
  });

  it('parses date modifiers into [after, before) local-day bounds', () => {
    expect(parse('after:2024-03-01')).toMatchObject({ after: '2024-03-01', before: null });
    expect(parse('before:2024-3-5')).toMatchObject({ after: null, before: '2024-03-05' });
    expect(parse('on:2024-02-29')).toMatchObject({ after: '2024-02-29', before: '2024-03-01' });
    expect(parse('during:2024-02')).toMatchObject({ after: '2024-02-01', before: '2024-03-01' });
    expect(parse('during:2024-12')).toMatchObject({ after: '2024-12-01', before: '2025-01-01' });
    expect(parse('during:2023')).toMatchObject({ after: '2023-01-01', before: '2024-01-01' });
    expect(parse('on:today')).toMatchObject({ after: '2024-06-15', before: '2024-06-16' });
    expect(parse('after:yesterday')).toMatchObject({ after: '2024-06-14' });
    expect(parse('during:2024-13').unresolved).toEqual(['during:2024-13']);
  });

  it('narrows repeated date constraints to the tightest range', () => {
    expect(parse('after:2024-01-01 after:2024-02-01 before:2024-06-01 during:2024-03')).toMatchObject({
      after: '2024-03-01',
      before: '2024-04-01',
    });
  });

  it('parses has: and is: filters', () => {
    expect(parse('has:file has:links has:reaction has:thread has:image has:file').has).toEqual([
      'file',
      'link',
      'reaction',
      'thread',
      'image',
    ]);
    expect(parse('is:thread').isThread).toBe(true);
  });
});

describe('buildMatchExpression (FTS safety)', () => {
  it('quotes every word and prefix-matches bare words only', () => {
    expect(buildMatchExpression({ terms: ['foo', 'bar'], phrases: ['a b'], excluded: [] })).toEqual({
      positive: '"foo"* AND "bar"* AND "a b"',
      negative: null,
    });
    // Exclusions follow the inclusion semantics: bare words prefix-match, phrases are exact (pitfall 13).
    expect(buildMatchExpression({ terms: ['foo'], phrases: [], excluded: ['x'], excludedPhrases: ['y z'] })).toEqual({
      positive: '("foo"*) NOT ("x"* OR "y z")',
      negative: '"x"* OR "y z"',
    });
    expect(buildMatchExpression({ terms: [], phrases: [], excluded: ['x'] })).toEqual({
      positive: null,
      negative: '"x"*',
    });
  });

  it('doubles embedded quotes so user text can never close the literal', () => {
    expect(ftsLiteral('foo" OR "bar')).toBe('"foo"" OR ""bar"');
    const p = parse('foo" OR "bar');
    const expr = buildMatchExpression(p).positive!;
    expect(expr).toBe('"foo"""* AND "OR"* AND "bar"');
    for (const op of ['NEAR(', 'plain_text:x', '^start', 'a*']) {
      expect(buildMatchExpression(parse(op)).positive).toBe(`${ftsLiteral(op)}*`);
    }
  });
});

describe('date helpers', () => {
  it('validates calendar dates and does DST-safe arithmetic', () => {
    expect(parseDay('2023-02-29')).toBeNull();
    expect(parseDay('2024-02-29')).toBe('2024-02-29');
    expect(parseDay('24-02-01')).toBeNull();
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2024-03-31', 1)).toBe('2024-04-01');
    expect(addDays('2024-01-01', -1)).toBe('2023-12-31');
  });
});

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

/** ts for a local wall-clock time, so date-bound tests hold in any server timezone. */
function localTs(y: number, mo: number, d: number, h = 12, mi = 0, micros = 0): string {
  return `${Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000)}.${String(micros).padStart(6, '0')}`;
}

function corpus(): DB {
  const db = seededDb();
  upsertMessages(
    db,
    'C1',
    [
      msg(localTs(2024, 3, 10, 23, 30), 'deploy the release to production', { user: 'U1' }),
      msg(localTs(2024, 3, 11, 0, 30), 'deployment finished, see <https://ci.example.com|ci>', { user: 'U2' }),
      msg(localTs(2024, 3, 12), 'the quick brown fox', {
        user: 'U1',
        reactions: [{ name: 'fox', count: 1, users: ['U2'] }],
      }),
      msg(localTs(2024, 3, 13), 'quick and very brown', { user: 'U2' }),
      msg(localTs(2024, 3, 14), 'thread about café menus', {
        user: 'U1',
        thread_ts: localTs(2024, 3, 14),
        reply_count: 1,
        latest_reply: localTs(2024, 3, 15),
      }),
      msg(localTs(2024, 3, 15), 'reply mentioning deploy again', { user: 'U2', thread_ts: localTs(2024, 3, 14) }),
      msg(localTs(2024, 3, 16), 'photo attached', {
        user: 'U1',
        files: [{ id: 'F1', name: 'cat.png', mimetype: 'image/png', url_private: 'https://f/cat' }],
      }),
      msg(localTs(2024, 3, 17), 'foo only', { user: 'U1' }),
      msg(localTs(2024, 3, 18), 'bar only', { user: 'U1' }),
      msg(localTs(2024, 3, 19), 'foo or bar', { user: 'U1' }),
    ],
    'api',
  );
  upsertMessages(
    db,
    'C2',
    [
      msg(localTs(2024, 4, 1), 'random deploy chatter', { user: 'U2' }),
      msg(localTs(2024, 4, 2), `long ${'word '.repeat(80)}end`, { user: 'U2' }),
    ],
    'api',
  );
  upsertMessages(db, 'D1', [msg(localTs(2024, 4, 3), 'private deploy note', { user: 'U1' })], 'api');
  return db;
}

const run = (db: DB, q: string, extra: Omit<SearchParams, 'q'> = {}) => search(db, { q, ...extra }, { now: NOW });
const texts = (res: ReturnType<typeof run>) => res.hits.map((h) => h.message.text);

describe('search', () => {
  const db = corpus();

  it('matches word prefixes across conversations, including thread replies', () => {
    const res = run(db, 'deplo', { sort: 'oldest' });
    expect(texts(res)).toEqual([
      'deploy the release to production',
      'deployment finished, see <https://ci.example.com|ci>',
      'reply mentioning deploy again',
      'random deploy chatter',
      'private deploy note',
    ]);
    expect(res.total).toBe(5);
    expect(res.hits[2].message.isReply).toBe(true);
  });

  it('marks matches in snippets with \\u0002/\\u0003', () => {
    const res = run(db, 'fox');
    expect(res.hits[0].snippet).toBe('the quick brown \u0002fox\u0003');
  });

  it('ignores diacritics', () => {
    expect(texts(run(db, 'cafe'))).toEqual(['thread about café menus']);
  });

  it('matches phrases exactly and applies exclusions', () => {
    expect(texts(run(db, '"quick brown"'))).toEqual(['the quick brown fox']);
    expect(texts(run(db, 'quick -fox'))).toEqual(['quick and very brown']);
    expect(texts(run(db, 'quick -"brown fox"'))).toEqual(['quick and very brown']);
  });

  it('treats injected FTS syntax as literal text', () => {
    expect(texts(run(db, 'foo" OR "bar'))).toEqual(['foo or bar']);
    const nasty = [
      'NEAR(',
      'NEAR(foo bar, 2)',
      '*',
      '^',
      '^foo',
      'plain_text:foo',
      'messages_fts:foo',
      '{plain_text}: foo',
      '"unbalanced',
      ':tada:',
      'a AND b',
      'foo OR bar NOT baz',
      '(',
      ')',
      '"',
      '""',
      '-',
      '-"',
      "'; DROP TABLE messages; --",
      'col:"x',
      'foo*bar',
      'from:"',
      'in:"',
      '\\"',
      'NOT',
      'AND',
      'OR',
      '\u0000deploy',
      'deploy\u0000"',
      '"a\u0000b"',
      '-x\u0000',
    ];
    for (const q of nasty) {
      expect(() => run(db, q), q).not.toThrow();
      expect(typeof run(db, q).total).toBe('number');
    }
    // Operators are just words: NOT prefix-matches "note" instead of negating anything.
    expect(texts(run(db, 'NOT'))).toEqual(['private deploy note']);
    expect(run(db, "'; DROP TABLE messages; --").total).toBe(0);
    expect(run(db, 'deploy').total).toBe(5);
    // FTS5 reads MATCH as a C string: a NUL must not cut the literal short (it used to throw).
    expect(run(db, '\u0000deploy').total).toBe(5);
  });

  it('filters by from:, in:, has:, is:thread and combines them with AND', () => {
    expect(run(db, 'deploy from:@bob').total).toBe(3);
    expect(texts(run(db, 'deploy from:bob in:#general', { sort: 'oldest' }))).toEqual([
      'deployment finished, see <https://ci.example.com|ci>',
      'reply mentioning deploy again',
    ]);
    expect(texts(run(db, 'deploy in:@alice'))).toEqual(['private deploy note']);
    expect(texts(run(db, 'has:link'))).toEqual(['deployment finished, see <https://ci.example.com|ci>']);
    expect(texts(run(db, 'has:image'))).toEqual(['photo attached']);
    expect(texts(run(db, 'has:file'))).toEqual(['photo attached']);
    expect(texts(run(db, 'has:reaction'))).toEqual(['the quick brown fox']);
    expect(texts(run(db, 'has:thread'))).toEqual(['thread about café menus']);
    expect(texts(run(db, 'is:thread', { sort: 'oldest' }))).toEqual([
      'thread about café menus',
      'reply mentioning deploy again',
    ]);
  });

  it('applies local-timezone day bounds (after inclusive, before exclusive, on = one day)', () => {
    expect(texts(run(db, 'deploy on:2024-03-10'))).toEqual(['deploy the release to production']);
    expect(texts(run(db, 'deploy before:2024-03-11'))).toEqual(['deploy the release to production']);
    expect(texts(run(db, 'deploy after:2024-03-11 before:2024-03-12'))).toEqual([
      'deployment finished, see <https://ci.example.com|ci>',
    ]);
    expect(run(db, 'deploy during:2024-04').total).toBe(2);
    expect(run(db, 'deploy', { after: '2024-04-01', before: '2024-04-03' }).total).toBe(1);
  });

  it('sorts by newest, oldest and relevance', () => {
    expect(texts(run(db, 'quick', { sort: 'newest' }))).toEqual(['quick and very brown', 'the quick brown fox']);
    expect(texts(run(db, 'quick', { sort: 'oldest' }))).toEqual(['the quick brown fox', 'quick and very brown']);
    // bm25: the shorter document with the term ranks first; equal docs fall back to newest.
    // (Filler docs keep "alpha" rare; bm25's IDF vanishes for terms present in most docs.)
    const filler = Array.from({ length: 6 }, (_, i): [string, string, string] => [
      'C2',
      localTs(2023, 1, i + 1),
      `filler ${i} text`,
    ]);
    const rel = search(
      withMessages([
        ...filler,
        ['C1', localTs(2024, 1, 1), 'alpha'],
        ['C1', localTs(2024, 1, 2), 'alpha beta gamma delta epsilon zeta eta theta iota kappa'],
        ['C2', localTs(2024, 1, 3), 'alpha'],
      ]),
      { q: 'alpha' },
      { now: NOW },
    );
    expect(rel.hits.map((h) => [h.message.conversationId, h.message.text])).toEqual([
      ['C2', 'alpha'],
      ['C1', 'alpha'],
      ['C1', 'alpha beta gamma delta epsilon zeta eta theta iota kappa'],
    ]);
  });

  it('paginates with a stable total', () => {
    const page1 = run(db, 'deploy', { sort: 'oldest', limit: 2 });
    const page2 = run(db, 'deploy', { sort: 'oldest', limit: 2, offset: 2 });
    const page3 = run(db, 'deploy', { sort: 'oldest', limit: 2, offset: 4 });
    const page4 = run(db, 'deploy', { sort: 'oldest', limit: 2, offset: 6 });
    expect([page1.total, page2.total, page3.total, page4.total]).toEqual([5, 5, 5, 5]);
    expect([...texts(page1), ...texts(page2), ...texts(page3)]).toEqual(texts(run(db, 'deploy', { sort: 'oldest' })));
    expect(page4.hits).toEqual([]);
    expect(run(db, 'deploy', { limit: 1000 }).hits).toHaveLength(5);
    expect(run(db, 'deploy', { sort: 'bogus' as never, limit: 0, offset: -5 })).toMatchObject({ total: 5, hits: [{}] });
  });

  it('runs filter-only queries as newest-first listings with lead snippets', () => {
    const res = run(db, 'in:#random');
    expect(res.total).toBe(2);
    expect(res.hits[0].snippet.startsWith('long word word')).toBe(true);
    expect(res.hits[0].snippet.endsWith('…')).toBe(true);
    expect(res.hits[0].snippet.length).toBeLessThanOrEqual(201);
    expect(res.hits[1].snippet).toBe('random deploy chatter');
    expect(res.hits.every((h) => !/[\u0002\u0003]/.test(h.snippet))).toBe(true);
    expect(texts(run(db, '-word in:#random'))).toEqual(['random deploy chatter']);
  });

  it('merges explicit params with modifiers and reports what it understood', () => {
    const res = run(db, 'deploy in:#general', { conversation: ['D1'], user: ['U1'], has: ['link', 'bogus' as never] });
    expect(res.parsed).toEqual({
      text: 'deploy',
      conversationIds: ['C1', 'D1'],
      userIds: ['U1'],
      after: null,
      before: null,
      has: ['link'],
      unresolved: [],
    });
    expect(res.total).toBe(0); // U1's deploy messages have no links
    expect(run(db, 'deploy', { conversation: ['C1', 'D1'], user: ['U1'] }).total).toBe(2);
  });

  it('returns nothing for unresolved modifiers, invalid date params or an empty query', () => {
    const res = run(db, 'deploy from:@nobody');
    expect(res).toMatchObject({ total: 0, hits: [], parsed: { unresolved: ['from:@nobody'] } });
    expect(run(db, 'deploy', { after: 'last week' })).toMatchObject({
      total: 0,
      parsed: { unresolved: ['after:last week'] },
    });
    expect(run(db, '   ').total).toBe(0);
    expect(run(db, '*').total).toBe(0);
    expect(run(db, 'zzzznotthere').total).toBe(0);
  });

  it('gives identical results whether filters are joined or applied as an id set', () => {
    const queries: [string, Omit<SearchParams, 'q'>][] = [
      ['deploy from:bob', { sort: 'newest' }],
      ['deploy in:#general', { sort: 'oldest' }],
      ['deploy', { conversation: ['C1', 'D1'], sort: 'relevance' }],
      ['deploy during:2024-03 is:thread', {}],
      ['quick has:reaction', {}],
      ['deploy after:2024-03-11', { sort: 'oldest', limit: 2, offset: 1 }],
    ];
    const saved = searchTuning.joinMaxMatches;
    try {
      for (const [q, extra] of queries) {
        searchTuning.joinMaxMatches = 1_000_000;
        const joined = run(db, q, extra);
        searchTuning.joinMaxMatches = 0;
        const idSet = run(db, q, extra);
        expect(idSet.total, q).toBe(joined.total);
        expect(
          idSet.hits.map((h) => [h.message.ts, h.snippet]),
          q,
        ).toEqual(joined.hits.map((h) => [h.message.ts, h.snippet]));
        expect(joined.total, q).toBeGreaterThan(0);
      }
    } finally {
      searchTuning.joinMaxMatches = saved;
    }
  });

  it('reports the total for a filtered page past the end', () => {
    const all = run(db, 'deploy from:bob');
    expect(all.total).toBeGreaterThan(0);
    expect(run(db, 'deploy from:bob', { offset: all.total + 5 })).toMatchObject({ total: all.total, hits: [] });
  });

  it('sorts chronologically even when older messages were inserted last', () => {
    const late = seededDb();
    upsertMessages(late, 'C2', [msg(localTs(2024, 5, 3), 'zulu three'), msg(localTs(2024, 5, 2), 'zulu two')], 'api');
    upsertMessages(late, 'C1', [msg(localTs(2024, 5, 1), 'zulu one')], 'api'); // oldest, inserted last
    upsertMessages(late, 'D1', [msg(localTs(2024, 5, 4), 'zulu four')], 'api');
    expect(texts(run(late, 'zulu', { sort: 'newest' }))).toEqual(['zulu four', 'zulu three', 'zulu two', 'zulu one']);
    expect(texts(run(late, 'zulu', { sort: 'oldest' }))).toEqual(['zulu one', 'zulu two', 'zulu three', 'zulu four']);
    expect(texts(run(late, 'zulu', { sort: 'newest', conversation: ['C1', 'C2'] }))).toEqual([
      'zulu three',
      'zulu two',
      'zulu one',
    ]);
  });

  it('keeps a message whose id was bumped past midnight on the right side of a date bound', () => {
    const edge = seededDb();
    const lastMicro = `${Math.floor(new Date(2024, 2, 11).getTime() / 1000) - 1}.999999`; // 23:59:59.999999 local
    upsertMessages(edge, 'C1', [msg(lastMicro, 'yankee first')], 'api');
    upsertMessages(edge, 'C2', [msg(lastMicro, 'yankee bumped')], 'api'); // id lands on local midnight
    upsertMessages(edge, 'C2', [msg(localTs(2024, 3, 11, 0, 0, 1), 'yankee next day')], 'api');
    for (const joinMaxMatches of [0, 1_000_000]) {
      searchTuning.joinMaxMatches = joinMaxMatches;
      try {
        expect(texts(run(edge, 'yankee before:2024-03-11', { sort: 'oldest' }))).toEqual([
          'yankee first',
          'yankee bumped',
        ]);
        expect(texts(run(edge, 'yankee on:2024-03-11'))).toEqual(['yankee next day']);
      } finally {
        searchTuning.joinMaxMatches = 5000;
      }
    }
  });

  it('returns hydrated messages with files', () => {
    const [hit] = run(db, 'photo').hits;
    expect(hit.message.files.map((f) => f.name)).toEqual(['cat.png']);
    expect(run(db, 'cat').hits.map((h) => h.message.text)).toEqual(['photo attached']); // file names are indexed
  });
});

function withMessages(rows: [string, string, string][]): DB {
  const db = seededDb();
  for (const [conv, ts, text] of rows) upsertMessages(db, conv, [msg(ts, text)], 'api');
  return db;
}
