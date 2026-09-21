import { describe, expect, it } from 'vitest';
import { makeConversation, makeUser } from '../../test/helpers';
import { applySuggestion, conversationRef, getAutocomplete, userRef, type AutocompleteSource } from './autocomplete';
import { hasModifierTokens, removeRawToken, removeTokens, tokenizeQuery } from './queryText';

const users = [
  makeUser('U1', 'Alice', { realName: 'Alice Smith' }),
  makeUser('U2', 'Bob'),
  makeUser('U3', 'Bobby'),
  makeUser('U4', 'Carol', { deleted: true }),
  makeUser('UBOT', 'Deploy Bot', { isBot: true, name: 'deploybot' }),
];

const conversations = [
  makeConversation('C1', 'general'),
  makeConversation('C2', 'dev-ops'),
  makeConversation('G1', 'secret', { type: 'private_channel' }),
  makeConversation('D2', 'Bob', { type: 'im', rawName: null, dmUserId: 'U2' }),
  makeConversation('M1', 'Bob, Bobby', { type: 'mpim', rawName: 'mpdm-bob--bobby-1' }),
];

const now = new Date(2026, 8, 21, 15, 30); // Mon Sep 21 2026, local time
const source: AutocompleteSource = { users, conversations, selfUserId: 'U1', now };

const at = (q: string) => getAutocomplete(q, q.length, source);

describe('tokenizeQuery', () => {
  it('reports words, phrases, exclusions and modifiers with offsets', () => {
    const q = 'deploy from:@bob -"old news" in:"#general" -skip "open';
    const tokens = tokenizeQuery(q);
    expect(tokens.map((t) => [t.key, t.value, t.negated, t.quoted])).toEqual([
      [null, 'deploy', false, false],
      ['from', '@bob', false, false],
      [null, 'old news', true, true],
      ['in', '#general', false, true],
      [null, 'skip', true, false],
      [null, 'open', false, true],
    ]);
    for (const t of tokens) expect(q.slice(t.start, t.end)).toBe(t.raw);
  });

  it('treats unknown key:value words and URLs as plain words', () => {
    const tokens = tokenizeQuery('http://x.io FROM:bob');
    expect(tokens[0].key).toBeNull();
    expect(tokens[1].key).toBe('from');
    expect(hasModifierTokens('see http://x.io')).toBe(false);
  });

  it('removes tokens and tidies whitespace', () => {
    expect(removeTokens('a  from:@bob   b', (t) => t.key === 'from')).toBe('a b');
    expect(removeTokens('unchanged  text', () => false)).toBe('unchanged  text');
    expect(removeRawToken('x from:@nobody y from:@nobody', 'from:@nobody')).toBe('x y from:@nobody');
  });
});

