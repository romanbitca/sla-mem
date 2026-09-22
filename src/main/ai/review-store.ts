/**
 * Claude's last review of your writing (My style), kept in `<dataDir>/style-review.json` so the
 * page shows it every time until you ask for a new one: nothing goes to Anthropic again unasked.
 * It holds your own words (the rewrites), so only you can read the file; one that doesn't read
 * as a review is ignored.
 */
import fs from 'node:fs';
import { AI_MODELS, type AiModel, type StyleReviewDTO, type StyleReviewTipDTO } from '../../shared/types';
import { writeFileAtomicSync } from '../fsx';

const MAX_TEXT = 4_000;

export class StyleReviewStore {
  constructor(
    private readonly file: string,
    private readonly log?: (line: string) => void,
  ) {}

  get(): StyleReviewDTO | null {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      return readReview(JSON.parse(text));
    } catch {
      this.log?.('My style: the saved review isn’t readable; it is ignored');
      return null;
    }
  }

  set(review: StyleReviewDTO): void {
    try {
      writeFileAtomicSync(this.file, `${JSON.stringify(review)}\n`, 0o600);
    } catch (err) {
      this.log?.(`My style: couldn’t save the review: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** A saved review, checked field by field; null when it isn't one. */
export function readReview(v: unknown): StyleReviewDTO | null {
  if (!isRecord(v)) return null;
  const summary = text(v.summary);
  const usage = v.usage;
  if (!summary || !isRecord(usage) || !AI_MODELS.includes(usage.model as AiModel)) return null;
  const tips: StyleReviewTipDTO[] = [];
  for (const t of Array.isArray(v.tips) ? v.tips : []) {
    if (!isRecord(t) || !text(t.title) || !text(t.tip)) continue;
    const m = t.message;
    const message =
      isRecord(m) && typeof m.conversationId === 'string' && typeof m.ts === 'string'
        ? {
            conversationId: m.conversationId,
            ts: m.ts,
            threadTs: typeof m.threadTs === 'string' ? m.threadTs : null,
            isReply: m.isReply === true,
          }
        : null;
    tips.push({
      title: text(t.title),
      tip: text(t.tip),
      before: text(t.before) || null,
      after: text(t.after) || null,
      message,
    });
  }
  return {
    summary,
    strengths: (Array.isArray(v.strengths) ? v.strengths : []).map(text).filter(Boolean),
    tips,
    typos: (Array.isArray(v.typos) ? v.typos : [])
      .filter(isRecord)
      .map((t) => ({ wrong: text(t.wrong), right: text(t.right) }))
      .filter((t) => t.wrong && t.right),
    messageCount: count(v.messageCount),
    usage: {
      model: usage.model as AiModel,
      inputTokens: count(usage.inputTokens),
      outputTokens: count(usage.outputTokens),
      costUsd: typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) ? usage.costUsd : 0,
    },
    at: count(v.at),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, MAX_TEXT) : '';
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}
