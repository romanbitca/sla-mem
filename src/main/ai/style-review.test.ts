import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StyleReviewDTO } from '../../shared/types';
import { upsertMessages, type DB } from '../db';
import type { SampleMessage } from '../db/style-sample';
import { msg, seededDb } from '../db/test-helpers';
import { fakeAnthropicFetch, type FakeRequest, type FakeResponse } from '../../../test/mock-anthropic/fake';
import { MemoryAiKeyStore } from './key-store';
import { readReview, StyleReviewStore } from './review-store';
import { AiService } from './service';
import { JSON_ONLY, parseReview, REVIEW_SYSTEM, reviewInput } from './style-review';
import type { AiUsageEntry } from './usage-log';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

const sample = (text: string, i: number): SampleMessage => ({
  text,
  where: i % 2 ? 'channel' : 'dm',
  time: 1_790_000_000 - i * 60,
  conversationId: i % 2 ? 'C1' : 'D1',
  ts: `${1_790_000_000 - i * 60}.000000`,
  threadTs: null,
  isReply: false,
});

describe('the review’s input and answer', () => {
  const messages = ['can u check the invoice', 'The deploy is done.', 'this is a mess, fix it now'].map(sample);

  it('numbers your messages for Claude, newest first, one per line', () => {
    expect(reviewInput(messages, 'Roman')).toBe(
      "These are Roman's latest 3 Slack messages:\n\n[1] [dm] can u check the invoice\n[2] [channel] The deploy is done.\n[3] [dm] this is a mess, fix it now",
    );
    expect(reviewInput([sample('a\n\nb', 0)], null)).toBe('These are my latest 1 Slack messages:\n\n[1] [dm] a / b');
  });

  it('checks the answer: messages found by number, rewrites that change nothing and junk left out', () => {
    const review = parseReview(
      `Here you go:\n${JSON.stringify({
        summary: 'You are quick, but blunt under pressure.',
        strengths: ['Quick', 'Clear', 'Kind', 'Too many'],
        tips: [
          { title: 'Soften pushback', tip: 'Say what you need.', message: 3, rewrite: 'Could we sort this out today?' },
          { title: 'Same as before', tip: 'No change.', message: 2, rewrite: 'The deploy is done.' },
          { title: 'No message', tip: 'In general.', message: 0, rewrite: '' },
          { title: 'Out of range', tip: 'Made up.', message: 99, rewrite: 'Something' },
          { title: '', tip: 'No title.', message: 1, rewrite: 'x' },
        ],
        typos: [
          { wrong: 'clinet', right: 'client' },
          { wrong: 'Clinet', right: 'client' },
          { wrong: 'same', right: 'SAME' },
        ],
      })}\nThanks!`,
      messages,
    );
    expect(review.summary).toBe('You are quick, but blunt under pressure.');
    expect(review.strengths).toEqual(['Quick', 'Clear', 'Kind']);
    expect(review.tips).toEqual([
      {
        title: 'Soften pushback',
        tip: 'Say what you need.',
        before: 'this is a mess, fix it now',
        after: 'Could we sort this out today?',
        message: { conversationId: 'D1', ts: messages[2].ts, threadTs: null, isReply: false },
      },
      { title: 'Same as before', tip: 'No change.', before: null, after: null, message: null },
      { title: 'No message', tip: 'In general.', before: null, after: null, message: null },
      { title: 'Out of range', tip: 'Made up.', before: null, after: null, message: null },
    ]);
    expect(review.typos).toEqual([{ wrong: 'clinet', right: 'client' }]);
  });

  it('refuses an answer that isn’t a review', () => {
    expect(() => parseReview('I cannot help with that.', messages)).toThrow(/wasn’t readable/);
    expect(() => parseReview('{"summary": ""}', messages)).toThrow(/was empty/);
  });
});

