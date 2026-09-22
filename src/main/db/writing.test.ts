import { describe, expect, it } from 'vitest';
import type { StyleCheckDTO } from '../../shared/types';
import type { SlackMessage } from '../slack/types';
import { msg, seededDb } from './test-helpers';
import type { DB } from './types';
import { upsertMessages } from './write';
import { writingChecks } from './writing';

// seededDb(): the reader is USELF; U1 "Alice Anderson" (Ali); C1 #general; D1 the DM with Alice.

const NOW = Date.UTC(2026, 8, 30);
/** A ts on a September 2026 day (Monday the 21st), at a UTC time. */
const ts = (day: number, h: number, min = 0, s = 0) => `${Date.UTC(2026, 8, day, h, min, s) / 1000}.000000`;
const me = { user: 'USELF' };
const put = (db: DB, conversationId: string, messages: SlackMessage[]) =>
  upsertMessages(db, conversationId, messages, 'api');
const byId = (checks: StyleCheckDTO[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

/** A reader who greets now and then, writes in small letters and slang, and sends bursts. */
function casualWriter(): DB {
  const db = seededDb();
  put(db, 'D1', [
    // Conversations the reader starts (three quiet hours before each).
    msg(ts(21, 10), 'can you check the invoice?', me),
    msg(ts(22, 10), 'hello, how are you?', me),
    msg(ts(22, 10, 20), 'good, you?'),
    msg(ts(22, 10, 25), 'can you send the report today?', me),
    msg(ts(23, 10), 'hi Alice, can you please review the draft?', me),
    msg(ts(24, 10), 'yeah i dont think we need it', me),
    msg(ts(28, 10), 'Hi, could you look at this?', me),
  ]);
  put(db, 'C1', [
    // Three messages in a row, each within a minute.
    msg(ts(21, 14), 'ok', me),
    msg(ts(21, 14, 0, 30), 'im gonna check the logs', me),
    msg(ts(21, 14, 0, 50), 'i will update you', me),
    msg(ts(25, 9), 'the deploy is done', me),
    msg(ts(25, 11), 'i think we need more tests', me),
    msg(ts(25, 12), 'thanks man!', me),
    msg(ts(25, 13), 'we are gonna ship it on monday', me),
    msg(ts(25, 14), 'can you merge it?', me),
    msg(ts(25, 15), 'can you add the tests?', me),
    msg(ts(25, 16), 'yeah that works for me', me),
    msg(ts(25, 17), 'Numbers look right to me', me),
    msg(ts(26, 9), 'the release notes are up', me),
    msg(ts(26, 10), 'we should rename the job', me),
    msg(ts(26, 11), 'the fix is on staging now', me),
    msg(ts(26, 12), 'Let me know when it is merged', me),
    msg(ts(26, 13), 'it is fine by me', me),
    msg(ts(26, 14), 'we can talk after the call', me),
    // Opening with a mention, the sentence reads on without a capital.
    msg(ts(26, 14, 30), '<@U1> the logs are in the ticket', me),
    // Someone else's words are never judged.
    msg(ts(26, 15), 'yeah lol', { user: 'U1' }),
  ]);
  return db;
}

describe('writingChecks', () => {
  it('finds the habits to work on, each with one of your messages rewritten', () => {
    const result = writingChecks(casualWriter(), 'USELF', { now: NOW });
    expect(result.messageCount).toBe(24);
    const checks = byId(result.checks);

    expect(checks.capitals).toMatchObject({ good: false, total: result.englishCount });
    expect(checks.capitals.count).toBeGreaterThan(result.englishCount / 2);
    // All but the three that start with a capital and the one that opens with a mention.
    expect(result.englishCount).toBe(24);
    expect(checks.capitals.count).toBe(20);
    expect(checks.capitals.words.map((w) => w.word)).toEqual(expect.arrayContaining(['i', 'im', 'dont']));
    // The example is the message with the most to fix.
    expect(checks.capitals.example).toMatchObject({
      before: 'yeah i dont think we need it',
      after: "Yeah I don't think we need it",
    });

    // 3 of the 5 conversations started open with a greeting; one asked how Alice is.
    expect(checks.greeting).toMatchObject({ good: false, count: 3, total: 5 });
    expect(checks.greeting.words).toEqual([{ word: 'how are you', count: 1 }]);
    expect(checks.greeting.example).toMatchObject({
      before: 'yeah i dont think we need it',
      after: "Hi Alice, yeah I don't think we need it",
      conversationId: 'D1',
    });

    expect(checks.casual.good).toBe(false);
    // Alice's "yeah lol" isn't counted: only your words are.
    expect(checks.casual.words).toEqual([
      { word: 'gonna', count: 2 },
      { word: 'yeah', count: 2 },
      { word: 'man', count: 1 },
    ]);

    expect(checks.oneMessage).toMatchObject({ good: false, count: 1, total: 24 });
    expect(checks.oneMessage.example).toMatchObject({
      before: 'ok\nim gonna check the logs\ni will update you',
      after: "Ok. I'm gonna check the logs. I will update you.",
    });

    // "can you …": 1 of 5 says please.
    expect(checks.please).toMatchObject({ good: false, count: 1, total: 5 });
    expect(checks.please.example?.after).toMatch(/^Could you please /);

    // One hello-only opener in five is within bounds.
    expect(checks.greetAndAsk).toMatchObject({ good: true, count: 1, total: 5, example: null });

    // Tips first, the habits after; friendly (60% greet) but not polished.
    expect(result.checks.at(-1)?.id).toBe('greetAndAsk');
    expect(result.tone).toBe('friendly');
  });

  it('calls a careful writer professional, with nothing to fix', () => {
    const db = seededDb();
    const lines = [
      'Hi Alice, could you check the invoice, please?',
      'Thanks, that is exactly what I needed.',
      'I will send the report today.',
      'Could you please review the draft?',
      'The deploy is done.',
      'I think we need more tests.',
      'Let me know when it is merged.',
      'We can talk after the call.',
      'The release notes are up.',
      'I am on it.',
      'Could you merge it, please?',
      'Could you add the tests, please?',
    ];
    put(
      db,
      'D1',
      // A conversation a day, opened with a hello and followed up half an hour later.
      lines.map((text, i) =>
        msg(ts(21 + Math.floor(i / 2), 9, i % 2 ? 30 : 0), `${i % 2 ? '' : 'Hello! '}${text}`, me),
      ),
    );
    put(
      db,
      'C1',
      Array.from({ length: 12 }, (_, i) => msg(ts(22, 9, i * 5), `Can you please check item ${i + 1}? Thanks.`, me)),
    );
    const result = writingChecks(db, 'USELF', { now: NOW });
    expect(result.checks.filter((c) => !c.good)).toEqual([]);
    expect(result.checks.every((c) => c.example === null)).toBe(true);
    expect(result.tone).toBe('professional');
  });

  it('says nothing it can’t back: too few messages leave the checks out', () => {
    const db = seededDb();
    put(db, 'D1', [msg(ts(21, 10), 'hi', me), msg(ts(21, 11), 'yeah', me)]);
    expect(writingChecks(db, 'USELF', { now: NOW })).toMatchObject({ messageCount: 2, checks: [], tone: null });
  });

  it('reads only your latest messages, and never your notes to yourself', () => {
    const db = casualWriter();
    put(db, 'D2', [msg(ts(29, 10), 'note to self: yeah gonna do it', me)]);
    expect(writingChecks(db, 'USELF', { now: NOW }).messageCount).toBe(24);
    expect(writingChecks(db, 'USELF', { now: NOW, limit: 10 }).messageCount).toBe(10);
  });
});
