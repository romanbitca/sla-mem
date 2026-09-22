import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { AiEventDTO, AiModel } from '../../shared/types';
import { upsertMessages, type DB } from '../db';
import { msg, seededDb, tsAt } from '../db/test-helpers';
import { AppError } from '../errors';
import { fakeAnthropicFetch, type FakeRequest, type FakeResponse } from '../../../test/mock-anthropic/fake';
import { MemoryAiKeyStore } from './key-store';
import { AiService, describeAiError, usageDTO } from './service';
import { RefusedError } from './agent';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

function archive(): DB {
  const db = seededDb();
  upsertMessages(
    db,
    'C1',
    [msg(tsAt(1), 'Can someone run the e2e tests before the release?'), msg(tsAt(2), 'Lunch?', { user: 'U2' })],
    'api',
  );
  return db;
}

type Script = (req: FakeRequest, round: number) => FakeResponse | undefined;

function setup(script: Script, opts: { model?: AiModel; key?: string | null } = {}) {
  let round = 0;
  const api = fakeAnthropicFetch((req) => (req.method === 'POST' ? script(req, round++) : script(req, -1)));
  const events: AiEventDTO[] = [];
  const logs: string[] = [];
  const service = new AiService({
    db: archive(),
    store: new MemoryAiKeyStore(opts.key === undefined ? KEY : opts.key),
    model: () => opts.model ?? 'claude-opus-5',
    log: (line) => logs.push(line),
    baseURL: 'http://anthropic.test',
    fetch: api.fetch,
  });
  service.on('event', (event: AiEventDTO) => events.push(event));
  const finished = (turnId: string) =>
    new Promise<AiEventDTO>((resolve) => {
      const check = () => {
        const end = events.find((e) => e.turnId === turnId && (e.type === 'done' || e.type === 'error'));
        if (end) resolve(end);
        else setTimeout(check, 5);
      };
      check();
    });
  const posts = () => api.requests.filter((r) => r.method === 'POST');
  return { service, events, logs, api, posts, finished };
}

