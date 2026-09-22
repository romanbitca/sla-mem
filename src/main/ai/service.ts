/**
 * Ask AI: questions about the archive, answered by Claude with the reader's own Anthropic API
 * key. Only while a question is being answered do the question and the messages Claude reads
 * from the archive go to Anthropic; nothing is sent otherwise.
 *
 * Chats live in this process's memory only. Nothing about them is written anywhere, "New chat"
 * forgets one, and quitting forgets them all. A few recent chats are kept so the window can
 * leave the Ask AI screen (to open a cited message) and come back to the same chat. What each
 * question cost is kept (usage-log.ts), never what was asked.
 *
 * Emits 'event' (AiEventDTO) while answers are written and 'changed' (AiKeyStatusDTO) when the
 * key is saved or removed.
 */
import { EventEmitter } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  AiErrorKind,
  AiEventDTO,
  AiKeyStatusDTO,
  AiModel,
  AiScopeDTO,
  AiSpendingDTO,
  AiUsageDTO,
  StyleReviewDTO,
} from '../../shared/types';
import { getMeta, styleSample, type DB } from '../db';
import { blocked, conflict, invalid } from '../errors';
import { safeErrorMessage } from '../redact';
import { optionalDate, record, slackId, string } from '../validate';
import { addUsage, emptyUsage, RefusedError, runTurn, type TokenUsage, type TurnResult } from './agent';
import { isAnthropicKey, type AiKeyStore } from './key-store';
import { promptFacts, systemPrompt } from './prompt';
import type { StyleReviewStore } from './review-store';
import {
  JSON_ONLY,
  MIN_REVIEW_MESSAGES,
  parseReview,
  REVIEW_CHARS,
  REVIEW_MESSAGES,
  REVIEW_SCHEMA,
  REVIEW_SYSTEM,
  reviewInput,
} from './style-review';
import { describeScope, runTool, SourceRefs, type ToolOutcome } from './tools';
import type { AiUsageLog, AiUsageOutcome } from './usage-log';

export interface AiServiceOptions {
  db: DB;
  store: AiKeyStore;
  /** The model chosen in Settings, read for each question. */
  model: () => AiModel;
  /** Where what each question cost is kept (Settings → Ask AI → Spending). */
  usage?: Pick<AiUsageLog, 'record' | 'spending'>;
  /** Where the last review of your writing is kept (My style). */
  reviews?: Pick<StyleReviewStore, 'get' | 'set'>;
  log?: (line: string) => void;
  /** Development / test override for Anthropic's API (never honoured by packaged builds). */
  baseURL?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const ANTHROPIC_API = 'https://api.anthropic.com';
/** Chats kept in memory; the least recently used idle one goes first. */
const MAX_CHATS = 4;
const MAX_QUESTION_CHARS = 4_000;
/**
 * Roughly 60k tokens of history. Every question re-sends the whole chat, so past this a chat asks
 * to be started afresh instead of getting slower and dearer with each question.
 */
const MAX_CHAT_CHARS = 240_000;
/** Text reaches the window in small batches rather than token by token. */
const TEXT_FLUSH_MS = 40;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Anthropic's list prices in US dollars per million tokens (cache writes 1.25×, reads 0.1×). */
const PRICES: Record<AiModel, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

interface Chat {
  id: string;
  /** Fixed when the chat starts, so every question in it reuses the prompt cache. */
  system: string;
  history: BetaMessageParam[];
  refs: SourceRefs;
  /** Characters of history, for MAX_CHAT_CHARS. */
  size: number;
  running: { turnId: string; controller: AbortController } | null;
  lastUsed: number;
  /** The limits Claude was last told about (to say when they are lifted). */
  toldScope: string | null;
}

export class AiService extends EventEmitter {
  /** undefined until first read from the store. */
  private key: string | null | undefined;
  private readonly chats = new Map<string, Chat>();
  /** Off for the rest of the session if the API ever refuses the fallbacks option. */
  private fallbacks = true;
  /** A style review is being written (one at a time). */
  private reviewing = false;
  /** Off for the session if the API refuses structured outputs: the review asks for JSON in words. */
  private structuredReviews = true;

