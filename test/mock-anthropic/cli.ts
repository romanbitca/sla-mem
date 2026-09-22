/**
 * Starts the pretend Claude (see server.ts) for trying Ask AI in a development build:
 *
 *   npm run mock:claude                     # prints the URL, keeps running
 *   SLA_MEM_ANTHROPIC_API=http://127.0.0.1:4850 npm run dev:demo
 *
 * Any key starting with "sk-ant-" is accepted. Options: --port 4850  --delay 25 (ms per chunk)
 */
import { startMockAnthropic } from './server';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mock = await startMockAnthropic({
  port: Number(option('port') ?? 4850),
  delayMs: option('delay') ? Number(option('delay')) : undefined,
});
console.log(`Mock Anthropic API running at ${mock.url}`);
console.log(`Start the app against it with: SLA_MEM_ANTHROPIC_API=${mock.url} npm run dev:demo`);
process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));
