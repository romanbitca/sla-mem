/**
 * A pretend Claude for trying Ask AI without an API key (development builds only): it answers the
 * key check, searches the archive for the question's longest word, and replies citing the first
 * results, streamed like the real API. It is a stand-in for the plumbing, not for the model.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MODELS_PAGE, sseEvents, type FakeReply } from './fake';

export interface MockAnthropic {
  /** e.g. http://127.0.0.1:4850 (the SDK adds /v1/…). */
  url: string;
  /** Requests answered so far. */
  requests: number;
  close(): Promise<void>;
}

const STOPWORDS = new Set(
  'about after again also asked been before could does find from have into last message messages month said some something that their them then there these they this those week what when where which while with would wrote your'.split(
    ' ',
  ),
);

interface ContentBlock {
  type: string;
  text?: string;
  content?: unknown;
}
interface Message {
  role: string;
  content: string | ContentBlock[];
}

/** One scripted turn: a search for a question, or an answer citing what the search showed. */
export function scriptedReply(messages: Message[]): FakeReply {
  const last = messages[messages.length - 1];
  const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
  if (!results.length) {
    // The question after the limits note Slamem may put in front of it.
    const question = (typeof last?.content === 'string' ? last.content : '').replace(/^\[[^\]]*\]\s*/, '');
    const words = (question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w));
    const word = words.sort((a, b) => b.length - a.length)[0] ?? 'the';
    // Prefix search finds more: "tests" → "test".
    const query = word.length > 5 ? word.replace(/(ing|ed|es|s)$/, '') : word;
    return {
      content: [
        { type: 'tool_use', id: `toolu_${Date.now().toString(36)}`, name: 'search_messages', input: { query } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1400, output_tokens: 40 },
    };
  }
  const text = results.map((r) => (typeof r.content === 'string' ? r.content : '')).join('\n');
  const hits = [...text.matchAll(/^\[(\d+)\] ([^\n]*)\n([^\n]*)/gm)].slice(0, 3);
  const answer = hits.length
    ? `Here is what I found in your archive:\n\n${hits
        .map((m) => `- ${m[2].split(' · ').slice(0, 3).join(', ')}: “${m[3].slice(0, 90)}” [${m[1]}]`)
        .join('\n')}\n\n_This answer comes from the development mock, not from Claude._`
    : 'I couldn’t find anything about that in your archive. Try other words.\n\n_This answer comes from the development mock, not from Claude._';
  return {
    content: [{ type: 'text', text: answer }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 600, cache_read: 1400, output_tokens: 120 },
  };
}

export async function startMockAnthropic(opts: { port?: number; delayMs?: number } = {}): Promise<MockAnthropic> {
  const delayMs = opts.delayMs ?? 25;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const key = String(req.headers['x-api-key'] ?? '');
      if (!key.startsWith('sk-ant-')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
        );
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(MODELS_PAGE));
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; messages: Message[] };
      const reply = { ...scriptedReply(body.messages), model: body.model };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const events = sseEvents(reply, 6);
      let i = 0;
      const next = () => {
        if (res.destroyed) return;
        if (i >= events.length) {
          res.end();
          return;
        }
        res.write(events[i++]);
        setTimeout(next, delayMs);
      };
      next();
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    get requests() {
      return requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