  constructor(private readonly opts: AiServiceOptions) {
    super();
  }

  status(): AiKeyStatusDTO {
    const key = this.loadKey();
    return { saved: key != null, hint: key ? key.slice(-4) : null };
  }

  /** Checks the key with Anthropic (listing models costs nothing), then keeps it encrypted. */
  async saveKey(raw: unknown): Promise<AiKeyStatusDTO> {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!isAnthropicKey(key)) {
      throw invalid('That doesn’t look like an Anthropic API key. Those start with “sk-ant-”.');
    }
    try {
      await this.client(key).models.list({ limit: 1 });
    } catch (err) {
      this.log(`Ask AI: checking an API key failed: ${safeErrorMessage(err, [key])}`);
      if (err instanceof Anthropic.AuthenticationError) {
        throw invalid('Anthropic didn’t accept that key. Check that you copied all of it.');
      }
      if (err instanceof Anthropic.PermissionDeniedError) {
        throw invalid('That key isn’t allowed to use Anthropic’s API. Check it in your Anthropic account.');
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw blocked('Couldn’t reach Anthropic to check the key. Check your internet connection and try again.');
      }
      throw blocked('Anthropic couldn’t check the key just now. Try again in a moment.');
    }
    this.opts.store.set(key);
    this.key = key;
    this.log('Ask AI: API key saved');
    this.emit('changed', this.status());
    return this.status();
  }

  removeKey(): AiKeyStatusDTO {
    for (const chat of this.chats.values()) chat.running?.controller.abort();
    this.opts.store.clear();
    this.key = null;
    this.log('Ask AI: API key removed');
    this.emit('changed', this.status());
    return this.status();
  }

  /** Starts answering; progress arrives as 'event's. */
  ask(req: unknown): void {
    const r = record(req, 'question');
    const chatId = id(r.chatId, 'chat');
    const turnId = id(r.turnId, 'question');
    const question = string(r.question, 'question', MAX_QUESTION_CHARS).trim();
    if (!question) throw invalid('Type a question first.');
    const scope = scopeOf(r.scope);
    const key = this.loadKey();
    if (!key) throw blocked('Add your Anthropic API key in Settings → Ask AI first.');
    const chat = this.chat(chatId);
    if (chat.running) throw conflict('Wait for the answer to finish, or stop it.');
    if (chat.size > MAX_CHAT_CHARS) {
      throw blocked(
        'This chat has got long, and every question re-reads all of it. Start a new chat to keep answers quick.',
      );
    }
    const controller = new AbortController();
    chat.running = { turnId, controller };
    chat.lastUsed = Date.now();
    void this.answer(chat, turnId, question, scope, key, controller);
  }

  /** What Ask AI has cost, per day. */
  spending(): AiSpendingDTO {
    return this.opts.usage?.spending() ?? { days: [] };
  }

