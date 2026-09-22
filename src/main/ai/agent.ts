/**
 * One Ask AI question, answered: Claude reads the chat so far, calls the archive tools until it
 * can answer (a few rounds at most), and the answer streams to the window as it is written.
 *
 * Cost and speed (the reader pays with their own API key):
 *  - effort "low" on the models that take it: fewer, better-aimed tool calls and a short answer;
 *  - the prompt cache: the instructions, tools and the chat so far are sent unchanged every
 *    round, so after the first round they are read from cache at a tenth of the price;
 *  - tool results are compact text (tools.ts), and a round limit stops a runaway search.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiModel } from '../../shared/types';
import { TOOLS, type ToolOutcome } from './tools';

/** Tool rounds before Claude is asked to answer with what it has. */
export const MAX_TOOL_ROUNDS = 8;
/** Per response, thinking included; answers are short, this only stops a runaway. */
const MAX_TOKENS = 8_192;

export interface TokenUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface TurnOptions {
  client: Anthropic;
  model: AiModel;
  system: string;
  /** The chat so far. Not changed here: the caller appends the turn once it has ended well. */
  history: readonly BetaMessageParam[];
  question: string;
  signal: AbortSignal;
  /** Opus asks Anthropic to hand a declined answer to its recommended fallback model. */
  fallbacks: boolean;
  runTool(name: string, input: unknown): ToolOutcome;
  onText(text: string): void;
  onTool(outcome: ToolOutcome): void;
}

export interface TurnResult {
  /** The question and everything after it, for the chat's history. */
  messages: BetaMessageParam[];
  usage: TokenUsage;
  /** The answer hit the output limit. */
  truncated: boolean;
}

/** Claude declined to answer (and so did the fallback model, when there is one). */
export class RefusedError extends Error {
  constructor() {
    super('Claude declined to answer');
    this.name = 'RefusedError';
  }
}

export function emptyUsage(): TokenUsage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

/**
 * Runs the question to an answer. `usage` is filled in as rounds finish, so a stopped or failed
 * turn still reports what it cost.
 */
export async function runTurn(o: TurnOptions, usage: TokenUsage = emptyUsage()): Promise<TurnResult> {
  const messages: BetaMessageParam[] = [{ role: 'user', content: o.question }];
  for (let round = 0; ; round++) {
    const lastRound = round >= MAX_TOOL_ROUNDS;
    const stream = o.client.beta.messages.stream(
      {
        ...modelOptions(o.model, o.fallbacks),
        model: o.model,
        max_tokens: MAX_TOKENS,
        system: o.system,
        tools: TOOLS,
        ...(lastRound ? { tool_choice: { type: 'none' as const } } : {}),
        messages: [...o.history, ...messages],
        // Caches everything up to the newest message, so the next round reads it back cheaply.
        cache_control: { type: 'ephemeral' },
      },
      { signal: o.signal },
    );
    stream.on('text', (delta) => o.onText(delta));
    const message = await stream.finalMessage();
    addUsage(usage, message.usage);
    if (message.stop_reason === 'refusal') throw new RefusedError();

    const content = afterFallback(message.content);
    const calls = content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
    if (message.stop_reason !== 'tool_use' || calls.length === 0) {
      messages.push({ role: 'assistant', content: finalContent(content) });
      return { messages, usage, truncated: message.stop_reason === 'max_tokens' };
    }
    messages.push({ role: 'assistant', content });
    // Tools read the local database synchronously, so running them in order is as fast as any.
    const results = calls.map((call): BetaToolResultBlockParam => {
      const outcome = o.runTool(call.name, call.input);
      o.onTool(outcome);
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: outcome.content,
        ...(outcome.isError ? { is_error: true } : {}),
      };
    });
    messages.push({ role: 'user', content: results });
  }
}

/**
 * What each model is asked for. Thinking stays on where it is the default (turning it off makes
 * Opus 5 worse at tool calls); low effort keeps it short. Haiku 4.5 takes neither setting.
 */
function modelOptions(model: AiModel, fallbacks: boolean) {
  switch (model) {
    case 'claude-opus-5':
      return {
        output_config: { effort: 'low' as const },
        ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      };
    case 'claude-sonnet-5':
      return { thinking: { type: 'adaptive' as const }, output_config: { effort: 'low' as const } };
    case 'claude-haiku-4-5':
      return {};
  }
}

/**
 * When a fallback model took over part-way, the API asks for only the text written before the
 * switch to be kept from the declined part (thinking and tool calls there are dropped).
 */
function afterFallback(content: BetaContentBlock[]): BetaContentBlock[] {
  const last = content.findLastIndex((b) => b.type === 'fallback');
  if (last < 0) return content;
  return [...content.slice(0, last).filter((b) => b.type === 'text'), ...content.slice(last + 1)];
}

/**
 * The last response of a turn, as it is kept for the next question: a tool call cut off by the
 * output limit can never get its result, so it goes (the history must stay valid).
 */
function finalContent(content: BetaContentBlock[]): BetaContentBlock[] {
  const kept = content.filter((b) => b.type !== 'tool_use');
  if (kept.some((b) => b.type === 'text')) return kept;
  return [...kept, { type: 'text', text: '(No answer.)', citations: null }];
}

function addUsage(total: TokenUsage, u: BetaUsage): void {
  total.input += u.input_tokens;
  total.cacheWrite += u.cache_creation_input_tokens ?? 0;
  total.cacheRead += u.cache_read_input_tokens ?? 0;
  total.output += u.output_tokens;
}
