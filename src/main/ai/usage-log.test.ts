import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiUsageLog, localDate, parseEntries, readLoggedAnswers, type AiUsageEntry } from './usage-log';

let dir: string;
let logsDir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-'));
  logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir);
  file = path.join(dir, 'ai-usage.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Local noon on a day in September 2026, plus some minutes. */
const on = (day: number, minutes = 0) => new Date(2026, 8, day, 12, minutes).getTime();

function entry(at: number, costUsd: number, extra: Partial<AiUsageEntry> = {}): AiUsageEntry {
  return {
    at,
    model: 'claude-sonnet-5',
    inputTokens: 20_000,
    outputTokens: 500,
    costUsd,
    outcome: 'answered',
    ...extra,
  };
}

/** A line as 0.3.3 and 0.3.4 logged it. */
const logged = (iso: string, cost: string, model = 'claude-sonnet-5') =>
  `${iso} INFO  Ask AI: answered with ${model} in 24.2 s, 13 tool call(s), 33076 tokens in (26485 from cache), 1076 out, about $${cost}`;

describe('AiUsageLog', () => {
  it('adds up what the questions cost per local day, oldest first', () => {
    const usage = new AiUsageLog({ file });
    expect(usage.spending()).toEqual({ days: [] });
    usage.record(entry(on(22, 5), 0.033));
    usage.record(entry(on(20), 0.01, { outcome: 'stopped' }));
    usage.record(entry(on(22, 30), 0.027, { model: 'claude-opus-5', outcome: 'failed' }));
    expect(usage.spending()).toEqual({
      days: [
        { date: '2026-09-20', costUsd: 0.01, questions: 1 },
        { date: '2026-09-22', costUsd: 0.06, questions: 2 },
      ],
    });
  });

  it('keeps one line per question in the file, read back after a restart', () => {
    new AiUsageLog({ file }).record(entry(on(21), 0.012));
    new AiUsageLog({ file }).record(entry(on(21, 1), 0.02));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(entry(on(21), 0.012));
    expect(new AiUsageLog({ file }).spending().days).toEqual([{ date: '2026-09-21', costUsd: 0.032, questions: 2 }]);
  });

  it('starts with the answers earlier versions logged, once', () => {
    fs.writeFileSync(
      path.join(logsDir, 'main.1.log'),
      [
        '2026-09-22T10:59:05.397Z INFO  Slamem 0.3.3 starting (darwin arm64)',
        logged('2026-09-22T11:07:53.279Z', '0.033'),
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(logsDir, 'main.log'),
      [
        logged('2026-09-22T11:08:14.878Z', '0.027'),
        '2026-09-22T11:09:00.000Z INFO  Ask AI failed (offline): fetch failed',
        logged('2026-09-22T11:10:01.031Z', '0.012', 'claude-unknown-9'),
        logged('2026-09-22T11:42:18.230Z', '0.010'),
        '',
      ].join('\n'),
    );
    const lines: string[] = [];
    const usage = new AiUsageLog({ file, logsDir, log: (line) => lines.push(line) });
    const days = usage.spending().days;
    expect(days.reduce((n, d) => n + d.questions, 0)).toBe(3);
    expect(days.reduce((sum, d) => sum + d.costUsd, 0)).toBeCloseTo(0.07, 6);
    expect(lines).toEqual(['Ask AI: spending starts with 3 earlier answer(s) found in the log']);
    expect(parseEntries(fs.readFileSync(file, 'utf8'))[0]).toEqual({
      at: Date.parse('2026-09-22T11:07:53.279Z'),
      model: 'claude-sonnet-5',
      inputTokens: 33076,
      outputTokens: 1076,
      costUsd: 0.033,
      outcome: 'answered',
    });

    // From then on the file is the record: the log is never read again, so nothing counts twice.
    usage.record(entry(on(22), 0.02));
    fs.appendFileSync(path.join(logsDir, 'main.log'), `${logged('2026-09-22T12:00:00.000Z', '0.020')}\n`);
    const again = new AiUsageLog({ file, logsDir });
    expect(again.spending().days.reduce((n, d) => n + d.questions, 0)).toBe(4);
  });

  it('starts an empty record when nothing was logged, and never reads the log afterwards', () => {
    new AiUsageLog({ file, logsDir }).spending();
    expect(fs.readFileSync(file, 'utf8')).toBe('');
    fs.writeFileSync(path.join(logsDir, 'main.log'), `${logged('2026-09-22T11:07:53.279Z', '0.033')}\n`);
    expect(new AiUsageLog({ file, logsDir }).spending()).toEqual({ days: [] });
  });

  it('skips lines that are cut off or make no sense', () => {
    const good = entry(on(22), 0.01);
    fs.writeFileSync(
      file,
      [
        JSON.stringify(good),
        '{"at": 1, "model": "claude-sonnet-5"',
        JSON.stringify({ ...good, costUsd: -1 }),
        JSON.stringify({ ...good, model: 'gpt' }),
        JSON.stringify({ ...good, outcome: 'maybe' }),
        JSON.stringify({ ...good, inputTokens: 1.5 }),
        'null',
        '',
      ].join('\n'),
    );
    expect(new AiUsageLog({ file }).spending().days).toEqual([{ date: '2026-09-22', costUsd: 0.01, questions: 1 }]);
  });

  it('never breaks an answer when the record can’t be written, and never writes over one it can’t read', () => {
    const lines: string[] = [];
    // A folder where the file should be: reading and writing both fail.
    fs.mkdirSync(file);
    const usage = new AiUsageLog({ file, logsDir, log: (line) => lines.push(line) });
    expect(() => usage.record(entry(on(22), 0.01))).not.toThrow();
    expect(usage.spending().days).toEqual([{ date: '2026-09-22', costUsd: 0.01, questions: 1 }]);
    expect(lines[0]).toMatch(/^Ask AI: couldn’t read what earlier answers cost/);
    expect(lines[1]).toMatch(/^Ask AI: couldn’t save what an answer cost/);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });
});

describe('the helpers', () => {
  it('reads nothing from a folder without logs', () => {
    expect(readLoggedAnswers(path.join(dir, 'missing'))).toEqual([]);
  });

  it('names local days', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05');
    expect(localDate(new Date(2026, 11, 31, 0, 0).getTime())).toBe('2026-12-31');
  });
});
