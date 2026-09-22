/**
 * A stand-in for Anthropic's Messages API, good enough for the official SDK to talk to: models
 * listing (the key check) and streamed messages as server-sent events, with tool calls. Used as a
 * `fetch` by the Ask AI tests and behind the development mock server (server.ts).
 */

export type FakeBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface FakeReply {
  content: FakeBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read?: number; cache_write?: number };
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON body (POST). */
  body: Record<string, unknown> | null;
}

/** What the fake answers: a streamed reply, an API error, or a stream that stops mid-answer. */
export type FakeResponse =
  { reply: FakeReply; delayMs?: number } | { status: number; type: string; message: string } | { hangAfter: string };

/** The server-sent events of one streamed message, split into small deltas like the real API. */
export function sseEvents(reply: FakeReply, chunkChars = 12): string[] {
  const usage = reply.usage ?? {};
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const out = [
    event('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${Math.random().toString(36).slice(2, 10)}`,
        type: 'message',
        role: 'assistant',
        model: reply.model ?? 'claude-opus-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: usage.input_tokens ?? 100,
          output_tokens: 1,
          cache_creation_input_tokens: usage.cache_write ?? 0,
          cache_read_input_tokens: usage.cache_read ?? 0,
        },
      },
    }),
  ];
  reply.content.forEach((block, index) => {
    if (block.type === 'text') {
      out.push(
        event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
      );
      for (let i = 0; i < block.text.length; i += chunkChars) {
        out.push(
          event('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: block.text.slice(i, i + chunkChars) },
          }),
        );
      }
    } else if (block.type === 'thinking') {
      out.push(
        event('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }),
        event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: block.thinking },
        }),
        event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        }),
      );
    } else {
      out.push(
        event('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        }),
        event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        }),
      );
    }
    out.push(event('content_block_stop', { type: 'content_block_stop', index }));
  });
  out.push(
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: reply.stop_reason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens ?? 20 },
    }),
    event('message_stop', { type: 'message_stop' }),
  );
  return out;
}

const encoder = new TextEncoder();

function sseResponse(chunks: string[], delayMs: number, signal?: AbortSignal | null, hang = false): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (signal?.aborted) return;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(encoder.encode(chunk));
      }
      if (!hang) {
        controller.close();
        return;
      }
      // Never finishes by itself: only the reader stopping ends it.
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
      controller.error(new DOMException('The operation was aborted.', 'AbortError'));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fake' },
  });
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_fake' },
  });
}

/** The models list the key check reads. */
export const MODELS_PAGE = {
  data: [{ id: 'claude-opus-5', type: 'model', display_name: 'Claude Opus 5', created_at: '2026-06-01T00:00:00Z' }],
  has_more: false,
  first_id: 'claude-opus-5',
  last_id: 'claude-opus-5',
};

/**
 * A `fetch` that answers like Anthropic's API. `respond` decides each request; returning nothing
 * gives the models list for GET /v1/models (a valid key) and a server error for anything else.
 * Every request is recorded.
 */
export function fakeAnthropicFetch(
  respond: (req: FakeRequest) => FakeResponse | undefined | Promise<FakeResponse | undefined>,
) {
  const requests: FakeRequest[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === 'POST' ? await request.text() : '';
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const req: FakeRequest = {
      method: request.method,
      path: url.pathname,
      headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    };
    requests.push(req);
    const signal = init?.signal ?? request.signal;
    const answer = await respond(req);
    if (!answer) {
      if (req.method === 'GET' && req.path === '/v1/models') return jsonResponse(200, MODELS_PAGE);
      return jsonResponse(500, { type: 'error', error: { type: 'api_error', message: 'No scripted reply' } });
    }
    if ('status' in answer) {
      return jsonResponse(answer.status, { type: 'error', error: { type: answer.type, message: answer.message } });
    }
    if ('hangAfter' in answer) {
      const events = sseEvents({ content: [{ type: 'text', text: answer.hangAfter }], stop_reason: 'end_turn' });
      // message_start and the text, then nothing more.
      return sseResponse(events.slice(0, -3), 0, signal, true);
    }
    return sseResponse(sseEvents(answer.reply), answer.delayMs ?? 0, signal);
  };
  return { fetch: fetchImpl as typeof fetch, requests };
}
