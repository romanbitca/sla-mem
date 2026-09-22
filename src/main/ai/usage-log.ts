/**
 * What Ask AI has cost, for Settings → Ask AI → Spending: one line per question in
 * `<dataDir>/ai-usage.jsonl` with when it finished, the model, the tokens and the price estimated
 * at Anthropic's list prices. Never the question or the answer.
 *
 * Until 0.3.5 the cost was only written to the log ("Ask AI: answered with …, about $0.03"). The
 * first time spending is needed, those lines are read back once, so it starts with the first
 * question ever asked rather than with this version.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AI_MODELS, type AiModel, type AiSpendingDTO } from '../../shared/types';

/** How a question ended. Stopped and failed ones are paid for what they used too. */
export type AiUsageOutcome = 'answered' | 'stopped' | 'failed';

export interface AiUsageEntry {
  /** Epoch ms when the question finished. */
  at: number;
  model: AiModel;
  /** Everything read, cached or not. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  outcome: AiUsageOutcome;
}

export interface AiUsageLogOptions {
  file: string;
  /** The app's log folder, read once for costs logged before this file existed. */
  logsDir?: string;
  log?: (line: string) => void;
}

const OUTCOMES: readonly AiUsageOutcome[] = ['answered', 'stopped', 'failed'];

/** The line AiService logs for each answer (the log's own time stamp in front). */
const LOGGED_ANSWER =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) INFO +Ask AI: answered with (\S+) in [\d.]+ s, \d+ tool call\(s\), (\d+) tokens in \(\d+ from cache\), (\d+) out, about \$(\d+(?:\.\d+)?)$/;

export class AiUsageLog {
  /** Read from the file on first use, then kept up to date in memory. */
  private entries: AiUsageEntry[] | null = null;

  constructor(private readonly opts: AiUsageLogOptions) {}

  /** Adds a question's cost. Never throws: losing one line must not break an answer. */
  record(entry: AiUsageEntry): void {
    const entries = this.load();
    entries.push(entry);
    try {
      fs.appendFileSync(this.opts.file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      this.log(`Ask AI: couldn’t save what an answer cost: ${describe(err)}`);
    }
  }

  /** Spending per local day, oldest first. */
  spending(): AiSpendingDTO {
    const days = new Map<string, { costUsd: number; questions: number }>();
    for (const entry of this.load()) {
      const key = localDate(entry.at);
      const day = days.get(key) ?? { costUsd: 0, questions: 0 };
      day.costUsd += entry.costUsd;
      day.questions += 1;
      days.set(key, day);
    }
    return {
      days: [...days]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, day]) => ({ date, costUsd: Math.round(day.costUsd * 1e6) / 1e6, questions: day.questions })),
    };
  }

  private load(): AiUsageEntry[] {
    if (this.entries) return this.entries;
    let text: string;
    try {
      text = fs.readFileSync(this.opts.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // There, but unreadable: start empty for now, and never write over it.
        this.log(`Ask AI: couldn’t read what earlier answers cost: ${describe(err)}`);
        this.entries = [];
        return this.entries;
      }
      this.entries = this.start();
      return this.entries;
    }
    this.entries = parseEntries(text);
    return this.entries;
  }

  /** No file yet: begin it with what earlier versions logged. */
  private start(): AiUsageEntry[] {
    const logged = this.opts.logsDir ? readLoggedAnswers(this.opts.logsDir) : [];
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true });
      fs.writeFileSync(this.opts.file, logged.map((e) => `${JSON.stringify(e)}\n`).join(''));
      if (logged.length) this.log(`Ask AI: spending starts with ${logged.length} earlier answer(s) found in the log`);
    } catch (err) {
      this.log(`Ask AI: couldn’t start the spending record: ${describe(err)}`);
    }
    return logged;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }
}

/** The file's lines; anything that isn't a whole, sensible entry (a cut-off last line) is skipped. */
export function parseEntries(text: string): AiUsageEntry[] {
  const entries: AiUsageEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = asEntry(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // Not JSON: skipped.
    }
  }
  return entries;
}

function asEntry(value: unknown): AiUsageEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const count = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
  if (!AI_MODELS.includes(v.model as AiModel)) return null;
  if (!count(v.inputTokens) || !count(v.outputTokens)) return null;
  if (typeof v.costUsd !== 'number' || !Number.isFinite(v.costUsd) || v.costUsd < 0) return null;
  if (!OUTCOMES.includes(v.outcome as AiUsageOutcome)) return null;
  return {
    at: v.at,
    model: v.model as AiModel,
    inputTokens: v.inputTokens as number,
    outputTokens: v.outputTokens as number,
    costUsd: v.costUsd,
    outcome: v.outcome as AiUsageOutcome,
  };
}

/** Answers logged by 0.3.3 and 0.3.4, oldest first (the rotated log, then the current one). */
export function readLoggedAnswers(logsDir: string): AiUsageEntry[] {
  const entries: AiUsageEntry[] = [];
  for (const name of ['main.1.log', 'main.log']) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(logsDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = LOGGED_ANSWER.exec(line.trimEnd());
      if (!m || !AI_MODELS.includes(m[2] as AiModel)) continue;
      const at = Date.parse(m[1]);
      if (!Number.isFinite(at)) continue;
      entries.push({
        at,
        model: m[2] as AiModel,
        inputTokens: Number(m[3]),
        outputTokens: Number(m[4]),
        costUsd: Number(m[5]),
        outcome: 'answered',
      });
    }
  }
  return entries;
}

/** YYYY-MM-DD in local time. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