describe('the saved review', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slamem-review-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const review: StyleReviewDTO = {
    summary: 'You are quick.',
    strengths: ['Quick'],
    tips: [{ title: 'T', tip: 'Do this.', before: 'a', after: 'A', message: null }],
    typos: [],
    messageCount: 150,
    usage: { model: 'claude-sonnet-5', inputTokens: 7000, outputTokens: 900, costUsd: 0.023 },
    at: 1_790_000_000_000,
  };

  it('is kept in a file only its owner can read, and read back as it was', () => {
    const file = path.join(dir, 'style-review.json');
    const store = new StyleReviewStore(file);
    expect(store.get()).toBeNull();
    store.set(review);
    expect(store.get()).toEqual(review);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('ignores a file that isn’t a review, and drops fields that don’t belong', () => {
    const file = path.join(dir, 'style-review.json');
    const logs: string[] = [];
    fs.writeFileSync(file, '{not json');
    expect(new StyleReviewStore(file, (l) => logs.push(l)).get()).toBeNull();
    expect(logs).toEqual(['My style: the saved review isn’t readable; it is ignored']);
    expect(readReview({ ...review, usage: { ...review.usage, model: 'gpt-5' } })).toBeNull();
    expect(
      readReview({ ...review, tips: [{ title: 'T' }, 'x', { title: 'T', tip: 'ok', message: { ts: 1 } }] })?.tips,
    ).toEqual([{ title: 'T', tip: 'ok', before: null, after: null, message: null }]);
  });
});

// ─── through AiService ──────────────────────────────────────────────────────────────────────

const REVIEW = {
  summary: 'You come across as helpful and quick.',
  strengths: ['Helpful'],
  tips: [
    { title: 'Lead with the ask', tip: 'Put the question first.', message: 1, rewrite: 'Could you check item 30?' },
  ],
  typos: [{ wrong: 'recieve', right: 'receive' }],
};

function yourMessages(count: number): DB {
  const db = seededDb();
  const base = Date.UTC(2026, 8, 21, 9) / 1000;
  upsertMessages(
    db,
    'D1',
    Array.from({ length: count }, (_, i) =>
      msg(`${base + i * 60}.000000`, `can you check item ${i + 1}?`, { user: 'USELF' }),
    ),
    'api',
  );
  // Nobody else's words are sent.
  upsertMessages(db, 'D1', [msg(`${base + 30}.000000`, 'Alice’s private words')], 'api');
  return db;
}

function reviewer(
  respond: (req: FakeRequest, n: number) => FakeResponse | undefined,
  opts: { key?: string | null; count?: number } = {},
) {
  let n = 0;
  const api = fakeAnthropicFetch((req) => (req.method === 'POST' ? respond(req, n++) : undefined));
  const saved: StyleReviewDTO[] = [];
  const costs: AiUsageEntry[] = [];
  const logs: string[] = [];
  const service = new AiService({
    db: yourMessages(opts.count ?? 30),
    store: new MemoryAiKeyStore(opts.key === undefined ? KEY : opts.key),
    model: () => 'claude-sonnet-5',
    usage: { record: (e) => costs.push(e), spending: () => ({ days: [] }) },
    reviews: { get: () => saved.at(-1) ?? null, set: (r) => saved.push(r) },
    log: (line) => logs.push(line),
    baseURL: 'http://anthropic.test',
    fetch: api.fetch,
  });
  const posts = () => api.requests.filter((r) => r.method === 'POST');
  return { service, saved, costs, logs, posts };
}

const answer = (text: string): FakeResponse => ({
  reply: {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 6000, output_tokens: 700 },
  },
});

describe('AiService: reviewing your writing', () => {
  it('sends your latest messages, only yours, asks for the review’s shape, and keeps the review and its cost', async () => {
    const { service, saved, costs, logs, posts } = reviewer(() => answer(JSON.stringify(REVIEW)));
    const review = await service.reviewStyle();
    const body = posts()[0].body!;
    expect(body.system).toBe(REVIEW_SYSTEM);
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    const input = (body.messages as { content: string }[])[0].content;
    expect(input).toMatch(
      /^These are selfie's latest 30 Slack messages:\n\n\[1\] \[dm\] can you check item 30\?\n\[2\] \[dm\] can you check item 29\?/,
    );
    expect(input).not.toContain('Alice’s private words');

    expect(review).toMatchObject({
      summary: REVIEW.summary,
      tips: [
        { before: 'can you check item 30?', after: 'Could you check item 30?', message: { conversationId: 'D1' } },
      ],
      typos: [{ wrong: 'recieve', right: 'receive' }],
      messageCount: 30,
      usage: { model: 'claude-sonnet-5', inputTokens: 6000, outputTokens: 700 },
    });
    expect(saved).toEqual([review]);
    expect(service.savedReview()).toEqual(review);
    expect(costs).toMatchObject([{ model: 'claude-sonnet-5', outcome: 'answered' }]);
    expect(logs.join('\n')).toMatch(/My style: Claude reviewed 30 messages with claude-sonnet-5/);
    expect(logs.join('\n')).not.toContain('item 30');
  });

  it('asks for the JSON in words when the API doesn’t take structured outputs, from then on', async () => {
    const { service, posts, logs } = reviewer((req) =>
      (req.body?.output_config as { format?: unknown } | undefined)?.format
        ? { status: 400, type: 'invalid_request_error', message: 'output_config.format: not supported for this model' }
        : answer(`Sure:\n${JSON.stringify(REVIEW)}`),
    );
    await expect(service.reviewStyle()).resolves.toMatchObject({ summary: REVIEW.summary });
    await service.reviewStyle();
    const sent = posts();
    expect(sent).toHaveLength(3);
    expect((sent[1].body!.messages as { content: string }[])[0].content.endsWith(JSON_ONLY)).toBe(true);
    expect(sent[2].body!.output_config).toEqual({ effort: 'low' });
    expect(logs.join('\n')).toContain('refused structured outputs');
  });

  it('says what is missing: a key, enough messages, a readable answer; one review at a time', async () => {
    await expect(reviewer(() => undefined, { key: null }).service.reviewStyle()).rejects.toMatchObject({
      code: 'blocked',
      message: 'Add your Anthropic API key in Settings → Ask AI first.',
    });
    await expect(reviewer(() => undefined, { count: 5 }).service.reviewStyle()).rejects.toMatchObject({
      code: 'invalid',
      message: 'Claude needs at least 20 of your messages to review; the archive has 5.',
    });
    const garbled = reviewer(() => answer('I would rather not.'));
    await expect(garbled.service.reviewStyle()).rejects.toMatchObject({
      code: 'blocked',
      message: 'Claude’s review came back unreadable. Try again.',
    });
    expect(garbled.costs).toMatchObject([{ outcome: 'failed' }]);
    expect(garbled.saved).toEqual([]);

    const slow = reviewer(() => ({ ...answer(JSON.stringify(REVIEW)), delayMs: 20 }));
    const first = slow.service.reviewStyle();
    await expect(slow.service.reviewStyle()).rejects.toMatchObject({ code: 'conflict' });
    await expect(first).resolves.toMatchObject({ summary: REVIEW.summary });
  });
});
