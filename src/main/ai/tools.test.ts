import { describe, expect, it } from 'vitest';
import { upsertMessages, type DB } from '../db';
import { msg, seededDb, tsAt } from '../db/test-helpers';
import { describeScope, runTool, SourceRefs, TOOLS, type ToolContext } from './tools';

const pad = (n: number) => String(n).padStart(2, '0');
/** What the tools print for a ts: local date and minutes. */
function local(ts: string): { day: string; time: string } {
  const d = new Date(Math.round(parseFloat(ts) * 1000));
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}
function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * #general (C1): Alice asks for the e2e tests (a thread with Bob's and the reader's replies), then
 * unrelated chatter; the DM with Alice (D1) has a follow-up about the tests two days later.
 */
function archive(): DB {
  const db = seededDb();
  upsertMessages(
    db,
    'C1',
    [
      msg(tsAt(0), 'Morning all'),
      msg(tsAt(1), 'Can someone run the e2e tests before the release on Friday?', {
        thread_ts: tsAt(1),
        reply_count: 2,
        latest_reply: tsAt(3),
      }),
      msg(tsAt(2), 'Which suite, the flaky one?', { thread_ts: tsAt(1), user: 'U2' }),
      msg(tsAt(3), 'I will run it tonight', { thread_ts: tsAt(1), user: 'USELF' }),
      msg(tsAt(4), 'Lunch at noon?', { user: 'U2' }),
      msg(tsAt(5), `A very long paste ${'lorem ipsum '.repeat(150)} with the word deploy near the end`, { user: 'U2' }),
    ],
    'api',
  );
  upsertMessages(db, 'D1', [msg(tsAt(2 * 24 * 60), 'Did the tests pass in the end?')], 'api');
  return db;
}

function context(db: DB): ToolContext {
  return { db, refs: new SourceRefs(), now: new Date((1_700_000_000 + 10 * 24 * 3600) * 1000) };
}