  /**
   * My style: Claude reads your latest messages (only yours) and reviews your writing. The
   * messages go to Anthropic for this one request; the review is kept until the next one.
   */
  async reviewStyle(): Promise<StyleReviewDTO> {
    const key = this.loadKey();
    if (!key) throw blocked('Add your Anthropic API key in Settings → Ask AI first.');
    if (this.reviewing) throw conflict('Claude is already reviewing your messages.');
    const self = getMeta(this.opts.db, 'self_user_id');
    const sample = self ? styleSample(this.opts.db, self, { limit: REVIEW_MESSAGES, maxChars: REVIEW_CHARS }) : [];
    if (sample.length < MIN_REVIEW_MESSAGES) {
      throw invalid(
        `Claude needs at least ${MIN_REVIEW_MESSAGES} of your messages to review; the archive has ${sample.length}.`,
      );
    }
    const model = this.opts.model();
    const usage = emptyUsage();
    const started = Date.now();
    this.reviewing = true;
    try {
      const input = reviewInput(sample, promptFacts(this.opts.db, this.now()).userLabel);
      let answer: string;
      try {
        answer = await this.reviewRequest(key, model, this.structuredReviews ? input : input + JSON_ONLY, usage);
      } catch (err) {
        // A model or account without structured outputs (or anything else about the request it
        // won't take): ask once more for the JSON in words, and keep doing so this session.
        if (!this.structuredReviews || !(err instanceof Anthropic.BadRequestError)) throw err;
        this.structuredReviews = false;
        this.log(
          `My style: the API refused structured outputs (${safeErrorMessage(err, [key])}); asking for JSON in the answer from now on`,
        );
        answer = await this.reviewRequest(key, model, input + JSON_ONLY, usage);
      }
      const review = parseReview(answer, sample);
      const cost = usageDTO(model, usage);
      this.recordUsage(cost, 'answered');
      this.log(
        `My style: Claude reviewed ${sample.length} messages with ${model} in ${((Date.now() - started) / 1000).toFixed(1)} s, ` +
          `${cost.inputTokens} tokens in, ${cost.outputTokens} out, about $${cost.costUsd.toFixed(3)}`,
      );
      const saved: StyleReviewDTO = { ...review, messageCount: sample.length, usage: cost, at: this.now().getTime() };
      this.opts.reviews?.set(saved);
      return saved;
    } catch (err) {
      this.recordUsage(usageDTO(model, usage), 'failed');
      if (err instanceof Error && /^The review/.test(err.message)) {
        this.log(`My style: ${err.message}`);
        throw blocked('Claude’s review came back unreadable. Try again.');
      }
      const problem = describeAiError(err);
      this.log(`My style: review failed (${problem.kind}): ${safeErrorMessage(err, [key])}`);
      throw blocked(
        problem.kind === 'failed' ? 'Something went wrong while Claude was reviewing. Try again.' : problem.message,
      );
    } finally {
      this.reviewing = false;
    }
  }

  /** The last review, kept until the next one; null before the first. */
  savedReview(): StyleReviewDTO | null {
    return this.opts.reviews?.get() ?? null;
  }

