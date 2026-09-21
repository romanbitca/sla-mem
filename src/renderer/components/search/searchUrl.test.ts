import { describe, expect, it } from 'vitest';
import { makeConversation, makeUser } from '../../test/helpers';
import { datePresets, dateRangeLabel, exclusiveBefore, inclusiveEnd } from './dateRange';
import { filtersFromQuery, parseDay, parseDuring, type ResolverData } from './resolve';
import {
  clearFilters,
  EMPTY_SEARCH,
  effectiveFilters,
  parseSearchUrl,
  sameSearch,
  searchLocation,
  serializeSearchUrl,
  setConversationFilter,
  setDateFilter,
  setHasFilter,
  setUserFilter,
  toApiParams,
  type SearchUrlState,
} from './searchUrl';

const now = new Date(2026, 8, 21, 12, 0);
const data: ResolverData = {
  users: [makeUser('U1', 'Alice'), makeUser('U2', 'Bob'), makeUser('U3', 'Carol'), makeUser('U4', 'Bobby')],
  conversations: [
    makeConversation('C1', 'general'),
    makeConversation('C2', 'random'),
    makeConversation('D2', 'Bob', { type: 'im', rawName: null, dmUserId: 'U2' }),
  ],
  selfUserId: 'U1',
  now,
};

const state = (patch: Partial<SearchUrlState>): SearchUrlState => ({ ...EMPTY_SEARCH, ...patch });

describe('search URL <-> state', () => {
  it('parses and validates every param', () => {
    const s = parseSearchUrl(
      '?q=+deploy+&conversation=C1&conversation=C1&conversation=%3Cbad%3E&user=U2&after=2026-02-30' +
        '&before=2026-03-01&has=links&has=file&has=nope&sort=newest&view=grouped',
    );
    expect(s).toEqual({
      q: 'deploy',
      conversation: ['C1'],
      user: ['U2'],
      after: null, // not a real day
      before: '2026-03-01',
      has: ['file', 'link'],
      sort: 'newest',
      view: 'grouped',
    });
  });

  it('falls back to defaults for unknown values', () => {
    expect(parseSearchUrl('?sort=best&view=cards')).toEqual(EMPTY_SEARCH);
    expect(parseSearchUrl(new URLSearchParams())).toEqual(EMPTY_SEARCH);
  });

  it('serializes canonically, repeating arrays and omitting defaults', () => {
    const s = state({ q: 'a b', user: ['U2', 'U3'], has: ['thread', 'file'], after: '2026-01-01' });
    expect(serializeSearchUrl(s)).toBe('?q=a+b&user=U2&user=U3&after=2026-01-01&has=file&has=thread');
    expect(serializeSearchUrl(EMPTY_SEARCH)).toBe('');
    expect(searchLocation(state({ q: 'x', sort: 'oldest', view: 'grouped' }))).toBe(
      '/search?q=x&sort=oldest&view=grouped',
    );
  });

  it('round-trips', () => {
    const s = state({
      q: 'from:@bob "exact words"',
      conversation: ['C1', 'D2'],
      user: ['U3'],
      after: '2026-01-01',
      before: '2026-02-01',
      has: ['link', 'image'],
      sort: 'newest',
      view: 'grouped',
    });
    const back = parseSearchUrl(serializeSearchUrl(s));
    expect(sameSearch(back, s)).toBe(true);
    expect(back.has).toEqual(['link', 'image']);
  });

  it('builds API params only when there is something to search for', () => {
    expect(toApiParams(EMPTY_SEARCH)).toBeNull();
    expect(toApiParams(state({ q: '   ' }))).toBeNull();
    expect(toApiParams(state({ q: 'deploy' }))).toEqual({ q: 'deploy', sort: 'relevance' });
    expect(toApiParams(state({ has: ['file'], sort: 'newest' }))).toEqual({ q: '', sort: 'newest', has: ['file'] });
  });
});

