// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AiEventDTO, AskAiRequest } from '../../../shared/types';
import { api } from '../../lib/api';
import { applyAiEvent, currentAskChat, resetAskChat } from '../../lib/askChat';
import AskPage from '../../pages/AskPage';
import {
  makeConversation,
  makeMessage,
  makeSettings,
  makeWorkspace,
  renderWithProviders,
  testDirectory,
  tsAt,
} from '../../test/helpers';

const directory = testDirectory([makeConversation('C1', 'general')]);
const SOURCE = makeMessage({ ts: tsAt(3), conversationId: 'C1', userId: 'U2', text: 'Can you run the e2e tests?' });

let askAi: MockInstance<typeof api.askAi>;

function renderAsk(opts: { keySaved?: boolean } = {}) {
  vi.spyOn(api, 'getSettings').mockResolvedValue(
    makeSettings({ ai: opts.keySaved === false ? { saved: false, hint: null } : { saved: true, hint: 'x7Qa' } }),
  );
  return renderWithProviders(<AskPage />, { route: '/ask', directory });
}

type Pushed = AiEventDTO extends infer E ? (E extends unknown ? Omit<E, 'chatId' | 'turnId'> : never) : never;

/** What main would push for the question just asked. */
function push(event: Pushed) {
  const request = askAi.mock.calls[askAi.mock.calls.length - 1][0] as AskAiRequest;
  act(() => applyAiEvent({ chatId: request.chatId, turnId: request.turnId, ...event } as AiEventDTO));
}