  private async reviewRequest(key: string, model: AiModel, input: string, usage: TokenUsage): Promise<string> {
    const structured = this.structuredReviews;
    const stream = this.client(key).beta.messages.stream({
      model,
      max_tokens: 4_000,
      system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: input }],
      ...(structured || model !== 'claude-haiku-4-5'
        ? {
            output_config: {
              // Enough thought for a review; no tools, so "low" is plenty.
              ...(model !== 'claude-haiku-4-5' ? { effort: 'low' as const } : {}),
              ...(structured ? { format: { type: 'json_schema' as const, schema: REVIEW_SCHEMA } } : {}),
            },
          }
        : {}),
    });
    const message = await stream.finalMessage();
    addUsage(usage, message.usage);
    if (message.stop_reason === 'refusal') throw new RefusedError();
    return message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
  }

  stop(chatId: unknown): void {
    this.chats.get(id(chatId, 'chat'))?.running?.controller.abort();
  }

  /** Forgets a chat, stopping its answer if one is being written. */
  end(chatId: unknown): void {
    const key = id(chatId, 'chat');
    this.chats.get(key)?.running?.controller.abort();
    this.chats.delete(key);
  }

  shutdown(): void {
    for (const chat of this.chats.values()) chat.running?.controller.abort();
    this.chats.clear();
  }

  // ─── answering ───────────────────────────────────────────────────────────────────────────────

  private async answer(
    chat: Chat,
    turnId: string,
    question: string,
    scope: AiScopeDTO | null,
    key: string,
    controller: AbortController,
  ): Promise<void> {
    const send = (event: DistributiveOmit<AiEventDTO, 'chatId' | 'turnId'>) =>
      this.emit('event', { chatId: chat.id, turnId, ...event } as AiEventDTO);
    const model = this.opts.model();
    const limits = describeScope(this.opts.db, scope);
    const asked = withLimits(question, limits, chat.toldScope);
    const started = Date.now();
    const usage = emptyUsage();
    let recorded = false;
    const keepCost = (outcome: AiUsageOutcome): AiUsageDTO => {
      const cost = usageDTO(model, usage);
      if (!recorded) this.recordUsage(cost, outcome);
      recorded = true;
      return cost;
    };
    let written = '';
    let pending = '';
    let calls = 0;
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (pending) send({ type: 'text', text: pending });
      pending = '';
    };
    const onTool = (outcome: ToolOutcome) => {
      calls += 1;
      flush();
      if (outcome.sources.length) send({ type: 'sources', sources: outcome.sources });
      if (outcome.step) send({ type: 'step', step: outcome.step });
    };
    const turn = (fallbacks: boolean): Promise<TurnResult> =>
      runTurn(
        {
          client: this.client(key),
          model,
          system: chat.system,
          history: chat.history,
          question: asked,
          signal: controller.signal,
          fallbacks,
          runTool: (name, input) => runTool({ db: this.opts.db, refs: chat.refs, now: this.now(), scope }, name, input),
          onText: (text) => {
            written += text;
            pending += text;
            timer ??= setTimeout(flush, TEXT_FLUSH_MS);
          },
          onTool,
        },
        usage,
      );

    try {
      let result: TurnResult;
      try {
        result = await turn(model === 'claude-opus-5' && this.fallbacks);
      } catch (err) {
        // An account the fallbacks beta isn't open to: ask again without it, once.
        if (!(err instanceof Anthropic.BadRequestError) || !/fallback/i.test(err.message) || written || calls)
          throw err;
        this.fallbacks = false;
        this.log('Ask AI: the API refused refusal fallbacks; asking without them from now on');
        result = await turn(false);
      }
      flush();
      this.commit(chat, result.messages, limits);
      if (result.truncated) send({ type: 'text', text: '\n\n(The answer was cut short.)' });
      const cost = keepCost('answered');
      send({ type: 'done', usage: cost, stopped: false });
      this.log(
        `Ask AI: answered with ${model} in ${((Date.now() - started) / 1000).toFixed(1)} s, ` +
          `${calls} tool call(s), ${cost.inputTokens} tokens in (${usage.cacheRead} from cache), ` +
          `${cost.outputTokens} out, about $${cost.costUsd.toFixed(3)}`,
      );
    } catch (err) {
      flush();
      if (controller.signal.aborted) {
        // What was written stays in the chat, so a follow-up question has it as context.
        this.commit(
          chat,
          [
            { role: 'user', content: asked },
            { role: 'assistant', content: written.trim() || '(Stopped before answering.)' },
          ],
          limits,
        );
        send({ type: 'done', usage: keepCost('stopped'), stopped: true });
        return;
      }
      // Rounds that finished before the failure were paid for.
      keepCost('failed');
      const problem = describeAiError(err);
      this.log(`Ask AI failed (${problem.kind}): ${safeErrorMessage(err, [key])}`);
      send({ type: 'error', kind: problem.kind, message: problem.message });
    } finally {
      if (timer) clearTimeout(timer);
      if (chat.running?.turnId === turnId) chat.running = null;
      chat.lastUsed = Date.now();
    }
  }

  /**
   * Keeps what a question cost, whenever it used anything. Called before the answer's log line:
   * the first read of spending brings over costs from the log, which must not count this one twice.
   */
  private recordUsage(cost: AiUsageDTO, outcome: AiUsageOutcome): void {
    if (cost.inputTokens + cost.outputTokens === 0) return;
    this.opts.usage?.record({
      at: this.now().getTime(),
      model: cost.model,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      costUsd: cost.costUsd,
      outcome,
    });
  }

  private commit(chat: Chat, messages: BetaMessageParam[], limits: string | null): void {
    chat.history.push(...messages);
    chat.size += JSON.stringify(messages).length;
    chat.toldScope = limits;
  }

  private chat(chatId: string): Chat {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = {
        id: chatId,
        system: systemPrompt(promptFacts(this.opts.db, this.now())),
        history: [],
        refs: new SourceRefs(),
        size: 0,
        running: null,
        lastUsed: Date.now(),
        toldScope: null,
      };
      this.chats.set(chatId, chat);
      const idle = [...this.chats.values()].filter((c) => !c.running && c !== chat);
      idle.sort((a, b) => a.lastUsed - b.lastUsed);
      while (this.chats.size > MAX_CHATS && idle.length) this.chats.delete(idle.shift()!.id);
    }
    return chat;
  }

  private client(key: string): Anthropic {
    return new Anthropic({
      apiKey: key,
      // Explicit, so environment variables meant for other tools never redirect or re-authorise it.
      authToken: null,
      baseURL: this.opts.baseURL ?? ANTHROPIC_API,
      fetch: this.opts.fetch,
      maxRetries: 2,
      timeout: 120_000,
    });
  }

  private loadKey(): string | null {
    if (this.key === undefined) {
      try {
        this.key = this.opts.store.get();
      } catch (err) {
        this.log(`Ask AI: couldn’t read the saved API key: ${safeErrorMessage(err)}`);
        this.key = null;
      }
    }
    return this.key;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The question as Claude gets it: with the reader's limits in front when there are any, or a
 * word that earlier limits are gone.
 */
function withLimits(question: string, limits: string | null, told: string | null): string {
  if (limits) {
    return `[Note from Slamem, not the user: they limited this question to ${limits}. The tools only look within these limits.]\n\n${question}`;
  }
  if (told) return `[Note from Slamem, not the user: no limits any more, the whole archive.]\n\n${question}`;
  return question;
}

/** The limits sent with a question, checked; null when they limit nothing. */
function scopeOf(value: unknown): AiScopeDTO | null {
  if (value == null) return null;
  const r = record(value, 'limits');
  const ids = (list: unknown, name: string): string[] => {
    if (list == null) return [];
    if (!Array.isArray(list) || list.length > 1_000) throw invalid(`Invalid ${name} limit`);
    return [...new Set(list.map((item) => slackId(item, name)))];
  };
  const scope: AiScopeDTO = {
    conversationIds: ids(r.conversationIds, 'conversation'),
    userIds: ids(r.userIds, 'person'),
    after: optionalDate(r.after, 'from') ?? null,
    before: optionalDate(r.before, 'to') ?? null,
  };
  if (scope.after && scope.before && scope.after >= scope.before) throw invalid('The dates are the wrong way round.');
  return scope.conversationIds.length || scope.userIds.length || scope.after || scope.before ? scope : null;
}

function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw invalid(`Invalid ${name}`);
  return value;
}

