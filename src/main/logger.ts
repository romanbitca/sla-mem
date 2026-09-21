/**
 * The app log: `<dataDir>/logs/main.log`, rotated to main.1.log when it passes ~5 MB (so at most
 * ~10 MB on disk, PLAN §10.6). Every line is redacted, so a token or cookie can never reach the
 * log even when an error message quotes one (PLAN §3.5, Stage 2 acceptance: grep finds nothing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
  /** Absolute path of the current log file. */
  readonly file: string;
}

export interface LoggerOptions {
  dir: string;
  maxBytes?: number;
  /** Mirror to the console (development). */
  echo?: boolean;
  now?: () => Date;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function createLogger(opts: LoggerOptions): Logger {
  const file = path.join(opts.dir, 'main.log');
  const rotated = path.join(opts.dir, 'main.1.log');
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  let size = -1;

  const write = (level: LogLevel, message: string) => {
    const line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${redactSecrets(message)}\n`;
    if (opts.echo) (level === 'error' ? console.error : console.log)(line.trimEnd());
    try {
      if (size < 0) {
        fs.mkdirSync(opts.dir, { recursive: true });
        size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      }
      if (size + line.length > maxBytes) {
        fs.rmSync(rotated, { force: true });
        if (fs.existsSync(file)) fs.renameSync(file, rotated);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch {
      // Logging must never take the app down (disk full, folder removed…).
      size = -1;
    }
  };

  return {
    file,
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m, err) => write('error', err === undefined ? m : `${m}: ${describe(err)}`),
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

/** A logger that discards everything (tests). */
export const nullLogger: Logger = { file: '', info: () => {}, warn: () => {}, error: () => {} };