describe('effective filters', () => {
  it('resolves modifiers typed in the query like the server does', () => {
    const f = filtersFromQuery('deploy from:@bob in:#general has:links on:2026-03-04 is:thread', data);
    expect(f).toEqual({
      conversation: ['C1'],
      user: ['U2'],
      has: ['link'],
      after: '2026-03-04',
      before: '2026-03-05',
    });
    expect(filtersFromQuery('from:bob', data).user).toEqual(['U2']); // exact beats the "bobby" prefix
    expect(filtersFromQuery('from:bo', data).user).toEqual(['U2', 'U4']); // prefixes match everyone
    expect(filtersFromQuery('from:bobb', data).user).toEqual(['U4']);
    expect(filtersFromQuery('in:@bob', data).conversation).toEqual(['D2']);
    expect(filtersFromQuery('from:me', data).user).toEqual(['U1']);
    expect(filtersFromQuery('from:@nobody -in:#general has:nope', data)).toEqual(filtersFromQuery('', data));
  });

  it('merges typed modifiers with explicit params, intersecting date ranges', () => {
    const s = state({ q: 'from:@bob after:2026-01-01', user: ['U3'], after: '2026-02-01', before: '2026-06-01' });
    const f = effectiveFilters(s, data);
    expect(f.user).toEqual(['U3', 'U2']);
    expect(f.after).toBe('2026-02-01');
    expect(f.before).toBe('2026-06-01');
    expect(effectiveFilters(s, null).user).toEqual(['U3']); // directory not loaded yet
  });

  it('keeps typed modifiers when a chip edit only adds to them', () => {
    const s = state({ q: 'deploy from:@bob' });
    expect(setUserFilter(s, ['U2', 'U3'], data)).toEqual(state({ q: 'deploy from:@bob', user: ['U3'] }));
  });

  it('moves the selection into params when a typed value is removed', () => {
    const s = state({ q: 'deploy from:@bob from:@nobody', user: ['U3'] });
    // Unresolvable modifiers stay put so their warning stays visible.
    expect(setUserFilter(s, ['U3'], data)).toEqual(state({ q: 'deploy from:@nobody', user: ['U3'] }));
    expect(setConversationFilter(state({ q: 'in:#general x' }), [], data)).toEqual(state({ q: 'x' }));
    expect(setHasFilter(state({ q: 'has:link' }), ['file', 'link'], data)).toEqual(
      state({ q: 'has:link', has: ['file'] }),
    );
  });

  it('replaces typed dates when the date chip is edited', () => {
    const s = state({ q: 'x during:2026-03 before:2026-03-10' });
    expect(setDateFilter(s, { after: '2026-04-01', before: null }, data)).toEqual(
      state({ q: 'x', after: '2026-04-01', before: null }),
    );
  });

  it('clears every chip filter but keeps words, is:thread and unresolved modifiers', () => {
    const s = state({
      q: '"release notes" from:@bob in:#general is:thread from:@ghost',
      has: ['file'],
      after: '2026-01-01',
    });
    expect(clearFilters(s, data)).toEqual(state({ q: '"release notes" is:thread from:@ghost' }));
  });
});

describe('dates', () => {
  it('parses days and months like the server', () => {
    expect(parseDay('2026-3-4')).toBe('2026-03-04');
    expect(parseDay('2026-02-29')).toBeNull();
    expect(parseDay('yesterday', now)).toBe('2026-09-20');
    expect(parseDuring('2026-12')).toEqual({ after: '2026-12-01', before: '2027-01-01' });
    expect(parseDuring('2025')).toEqual({ after: '2025-01-01', before: '2026-01-01' });
    expect(parseDuring('2026-13')).toBeNull();
  });

  it('converts between exclusive before and an inclusive last day', () => {
    expect(inclusiveEnd('2026-03-01')).toBe('2026-02-28');
    expect(exclusiveBefore('2026-12-31')).toBe('2027-01-01');
    expect(inclusiveEnd(null)).toBeNull();
  });

  it('labels ranges for the date chip', () => {
    expect(dateRangeLabel({ after: null, before: null }, now)).toBeNull();
    expect(dateRangeLabel({ after: '2026-03-01', before: '2026-04-01' }, now)).toBe('Mar 1 – Mar 31');
    expect(dateRangeLabel({ after: '2026-03-04', before: '2026-03-05' }, now)).toBe('On Mar 4');
    expect(dateRangeLabel({ after: '2025-12-01', before: null }, now)).toBe('Since Dec 1, 2025');
    expect(dateRangeLabel({ after: null, before: '2026-06-23' }, now)).toBe('Before Jun 23');
  });

  it('offers presets, including history only the archive has', () => {
    const presets = datePresets(now);
    expect(presets.find((p) => p.id === '7d')?.range).toEqual({ after: '2026-09-15', before: null });
    expect(presets.find((p) => p.id === 'beyond')?.range).toEqual({ after: null, before: '2026-06-23' });
  });
});