describe('Ask AI tools', () => {
  it('describes four tools with stable, strict-enough schemas', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'search_messages',
      'open_message',
      'read_conversation',
      'list_conversations',
    ]);
    for (const tool of TOOLS) expect(tool.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('searches with Slack syntax and numbers the messages it shows', () => {
    const ctx = context(archive());
    const out = runTool(ctx, 'search_messages', { query: 'test' });
    expect(out.isError).toBe(false);
    expect(out.step).toEqual({ kind: 'search', label: 'Searched “test”', detail: '2 results' });
    const lines = out.content.split('\n');
    expect(lines[0]).toBe('2 matches (most relevant first):');
    // Newest wins a tie on relevance; either way both carry a number, a place, an author and a time.
    expect(out.content).toContain('[1] DM with Ali · Ali ·');
    expect(out.content).toContain(`[2] #general · Ali · ${local(tsAt(1)).day} ${local(tsAt(1)).time} · 2 replies`);
    expect(out.content).toContain('Can someone run the e2e tests before the release on Friday?');
    expect(out.sources.map((s) => s.ref)).toEqual([1, 2]);
    expect(out.sources[1].message).toMatchObject({ conversationId: 'C1', ts: tsAt(1) });

    // The same message keeps its number; only new ones are sources.
    const again = runTool(ctx, 'search_messages', { query: 'tests from:ali', sort: 'newest' });
    expect(again.content).toContain('[1] DM with Ali');
    expect(again.sources).toEqual([]);
  });

  it('labels the reader as You and shortens long messages to the matching part', () => {
    const ctx = context(archive());
    const mine = runTool(ctx, 'search_messages', { query: 'from:me' });
    expect(mine.content).toContain('· You ·');
    expect(mine.content).toContain('thread reply');
    const long = runTool(ctx, 'search_messages', { query: 'deploy' });
    expect(long.content).toMatch(/deploy near the end.*\[long message\]/);
    expect(long.content.length).toBeLessThan(700);
  });

  it('says why a name or date matched nothing, with the closest names', () => {
    const ctx = context(archive());
    const person = runTool(ctx, 'search_messages', { query: 'tests from:alicia' });
    expect(person.step?.detail).toBe('no match for a name or date');
    expect(person.content).toContain('Nothing matches from:alicia');
    expect(person.content).toContain('People with a similar name: Ali (from:alice)');
    const channel = runTool(ctx, 'search_messages', { query: 'in:#generals tests' });
    expect(channel.content).toContain('Conversations with a similar name: #general');
    const date = runTool(ctx, 'search_messages', { query: 'tests after:2026-13-40' });
    expect(date.content).toContain('Dates are YYYY-MM-DD');
  });

  it('opens a numbered message with its whole thread', () => {
    const ctx = context(archive());
    runTool(ctx, 'search_messages', { query: 'suite' }); // [1] = Bob's reply
    const out = runTool(ctx, 'open_message', { ref: 1 });
    expect(out.step).toEqual({ kind: 'read', label: 'Read a thread in #general', detail: null });
    const lines = out.content.split('\n');
    expect(lines[0]).toBe('Thread in #general, started by Ali (2 replies):');
    expect(lines[1]).toBe(
      `[2] ${local(tsAt(1)).day} ${local(tsAt(1)).time} Ali: Can someone run the e2e tests before the release on Friday?`,
    );
    expect(lines[2]).toMatch(/^ {2}\[1\] \d\d:\d\d Bob Brown: Which suite, the flaky one\?$/);
    expect(lines[3]).toMatch(/^ {2}\[3\] \d\d:\d\d You: I will run it tonight$/);
    expect(out.sources.map((s) => s.ref)).toEqual([2, 3]);
  });

  it('opens a message outside threads with the messages around it', () => {
    const ctx = context(archive());
    runTool(ctx, 'search_messages', { query: 'lunch' });
    const out = runTool(ctx, 'open_message', { ref: 1, context: 1 });
    expect(out.content.split('\n')).toEqual([
      '#general, around [1]:',
      expect.stringMatching(/Ali: Can someone run the e2e tests/),
      expect.stringMatching(/^\[1\] \d\d:\d\d Bob Brown: Lunch at noon\?$/),
      expect.stringMatching(/Bob Brown: A very long paste/),
    ]);
  });

  it('explains a bad or unknown number instead of failing', () => {
    const ctx = context(archive());
    expect(runTool(ctx, 'open_message', { ref: 7 })).toMatchObject({ isError: true, step: null });
    expect(runTool(ctx, 'open_message', {}).content).toContain('ref is required');
    expect(runTool(ctx, 'nope', {}).content).toBe('There is no tool called nope.');
  });

  it('reads a conversation over a period, replies under their thread', () => {
    const ctx = context(archive());
    const day = local(tsAt(1)).day;
    const out = runTool(ctx, 'read_conversation', { conversation: '#general', after: day, before: nextDay(day) });
    expect(out.step?.label).toBe(`Read #general, ${day} to ${day}`);
    const lines = out.content.split('\n');
    expect(lines[0]).toMatch(/^#general, .*: \d+ messages\.$/);
    // The date is written once, then only times while the day stays the same.
    expect(lines.filter((l) => l.includes(day))).toHaveLength(2);
    const replyIndex = lines.findIndex((l) => l.includes('Which suite'));
    expect(lines[replyIndex]).toMatch(/^ {2}\[\d+\] \d\d:\d\d Bob Brown: Which suite/);
    expect(lines[replyIndex - 1]).toContain('Can someone run the e2e tests');
    // The long paste is cut for reading.
    expect(out.content).not.toContain('deploy near the end');
    expect(out.content).toContain('… [cut]');
  });

  it('reading the latest messages keeps the newest when threads fill the budget', () => {
    const ctx = context(archive());
    const out = runTool(ctx, 'read_conversation', { conversation: '#general', limit: 3 });
    expect(out.content).toMatch(/^#general: \d+ messages \(the latest ones; give dates for earlier messages\)\./);
    expect(out.content).toContain('Lunch at noon?');
    expect(out.content).toContain('A very long paste');
    expect(out.content).not.toContain('Morning all');
    // Still in time order, and numbered in the order shown.
    const refs = [...out.content.matchAll(/^ *\[(\d+)\]/gm)].map((m) => Number(m[1]));
    expect(refs).toEqual([...refs].sort((a, b) => a - b));
  });

  it('finds a conversation by person, id or name, and says when it is ambiguous or unknown', () => {
    const ctx = context(archive());
    expect(runTool(ctx, 'read_conversation', { conversation: '@alice' }).content).toMatch(/^DM with Ali: 1 message\./);
    expect(runTool(ctx, 'read_conversation', { conversation: 'D1' }).content).toMatch(/^DM with Ali/);
    const unknown = runTool(ctx, 'read_conversation', { conversation: '#nowhere' });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content).toContain('No conversation matches “#nowhere”');
    const bad = runTool(ctx, 'read_conversation', { conversation: '#general', after: 'last week' });
    expect(bad.content).toBe('after must be a date like 2026-03-14.');
  });

  it('keeps every tool inside the limits the reader chose', () => {
    const ctx = { ...context(archive()), scope: { conversationIds: ['C1'], userIds: [], after: null, before: null } };
    // The DM follow-up about the tests is outside: only #general's message is found.
    const found = runTool(ctx, 'search_messages', { query: 'test' });
    expect(found.content).toContain('1 match');
    expect(found.content).not.toContain('DM with Ali');
    const outside = runTool(ctx, 'search_messages', { query: 'tests in:@alice' });
    expect(outside.content).toContain("within the user's limits (#general)");
    expect(runTool(ctx, 'read_conversation', { conversation: '@alice' })).toMatchObject({
      isError: true,
      content: 'The user limited this question to #general; DM with Ali isn’t one of them.',
    });
    expect(runTool(ctx, 'list_conversations', {}).content).not.toContain('DM with Ali');

    const bob = { ...ctx, scope: { conversationIds: [], userIds: ['U2'], after: null, before: null } };
    expect(runTool(bob, 'search_messages', { query: 'suite' }).content).toContain('Bob Brown');
    expect(runTool(bob, 'search_messages', { query: 'test' }).content).toContain('No messages match within');
    expect(runTool(bob, 'list_conversations', {}).content).toContain('#general (C1): 3 messages');

    const day = local(tsAt(2 * 24 * 60)).day;
    const later = { ...ctx, scope: { conversationIds: [], userIds: [], after: day, before: null } };
    expect(runTool(later, 'read_conversation', { conversation: '#general' }).content).toContain('has no messages');
    expect(runTool(later, 'read_conversation', { conversation: '#general', before: day })).toMatchObject({
      isError: true,
    });
  });

  it('describes the limits for Claude', () => {
    const db = archive();
    expect(describeScope(db, null)).toBeNull();
    expect(
      describeScope(db, {
        conversationIds: ['C1', 'D1'],
        userIds: ['U1', 'USELF'],
        after: '2026-09-14',
        before: '2026-09-21',
      }),
    ).toBe('#general, DM with Ali; messages by Ali, the user; 2026-09-14 to 2026-09-20');
  });

  it('lists the busiest conversations, in a period or by name', () => {
    const ctx = context(archive());
    const all = runTool(ctx, 'list_conversations', {});
    expect(all.content.split('\n')).toEqual([
      'Conversations, busiest first:',
      `#general (C1): 6 messages, latest ${local(tsAt(5)).day}`,
      `DM with Ali (D1): 1 message, latest ${local(tsAt(2 * 24 * 60)).day}`,
    ]);
    const day = local(tsAt(2 * 24 * 60)).day;
    const later = runTool(ctx, 'list_conversations', { after: day });
    expect(later.content).toContain(`Conversations since ${day}, busiest first:`);
    expect(later.content).not.toContain('#general');
    expect(runTool(ctx, 'list_conversations', { name: 'ali' }).content).toContain('DM with Ali (D1)');
  });
});
