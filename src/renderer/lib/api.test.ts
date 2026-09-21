// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeBridge } from '../test/helpers';
import {
  api,
  ApiError,
  describeError,
  GENERIC_ERROR,
  isApiError,
  isBlocked,
  isConflict,
  isNotFound,
  isSignedOut,
  presentableMessage,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function rejectWith(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

describe('api over the preload bridge', () => {
  it('unwraps ok envelopes into plain values', async () => {
    const bridge = installFakeBridge((method) => (method === 'getStats' ? { messageCount: 3 } : null));
    await expect(api.getStats()).resolves.toEqual({ messageCount: 3 });
    expect(bridge.call).toHaveBeenCalledWith('getStats');
  });

  it('sends each method’s request object, and ignores abort signals', async () => {
    const bridge = installFakeBridge(() => ({}));
    const signal = new AbortController().signal;
    await api.getMessages('C1', { before: '1700000000.000100', limit: 100 }, signal);
    await api.getConversation('C1', signal);
    await api.getThread('C1', '1700000000.000100');
    await api.getRevisions('C1', '1700000000.000200');
    await api.search({ q: 'deploy', sort: 'newest' });
    await api.retryFile({ fileId: 'F1' });
    await api.openFile({ fileId: 'F2' });
    await api.revealFile({ fileId: 'F3' });
    await api.startLogin();
    await api.chooseLoginTeam({ teamId: 'T9H' });
    await api.connectWithCookie({ workspace: '9h', cookie: 'xoxd-abc' });
    await api.updatePreferences({ theme: 'dark' });
    await api.completeOnboarding({ launchAtLogin: true });
    await api.deleteAttachmentsOlderThan({ months: 6 });
    await api.openExternal({ url: 'https://example.com/' });
    expect(bridge.call.mock.calls).toEqual([
      ['getMessages', { conversationId: 'C1', before: '1700000000.000100', limit: 100 }],
      ['getConversation', { id: 'C1' }],
      ['getThread', { conversationId: 'C1', threadTs: '1700000000.000100' }],
      ['getRevisions', { conversationId: 'C1', ts: '1700000000.000200' }],
      ['search', { q: 'deploy', sort: 'newest' }],
      ['retryFile', { fileId: 'F1' }],
      ['openFile', { fileId: 'F2' }],
      ['revealFile', { fileId: 'F3' }],
      ['startLogin', {}],
      ['chooseLoginTeam', { teamId: 'T9H' }],
      ['connectWithCookie', { workspace: '9h', cookie: 'xoxd-abc' }],
      ['updatePreferences', { theme: 'dark' }],
      ['completeOnboarding', { launchAtLogin: true }],
      ['deleteAttachmentsOlderThan', { months: 6 }],
      ['openExternal', { url: 'https://example.com/' }],
    ]);
  });

  it('turns error envelopes into ApiErrors with the stable code', async () => {
    installFakeBridge((method) => {
      if (method === 'startSync') rejectWith('conflict', 'A sync is already running.');
      if (method === 'getConversation') rejectWith('not_found', 'That conversation isn’t in the archive.');
      if (method === 'getSettings') rejectWith('blocked', 'This isn’t available yet.');
      rejectWith('signed_out', 'Slack signed you out.');
    });
    const conflict = await api.startSync().catch((e: unknown) => e);
    expect(isApiError(conflict)).toBe(true);
    expect((conflict as ApiError).code).toBe('conflict');
    expect((conflict as ApiError).method).toBe('startSync');
    expect((conflict as ApiError).isConflict).toBe(true);
    expect(isConflict(conflict)).toBe(true);
    expect(describeError(conflict)).toBe('A sync is already running.');

    const missing = await api.getConversation('C404').catch((e: unknown) => e);
    expect(isNotFound(missing)).toBe(true);
    expect((missing as ApiError).isNotFound).toBe(true);

    expect(isBlocked(await api.getSettings().catch((e: unknown) => e))).toBe(true);
    expect(isSignedOut(await api.testConnection().catch((e: unknown) => e))).toBe(true);
  });

  it('treats unknown codes and malformed envelopes as unexpected errors', async () => {
    const bridge = installFakeBridge();
    bridge.call.mockResolvedValueOnce({ ok: false, error: { code: 'teapot', message: 'Short and stout' } } as never);
    const odd = (await api.getStats().catch((e: unknown) => e)) as ApiError;
    expect(odd.code).toBe('internal');

    bridge.call.mockResolvedValueOnce(undefined as never);
    const broken = (await api.getStats().catch((e: unknown) => e)) as ApiError;
    expect(broken.code).toBe('internal');
    expect(describeError(broken)).toBe(GENERIC_ERROR);
  });

  it('maps a rejected invoke (no handler in main) to a plain error', async () => {
    const bridge = installFakeBridge();
    bridge.call.mockRejectedValueOnce(
      new Error("Error invoking remote method 'archive:getStats': No handler registered"),
    );
    const error = (await api.getStats().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('internal');
    expect(describeError(error)).toBe(GENERIC_ERROR);
  });

  it('explains a missing bridge in plain words', async () => {
    const error = (await api.getStats().catch((e: unknown) => e)) as ApiError;
    expect(isApiError(error)).toBe(true);
    expect(describeError(error)).toMatch(/Quit it and open it again/);
  });
});

describe('describeError', () => {
  const err = (code: ApiError['code'], message: string) => new ApiError(code, message);

  it('shows main’s plain-language message', () => {
    expect(describeError(err('invalid', 'Pick a date first.'))).toBe('Pick a date first.');
  });

  it('never shows codes, statuses, stack traces or session words', () => {
    const technical = [
      'invalid_auth',
      'Request failed with status 500',
      'HTTP 429 Too Many Requests',
      'ENOSPC: no space left on device',
      'Error: boom\n    at foo (bar.js:1:2)',
      'Your token expired',
      'The xoxc-123-abc session is gone',
      'Bad cookie',
      "Error invoking remote method 'archive:x'",
      'net::ERR_INTERNET_DISCONNECTED',
      'SQLITE_BUSY: database is locked',
      "TypeError: Cannot read properties of undefined (reading 'x')",
      "Cannot read properties of undefined (reading 'x')",
      'SyntaxError: Unexpected token < in JSON at position 0',
      'Slack returned 429 Too Many Requests',
      'Request failed: 503 Service Unavailable',
      'Invalid_Auth',
      'fetch failed',
      'getaddrinfo ENOTFOUND slack.com',
      'socket hang up',
      'x.map is not a function',
    ];
    for (const message of technical) {
      const shown = describeError(err('internal', message));
      expect(shown, message).toBe(GENERIC_ERROR);
      expect(shown).not.toMatch(/token|cookie|xox|http|\d{3}|_/i);
    }
    expect(describeError(err('signed_out', 'invalid_auth'))).toBe('Slack signed you out. Reconnect to keep archiving.');
    expect(describeError(err('conflict', ''))).toMatch(/already in progress/);
  });

  it('lets only the advanced connect form say “cookie”', () => {
    const e = err('invalid', 'Slack didn’t accept that cookie. Copy it again.');
    expect(describeError(e)).not.toMatch(/cookie/i);
    expect(describeError(e, { allowCookie: true })).toBe('Slack didn’t accept that cookie. Copy it again.');
  });

  it('hides the message of anything that isn’t an ApiError (a bug on our side)', () => {
    expect(describeError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(GENERIC_ERROR);
    expect(describeError('nope')).toBe(GENERIC_ERROR);
  });

  it('keeps ordinary sentences, including ones with channel names and numbers', () => {
    const plain = [
      'Can’t reach Slack right now. We’ll try again automatically.',
      'Your disk is full, so new messages can’t be saved. Free up space and we’ll continue.',
      'Fetching #dev_ops — 1,240 messages so far',
      'Too large to download (over 25 MB). Raise the limit in Settings to get it.',
      'Removed from Slack',
      'Slack is busy, so this may take a little longer.',
    ];
    for (const message of plain) expect(describeError(err('internal', message)), message).toBe(message);
  });

  it('filters messages from main that are shown directly', () => {
    expect(presentableMessage('Waiting for you to sign in', 'fallback')).toBe('Waiting for you to sign in');
    expect(presentableMessage('token_revoked', 'fallback')).toBe('fallback');
    expect(presentableMessage(null, 'fallback')).toBe('fallback');
  });
});