export function usageDTO(model: AiModel, u: TokenUsage): AiUsageDTO {
  const price = PRICES[model];
  const costUsd =
    (u.input * price.input +
      u.cacheWrite * price.input * 1.25 +
      u.cacheRead * price.input * 0.1 +
      u.output * price.output) /
    1_000_000;
  return { model, inputTokens: u.input + u.cacheWrite + u.cacheRead, outputTokens: u.output, costUsd };
}

/** What went wrong, in words for the chat (never a status code). */
export function describeAiError(err: unknown): { kind: AiErrorKind; message: string } {
  if (err instanceof RefusedError) {
    return { kind: 'refused', message: 'Claude declined to answer this. Try asking another way.' };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: 'bad_key', message: 'Anthropic didn’t accept your API key. Check it in Settings → Ask AI.' };
  }
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
    return {
      kind: 'bad_key',
      message:
        'Your API key can’t use this model. Choose another one in Settings → Ask AI, or check your Anthropic account.',
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return {
      kind: 'rate_limited',
      message: 'Anthropic is limiting how often your key can ask. Wait a minute and try again.',
    };
  }
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
    return {
      kind: 'no_credit',
      message: 'Your Anthropic account is out of credit. Add some in the Anthropic Console, then ask again.',
    };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: 'offline', message: 'Couldn’t reach Anthropic. Check your internet connection and try again.' };
  }
  if (err instanceof Anthropic.APIError && (err.status === 529 || err.status === 503)) {
    return { kind: 'overloaded', message: 'Claude is very busy right now. Try again in a moment.' };
  }
  return { kind: 'failed', message: 'Something went wrong while answering. Try again.' };
}