describe('getAutocomplete', () => {
  it('offers the modifier cheat sheet for an empty box, without pre-selecting', () => {
    const ac = at('');
    expect(ac?.title).toBe('Narrow your search');
    expect(ac?.suggestions.map((s) => s.insert)).toContain('from:');
    expect(ac?.suggestions.map((s) => s.insert)).toContain('is:thread');
    expect(ac?.autoSelect).toBe(false);
  });

  it('completes modifier names from two letters, never auto-selecting over a search', () => {
    expect(at('deploy fr')?.suggestions.map((s) => s.insert)).toEqual(['from:']);
    expect(at('deploy fr')?.autoSelect).toBe(false);
    expect(at('i')).toBeNull();
    expect(at('hello')).toBeNull();
    expect(at('deploy ')).toBeNull(); // caret after a space: nothing to complete
  });

  it('suggests people for from:, ranking prefix matches and keeping deactivated users last', () => {
    const ac = at('deploy from:bo');
    expect(ac?.title).toBe('People');
    // Handle prefixes first; "Deploy Bot" only matches on a later word.
    expect(ac?.suggestions.map((s) => s.insert)).toEqual(['from:@bob', 'from:@bobby', 'from:@deploybot']);
    expect(ac?.autoSelect).toBe(true);
    expect(ac?.start).toBe(7);

    expect(at('from:@smi')?.suggestions[0].userId).toBe('U1'); // word prefix of the real name
    const all = at('from:')!;
    expect(all.autoSelect).toBe(false);
    expect(all.suggestions[all.suggestions.length - 1].userId).toBe('U4');
    expect(all.suggestions.find((s) => s.userId === 'U1')?.detail).toContain('you');
  });

  it('does not pre-select when the typed modifier is already complete', () => {
    expect(at('from:@bob')?.autoSelect).toBe(false);
    expect(at('has:image')?.autoSelect).toBe(false);
  });

  it('suggests conversations for in:, narrowing with # and @', () => {
    expect(at('in:#')?.suggestions.map((s) => s.conversationId)).toEqual(['C2', 'C1', 'G1']);
    const dms = at('in:@bo')!.suggestions;
    expect(dms.map((s) => s.insert)).toEqual(['in:@bob']);
    const any = at('in:bob')!.suggestions;
    expect(any.map((s) => s.conversationId)).toEqual(['D2', 'M1']);
    expect(any[1].insert).toBe('in:M1'); // group DMs are referenced by id
  });

  it('offers fixed values for has: and is:', () => {
    expect(at('has:')?.suggestions.map((s) => s.insert)).toEqual([
      'has:file',
      'has:link',
      'has:image',
      'has:reaction',
      'has:thread',
    ]);
    expect(at('has:im')?.suggestions.map((s) => s.insert)).toEqual(['has:image']);
    expect(at('is:')?.suggestions.map((s) => s.insert)).toEqual(['is:thread']);
    expect(at('has:zzz')).toBeNull();
  });

  it('offers date shortcuts, including the Free-plan cutoff', () => {
    const ac = at('before:')!;
    expect(ac.title).toMatch(/YYYY-MM-DD/);
    expect(ac.suggestions.map((s) => s.insert)).toEqual([
      'before:today',
      'before:yesterday',
      'before:2026-09-14',
      'before:2026-08-22',
      'before:2026-06-23',
    ]);
    expect(ac.suggestions[4].detail).toMatch(/Slack Free/);
    expect(at('on:2026-08')?.suggestions.map((s) => s.insert)).toEqual(['on:2026-08-22']);
    expect(at('during:')?.suggestions.map((s) => s.insert)).toEqual([
      'during:2026-09',
      'during:2026-08',
      'during:2026',
      'during:2025',
    ]);
  });

  it('stays quiet inside quotes and for negated modifiers', () => {
    expect(at('"from:bo')).toBeNull();
    expect(at('-from:bo')).toBeNull();
    expect(at('from:"Bob')).toBeNull();
  });

  it('completes the token under the caret, not the last one', () => {
    const q = 'from:al deploy';
    const ac = getAutocomplete(q, 7, source)!;
    expect(ac.suggestions[0].userId).toBe('U1');
    expect(applySuggestion(q, ac, ac.suggestions[0])).toEqual({ value: 'from:@alice deploy', caret: 12 });
  });
});

describe('applySuggestion', () => {
  it('adds one trailing space after a complete token', () => {
    const q = 'deploy from:bo';
    const ac = at(q)!;
    expect(applySuggestion(q, ac, ac.suggestions[0])).toEqual({ value: 'deploy from:@bob ', caret: 17 });
  });

  it('leaves the caret after a bare modifier so its values show next', () => {
    const q = 'deploy fr';
    const ac = at(q)!;
    const next = applySuggestion(q, ac, ac.suggestions[0]);
    expect(next).toEqual({ value: 'deploy from:', caret: 12 });
    expect(getAutocomplete(next.value, next.caret, source)?.title).toBe('People');
  });

  it('replaces the whole box for cheat-sheet picks', () => {
    const ac = at('')!;
    const isThread = ac.suggestions.find((s) => s.insert === 'is:thread')!;
    expect(applySuggestion('', ac, isThread)).toEqual({ value: 'is:thread ', caret: 10 });
  });
});

describe('references', () => {
  it('falls back to the id when a handle would match someone else too', () => {
    const clash = [...users, makeUser('U9', 'Robert', { displayName: 'bob' })];
    expect(userRef(users[1], users)).toBe('@bob');
    expect(userRef(users[1], clash)).toBe('U2');
    expect(userRef(makeUser('U8', 'No Handle', { name: '' }), users)).toBe('U8');
  });

  it('uses #name for channels, @handle for DMs and ids otherwise', () => {
    expect(conversationRef(conversations[0], source)).toBe('#general');
    expect(conversationRef(conversations[3], source)).toBe('@bob');
    expect(conversationRef(conversations[4], source)).toBe('M1');
    const spaced = makeConversation('C7', 'odd name', { rawName: 'odd name' });
    expect(conversationRef(spaced, { ...source, conversations: [...conversations, spaced] })).toBe('C7');
  });
});