/** Claude searches once, then answers citing what it found. */
const searchThenAnswer: Script = (_req, round) =>
  round === 0
    ? {
        reply: {
          content: [
            { type: 'thinking', thinking: '', signature: 'sig-1' },
            { type: 'tool_use', id: 'toolu_1', name: 'search_messages', input: { query: 'test' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 1200, cache_write: 1000, output_tokens: 60 },
        },
      }
    : {
        reply: {
          content: [{ type: 'text', text: 'Ali asked for the e2e run before the release [1].' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 400, cache_read: 2200, output_tokens: 40 },
        },
      };

const texts = (events: AiEventDTO[]) =>
  events
    .filter((e): e is Extract<AiEventDTO, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text)
    .join('');

describe('AiService: the API key', () => {
  it('reports whether a key is saved by its last four characters only', () => {
    expect(setup(() => undefined).service.status()).toEqual({ saved: true, hint: '6789' });
    expect(setup(() => undefined, { key: null }).service.status()).toEqual({ saved: false, hint: null });
  });

  it('checks a key with Anthropic (models list, no tokens) before saving it', async () => {
    const { service, api } = setup(() => undefined, { key: null });
    const changed: unknown[] = [];
    service.on('changed', (s) => changed.push(s));
    await expect(service.saveKey(`  ${KEY}\n`)).resolves.toEqual({ saved: true, hint: '6789' });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models' });
    expect(api.requests[0].headers['x-api-key']).toBe(KEY);
    expect(changed).toEqual([{ saved: true, hint: '6789' }]);
    expect(service.removeKey()).toEqual({ saved: false, hint: null });
  });

  it('refuses something that is not an Anthropic key without asking anyone', async () => {
    const { service, api } = setup(() => undefined, { key: null });
    await expect(service.saveKey('sk-proj-1234567890abcdefghijklmnop')).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('sk-ant-'),
    });
    expect(api.requests).toHaveLength(0);
  });

  it('says plainly when Anthropic refuses the key, and never logs it', async () => {
    const { service, logs } = setup(
      () => ({ status: 401, type: 'authentication_error', message: `invalid x-api-key ${KEY}` }),
      { key: null },
    );
    await expect(service.saveKey(KEY)).rejects.toMatchObject({
      code: 'invalid',
      message: 'Anthropic didn’t accept that key. Check that you copied all of it.',
    });
    expect(service.status().saved).toBe(false);
    expect(logs.join('\n')).not.toContain(KEY.slice(10));
  });
});

describe('AiService: answering', () => {
  it('searches the archive with Claude and streams a cited answer', async () => {
    const { service, events, posts, finished, logs } = setup(searchThenAnswer);
    service.ask({ chatId: 'chat-1', turnId: 'turn-1', question: 'Who asked me about tests?' });
    const end = await finished('turn-1');
    expect(end).toMatchObject({ type: 'done', stopped: false });

    // What went to Anthropic: Opus at low effort, the tools, the prompt cache, refusal fallbacks.
    const [first, second] = posts();
    expect(first.path).toBe('/v1/messages');
    expect(first.headers['x-api-key']).toBe(KEY);
    expect(first.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(first.body).toMatchObject({
      model: 'claude-opus-5',
      stream: true,
      max_tokens: 8192,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: 'Who asked me about tests?' }],
    });
    expect(first.body?.thinking).toBeUndefined();
    expect((first.body?.tools as { name: string }[]).map((t) => t.name)).toContain('search_messages');
    expect(first.body?.system).toContain('Today is');

    // The tool ran locally; its compact result went back with the assistant's turn unchanged.
    const messages = second.body?.messages as { role: string; content: unknown }[];
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'thinking', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_1', name: 'search_messages' },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: expect.stringContaining('[1] #general · Ali') },
      ],
    });

    // What the window got: the source behind [1], the step, the text, then done with the cost.
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf('sources')).toBeLessThan(kinds.indexOf('step'));
    expect(events.find((e) => e.type === 'sources')).toMatchObject({
      sources: [{ ref: 1, message: { conversationId: 'C1', ts: tsAt(1) } }],
    });
    expect(events.find((e) => e.type === 'step')).toMatchObject({
      step: { kind: 'search', label: 'Searched “test”', detail: '1 result' },
    });
    expect(texts(events)).toBe('Ali asked for the e2e run before the release [1].');
    expect(end).toMatchObject({
      usage: { model: 'claude-opus-5', inputTokens: 1200 + 1000 + 400 + 2200, outputTokens: 100 },
    });
    // The log says what it cost, never what was asked or found.
    expect(logs.join('\n')).toMatch(/Ask AI: answered with claude-opus-5 .* 1 tool call/);
    expect(logs.join('\n')).not.toContain('tests');
  });

  it('keeps the chat for follow-up questions, with the same numbers for the same messages', async () => {
    const { service, posts, finished } = setup((req, round) =>
      round < 2
        ? searchThenAnswer(req, round)
        : { reply: { content: [{ type: 'text', text: 'Yes [1].' }], stop_reason: 'end_turn' } },
    );
    service.ask({ chatId: 'chat-1', turnId: 'turn-1', question: 'Who asked me about tests?' });
    await finished('turn-1');
    service.ask({ chatId: 'chat-1', turnId: 'turn-2', question: 'Was it before the release?' });
    await finished('turn-2');
    const third = posts()[2].body?.messages as { role: string }[];
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    // Same system prompt: the prompt cache keeps working across the chat.
    expect(posts()[2].body?.system).toBe(posts()[0].body?.system);

    // A new chat starts from nothing.
    service.end('chat-1');
    service.ask({ chatId: 'chat-2', turnId: 'turn-3', question: 'Hello?' });
    await finished('turn-3');
    expect(posts()[3].body?.messages).toHaveLength(1);
  });

  it('tells Claude the limits the reader chose, and when they are lifted', async () => {
    const answer: Script = () => ({ reply: { content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' } });
    const { service, finished, posts } = setup(answer);
    const scope = { conversationIds: ['C1'], userIds: ['U2'], after: '2026-09-01', before: null };
    service.ask({ chatId: 'c', turnId: 't1', question: 'Anything?', scope });
    await finished('t1');
    expect(posts()[0].body?.messages).toEqual([
      {
        role: 'user',
        content:
          '[The user limited this question to: #general; messages by Bob Brown; since 2026-09-01. The tools only look within these limits.]\n\nAnything?',
      },
    ]);
    service.ask({ chatId: 'c', turnId: 't2', question: 'And now?' });
    await finished('t2');
    const last = (posts()[1].body?.messages as { content: string }[]).at(-1);
    expect(last?.content).toBe('[No limits any more: the whole archive.]\n\nAnd now?');
    service.ask({ chatId: 'c', turnId: 't3', question: 'Again?' });
    await finished('t3');
    expect((posts()[2].body?.messages as { content: string }[]).at(-1)?.content).toBe('Again?');

    expect(() =>
      service.ask({ chatId: 'c', turnId: 't4', question: 'Hi', scope: { conversationIds: ['../x'], userIds: [] } }),
    ).toThrow('Invalid conversation');
    expect(() =>
      service.ask({ chatId: 'c', turnId: 't4', question: 'Hi', scope: { after: '2026-09-10', before: '2026-09-01' } }),
    ).toThrow('wrong way round');
  });

  it('asks each model only for what it supports', async () => {
    const answer: Script = () => ({ reply: { content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' } });
    const haiku = setup(answer, { model: 'claude-haiku-4-5' });
    haiku.service.ask({ chatId: 'c', turnId: 't', question: 'Hi' });
    await haiku.finished('t');
    const body = haiku.posts()[0].body!;
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('fallbacks');

    const sonnet = setup(answer, { model: 'claude-sonnet-5' });
    sonnet.service.ask({ chatId: 'c', turnId: 't', question: 'Hi' });
    await sonnet.finished('t');
    expect(sonnet.posts()[0].body).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
    expect(sonnet.posts()[0].body).not.toHaveProperty('fallbacks');
  });

  it('stops when asked, keeping what was written for the next question', async () => {
    const { service, finished, posts } = setup((_req, round) =>
      round === 0
        ? { hangAfter: 'Let me look' }
        : { reply: { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' } },
    );
    service.ask({ chatId: 'c', turnId: 't1', question: 'First?' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    service.stop('c');
    await expect(finished('t1')).resolves.toMatchObject({ type: 'done', stopped: true });
    service.ask({ chatId: 'c', turnId: 't2', question: 'Second?' });
    await finished('t2');
    expect(posts()[1].body?.messages).toEqual([
      { role: 'user', content: 'First?' },
      { role: 'assistant', content: 'Let me look' },
      { role: 'user', content: 'Second?' },
    ]);
  });

  it('answers one question at a time per chat, and needs a key', async () => {
    const busy = setup(() => ({ hangAfter: '…' }));
    busy.service.ask({ chatId: 'c', turnId: 't1', question: 'One' });
    expect(() => busy.service.ask({ chatId: 'c', turnId: 't2', question: 'Two' })).toThrow(AppError);
    busy.service.shutdown();

    const none = setup(() => undefined, { key: null });
    expect(() => none.service.ask({ chatId: 'c', turnId: 't', question: 'Hi' })).toThrow(
      'Add your Anthropic API key in Settings → Ask AI first.',
    );
    expect(() => none.service.ask({ chatId: '../x', turnId: 't', question: 'Hi' })).toThrow('Invalid chat');
  });

  it('turns failures into plain words', async () => {
    const badKey = setup(() => ({ status: 401, type: 'authentication_error', message: 'invalid x-api-key' }));
    badKey.service.ask({ chatId: 'c', turnId: 't', question: 'Hi' });
    await expect(badKey.finished('t')).resolves.toMatchObject({ type: 'error', kind: 'bad_key' });

    const broke = setup(() => ({
      status: 400,
      type: 'invalid_request_error',
      message: 'Your credit balance is too low to access the Anthropic API.',
    }));
    broke.service.ask({ chatId: 'c', turnId: 't', question: 'Hi' });
    await expect(broke.finished('t')).resolves.toMatchObject({ type: 'error', kind: 'no_credit' });

    const refused = setup(() => ({ reply: { content: [], stop_reason: 'refusal' } }));
    refused.service.ask({ chatId: 'c', turnId: 't', question: 'Hi' });
    await expect(refused.finished('t')).resolves.toMatchObject({ type: 'error', kind: 'refused' });
  });

  it('asks again without refusal fallbacks when the account can’t use them', async () => {
    const { service, finished, posts, logs } = setup((req) =>
      req.body?.fallbacks
        ? { status: 400, type: 'invalid_request_error', message: 'fallbacks: this beta is not available' }
        : { reply: { content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' } },
    );
    service.ask({ chatId: 'c', turnId: 't', question: 'Hi' });
    await expect(finished('t')).resolves.toMatchObject({ type: 'done' });
    expect(posts().map((p) => 'fallbacks' in (p.body ?? {}))).toEqual([true, false]);
    expect(logs.join('\n')).toContain('asking without them from now on');
  });
});

describe('usage and errors', () => {
  it('prices tokens at list prices, cache reads at a tenth and writes at 1.25×', () => {
    const cost = usageDTO('claude-opus-5', {
      input: 1_000_000,
      cacheWrite: 1_000_000,
      cacheRead: 1_000_000,
      output: 1_000_000,
    });
    expect(cost.costUsd).toBeCloseTo(5 + 6.25 + 0.5 + 25);
    expect(cost.inputTokens).toBe(3_000_000);
    expect(usageDTO('claude-haiku-4-5', { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 }).costUsd).toBe(1);
  });

  it('describes overload and connection problems', () => {
    const overloaded = new Anthropic.InternalServerError(
      529,
      { type: 'overloaded_error' },
      'Overloaded',
      new Headers(),
    );
    expect(describeAiError(overloaded).kind).toBe('overloaded');
    expect(describeAiError(new Anthropic.APIConnectionError({ message: 'fetch failed' })).kind).toBe('offline');
    expect(describeAiError(new RefusedError()).kind).toBe('refused');
    expect(describeAiError(new Error('boom'))).toEqual({
      kind: 'failed',
      message: 'Something went wrong while answering. Try again.',
    });
  });
});
