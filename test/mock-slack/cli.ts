/**
 * Starts the mock Slack (see server.ts) for manual end-to-end runs of the real app:
 *
 *   npm run mock:slack                      # prints the URLs, keeps running
 *   npm run dev:mock                        # in another terminal: the app, signed in against it
 *
 * Options: --port 4849  --messages 3000  --seed 7  --paid (no 90-day window)
 */
import { startMockSlack } from './server';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mock = await startMockSlack({
  port: Number(option('port') ?? 4849),
  messages: option('messages') ? Number(option('messages')) : undefined,
  seed: option('seed') ? Number(option('seed')) : undefined,
  historyWindowDays: process.argv.includes('--paid') ? null : 90,
});
console.log(`Mock Slack running at ${mock.url}`);
console.log(`  Web API:  ${mock.apiBaseUrl}`);
console.log(`  Sign in:  ${mock.url}/signin`);
console.log('Start the app against it with: npm run dev:mock');
process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));
