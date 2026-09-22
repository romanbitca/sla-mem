/**
 * The Ask AI chat, kept while the window is open and never saved: leaving the screen to open a
 * cited message and coming back finds the same chat. Main writes each answer as `ai` events
 * (events.ts feeds them to `applyAiEvent`); "New chat" forgets this one here and in main.
 */
import { useSyncExternalStore } from 'react';
import type { AiErrorKind, AiEventDTO, AiScopeDTO, AiStepDTO, AiUsageDTO, MessageDTO } from '../../shared/types';
import { api, describeError } from './api';

export type AskPart = { kind: 'text'; text: string } | { kind: 'step'; step: AiStepDTO };

/**
 *  - waiting: sent, nothing back yet
 *  - answering: steps or text are arriving
 *  - done / stopped / error: finished
 */
export type AskTurnStatus = 'waiting' | 'answering' | 'done' | 'stopped' | 'error';

export interface AskTurn {
  id: string;
  question: string;
  /** What the question was limited to, when anything. */
  scope: AiScopeDTO | null;
  /** Steps and answer text, in the order they arrived. */
  parts: AskPart[];
  status: AskTurnStatus;
  error: { kind: AiErrorKind | 'rejected'; message: string } | null;
  usage: AiUsageDTO | null;
}

export interface AskChat {
  id: string;
  turns: AskTurn[];
  /** The "In", "From" and "Date" choices under the question box, used for the next questions. */
  scope: AiScopeDTO;
  /** Every message the assistant was shown, by the number it cites them with. */
  sources: ReadonlyMap<number, MessageDTO>;
}

export const NO_SCOPE: AiScopeDTO = Object.freeze({
  conversationIds: [],
  userIds: [],
  after: null,
  before: null,
}) as AiScopeDTO;

export function hasScope(scope: AiScopeDTO | null | undefined): scope is AiScopeDTO {
  return !!scope && (scope.conversationIds.length > 0 || scope.userIds.length > 0 || !!scope.after || !!scope.before);
}

export function isAnswering(chat: AskChat): boolean {
  const last = chat.turns[chat.turns.length - 1];
  return last != null && (last.status === 'waiting' || last.status === 'answering');
}

// ─── the store ───────────────────────────────────────────────────────────────────────────────

let chat: AskChat = freshChat();
const listeners = new Set<() => void>();

function freshChat(): AskChat {
  return { id: newId(), turns: [], scope: NO_SCOPE, sources: new Map() };
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function set(next: AskChat): void {
  chat = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAskChat(): AskChat {
  return useSyncExternalStore(subscribe, () => chat);
}

export function currentAskChat(): AskChat {
  return chat;
}

function updateTurn(turnId: string, update: (turn: AskTurn) => AskTurn): void {
  const index = chat.turns.findIndex((t) => t.id === turnId);
  if (index < 0) return;
  const turns = chat.turns.slice();
  turns[index] = update(turns[index]);
  set({ ...chat, turns });
}

// ─── actions ─────────────────────────────────────────────────────────────────────────────────

/** Asks in the current chat, within its limits; false when a question is still being answered. */
export function askQuestion(question: string): boolean {
  const text = question.trim();
  if (!text || isAnswering(chat)) return false;
  const scope = hasScope(chat.scope) ? chat.scope : null;
  const turn: AskTurn = { id: newId(), question: text, scope, parts: [], status: 'waiting', error: null, usage: null };
  const chatId = chat.id;
  set({ ...chat, turns: [...chat.turns, turn] });
  api.askAi({ chatId, turnId: turn.id, question: text, ...(scope ? { scope } : {}) }).catch((error: unknown) => {
    if (chat.id !== chatId) return;
    updateTurn(turn.id, (t) => ({
      ...t,
      status: 'error',
      error: { kind: 'rejected', message: describeError(error) },
    }));
  });
  return true;
}

/** Changes what the next questions are limited to. */
export function setAskScope(scope: AiScopeDTO): void {
  set({ ...chat, scope });
}

export function stopAnswer(): void {
  if (isAnswering(chat)) void api.stopAi({ chatId: chat.id }).catch(() => {});
}

/** Forgets this chat (main too) and starts an empty one. */
export function startNewChat(): void {
  const old = chat;
  set(freshChat());
  if (old.turns.length) void api.endAiChat({ chatId: old.id }).catch(() => {});
}

/** Main's progress on an answer. Events for another chat (one already forgotten) are dropped. */
export function applyAiEvent(event: AiEventDTO): void {
  if (!event || event.chatId !== chat.id) return;
  switch (event.type) {
    case 'sources': {
      const sources = new Map(chat.sources);
      for (const s of event.sources) sources.set(s.ref, s.message);
      set({ ...chat, sources });
      return;
    }
    case 'text':
      updateTurn(event.turnId, (t) => {
        const last = t.parts[t.parts.length - 1];
        const parts =
          last?.kind === 'text'
            ? [...t.parts.slice(0, -1), { kind: 'text' as const, text: last.text + event.text }]
            : [...t.parts, { kind: 'text' as const, text: event.text }];
        return { ...t, parts, status: 'answering' };
      });
      return;
    case 'step':
      updateTurn(event.turnId, (t) => ({
        ...t,
        parts: [...t.parts, { kind: 'step', step: event.step }],
        status: 'answering',
      }));
      return;
    case 'done':
      updateTurn(event.turnId, (t) => ({ ...t, status: event.stopped ? 'stopped' : 'done', usage: event.usage }));
      return;
    case 'error':
      updateTurn(event.turnId, (t) => ({
        ...t,
        status: 'error',
        error: { kind: event.kind, message: event.message },
      }));
      return;
  }
}

/** A fresh window: an empty chat (tests). */
export function resetAskChat(): void {
  set(freshChat());
}