async function ask(question: string) {
  const box = await screen.findByRole('textbox', { name: 'Question' });
  fireEvent.change(box, { target: { value: question } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect(askAi).toHaveBeenCalled());
}

beforeEach(() => {
  resetAskChat();
  askAi = vi.spyOn(api, 'askAi').mockResolvedValue({ ok: true });
  vi.spyOn(api, 'stopAi').mockResolvedValue({ ok: true });
  vi.spyOn(api, 'endAiChat').mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Ask AI', () => {
  it('asks for an API key first, pointing at Settings', async () => {
    renderAsk({ keySaved: false });
    expect(await screen.findByText('Add your Anthropic API key to ask')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Settings' }).getAttribute('href')).toBe('/settings#ask-ai');
    expect(screen.queryByRole('textbox', { name: 'Question' })).toBeNull();
  });

  it('offers examples, then sends a question with Enter', async () => {
    renderAsk();
    fireEvent.click(await screen.findByRole('button', { name: /asked me to run the tests/ }));
    const box = screen.getByRole('textbox', { name: 'Question' }) as HTMLTextAreaElement;
    expect(box.value).toBe('Find the message where someone asked me to run the tests');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(askAi).toHaveBeenCalledTimes(1));
    expect(askAi.mock.calls[0][0]).toMatchObject({
      chatId: currentAskChat().id,
      question: 'Find the message where someone asked me to run the tests',
    });
    expect(box.value).toBe('');
    expect(screen.getByText('Thinking…')).toBeTruthy();
    // Shift+Enter is a new line, not a question.
    fireEvent.change(box, { target: { value: 'two' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(askAi).toHaveBeenCalledTimes(1);
  });

  it('shows the steps, the streamed answer with its citations, the sources and the cost', async () => {
    const { location } = renderAsk();
    await ask('Who asked me about tests?');
    push({ type: 'sources', sources: [{ ref: 1, message: SOURCE }] });
    push({ type: 'step', step: { kind: 'search', label: 'Searched “test”', detail: '1 result' } });
    expect(screen.getByText('Searched “test”')).toBeTruthy();
    expect(screen.getByText('Reading…')).toBeTruthy();
    push({ type: 'text', text: 'Bob asked you to run the **e2e** tests ' });
    push({ type: 'text', text: '[1].' });
    push({
      type: 'done',
      stopped: false,
      usage: { model: 'claude-opus-5', inputTokens: 1200, outputTokens: 100, costUsd: 0.0085 },
    });

    expect(screen.getByText('e2e').tagName).toBe('STRONG');
    const cite = screen.getByRole('link', { name: /^Source 1: Bob in #general/ });
    const sources = screen.getByRole('region', { name: 'Sources' });
    expect(within(sources).getByText('Can you run the e2e tests?')).toBeTruthy();
    expect(screen.getByText('Claude Opus 5 · 1.3k tokens · under $0.01')).toBeTruthy();
    expect(screen.queryByText('Reading…')).toBeNull();

    // A citation opens the message; the conversation knows the way back to this chat.
    fireEvent.click(cite);
    await waitFor(() => expect(location.current?.pathname).toBe('/c/C1'));
    expect(location.current?.search).toBe(`?ts=${SOURCE.ts}`);
    expect(location.current?.state).toMatchObject({ fromSearch: '/ask' });
  });

  it('stops an answer, and says so', async () => {
    renderAsk();
    await ask('Anything?');
    push({ type: 'text', text: 'Let me' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.stopAi).toHaveBeenCalledWith({ chatId: currentAskChat().id });
    push({ type: 'done', stopped: true, usage: null });
    expect(screen.getByText('Stopped.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
  });

  it('explains failures, with the way to fix them', async () => {
    renderAsk();
    await ask('Anything?');
    push({ type: 'error', kind: 'bad_key', message: 'Anthropic didn’t accept your API key.' });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Anthropic didn’t accept your API key.')).toBeTruthy();
    expect(within(alert).getByRole('link', { name: 'Open Settings' })).toBeTruthy();

    await ask('Again?');
    push({ type: 'error', kind: 'overloaded', message: 'Claude is very busy right now.' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' }).at(-1)!);
    await waitFor(() => expect(askAi).toHaveBeenCalledTimes(3));
    expect(askAi.mock.calls[2][0]).toMatchObject({ question: 'Again?' });
  });

  it('shows a refused call (no key, busy) on the question itself', async () => {
    askAi.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'ApiError' }));
    renderAsk();
    await ask('Anything?');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('limits questions to chosen conversations and dates, from buttons under the box', async () => {
    vi.spyOn(api, 'getConversations').mockResolvedValue([makeConversation('C1', 'general')]);
    vi.spyOn(api, 'getUsers').mockResolvedValue([]);
    vi.spyOn(api, 'getWorkspace').mockResolvedValue(makeWorkspace());
    renderAsk();
    // No note under the box any more: just the limits.
    expect(screen.queryByText(/go to Anthropic/)).toBeNull();
    const limits = await screen.findByRole('group', { name: 'Limit the question' });
    fireEvent.click(within(limits).getByRole('button', { name: /^In/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: '#general' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(within(limits).getByText('#general')).toBeTruthy();
    fireEvent.click(within(limits).getByRole('button', { name: /^Date/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Last 7 days' }));

    await ask('What happened?');
    const request = askAi.mock.calls[0][0] as AskAiRequest;
    expect(request.scope).toMatchObject({ conversationIds: ['C1'], userIds: [], before: null });
    expect(request.scope?.after).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByText(/^In #general · Since /)).toBeTruthy();

    // Clearing the limits: the next question goes to the whole archive.
    fireEvent.click(within(limits).getByRole('button', { name: 'Clear' }));
    push({ type: 'done', stopped: false, usage: null });
    await ask('And everywhere?');
    expect((askAi.mock.calls[1][0] as AskAiRequest).scope).toBeUndefined();
  });

  it('starts a new chat, forgetting the old one', async () => {
    renderAsk();
    await ask('First question');
    const first = currentAskChat().id;
    push({ type: 'text', text: 'An answer.' });
    push({ type: 'done', stopped: false, usage: null });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(api.endAiChat).toHaveBeenCalledWith({ chatId: first });
    expect(screen.queryByText('First question')).toBeNull();
    expect(currentAskChat().id).not.toBe(first);
    expect(screen.getByRole('button', { name: 'New chat' }).hasAttribute('disabled')).toBe(true);
  });

  it('ignores events for a chat that was already forgotten', async () => {
    renderAsk();
    await ask('First question');
    const old = askAi.mock.calls[0][0] as AskAiRequest;
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    act(() => applyAiEvent({ chatId: old.chatId, turnId: old.turnId, type: 'text', text: 'late text' }));
    expect(screen.queryByText('late text')).toBeNull();
  });
});
