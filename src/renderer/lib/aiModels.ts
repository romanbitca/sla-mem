import type { AiModel, AiUsageDTO } from '../../shared/types';
import { formatCount } from './format';

/** How Settings and the Ask AI screen name each model (prices from Anthropic's list). */
export const AI_MODEL_INFO: Record<AiModel, { name: string; note: string }> = {
  'claude-sonnet-5': { name: 'Claude Sonnet 5', note: 'recommended' },
  'claude-haiku-4-5': { name: 'Claude Haiku 4.5', note: 'fastest, half the price' },
  'claude-opus-5': { name: 'Claude Opus 5', note: 'smartest, most expensive' },
};

/** "Claude Opus 5 · 8.1k tokens · $0.03" under an answer. */
export function describeUsage(usage: AiUsageDTO): string {
  const tokens = usage.inputTokens + usage.outputTokens;
  const cost = usage.costUsd < 0.01 ? 'under $0.01' : `$${usage.costUsd.toFixed(2)}`;
  return `${AI_MODEL_INFO[usage.model]?.name ?? usage.model} · ${formatCount(tokens)} tokens · ${cost}`;
}
