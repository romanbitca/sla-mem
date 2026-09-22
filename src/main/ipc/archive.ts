/**
 * Read-only archive calls: directory, messages, threads, revisions, search, stats.
 */
import type { WorkspaceDTO } from '../../shared/types';
import {
  conversationBeyondFreeWindow,
  getConversation,
  getMessageRevisions,
  getMessages,
  getStats,
  getThread,
  getWorkspaceMeta,
  listConversations,
  listCustomEmoji,
  listUsers,
  search,
  type DB,
} from '../db';
import { notFound } from '../errors';
import type { ArchivePaths } from '../paths';
import { optionalInt, optionalTs, record, requiredTs, searchParams, slackId } from '../validate';
import type { Handlers } from './register';

export interface ArchiveDeps {
  db: DB;
  paths: ArchivePaths;
  /** Credentials are saved (the session may still have expired). */
  isConnected(): boolean;
}

type ArchiveHandlers = Pick<
  Handlers,
  | 'getWorkspace'
  | 'getStats'
  | 'getUsers'
  | 'getConversations'
  | 'getConversation'
  | 'getMessages'
  | 'getThread'
  | 'getRevisions'
  | 'search'
  | 'getEmoji'
>;

export function archiveHandlers(deps: ArchiveDeps): ArchiveHandlers {
  const { db } = deps;
  const requireConversation = (id: unknown) => {
    const conversation = getConversation(db, slackId(id, 'conversation'));
    if (!conversation) throw notFound('That conversation isn’t in the archive.');
    return conversation;
  };
  return {
    getWorkspace: (): WorkspaceDTO => ({ ...getWorkspaceMeta(db), connected: deps.isConnected() }),
    getStats: () => getStats(db, { dbPath: deps.paths.dbPath }),
    getUsers: () => listUsers(db),
    getConversations: () => listConversations(db),
    getConversation: (req) => {
      const conversation = requireConversation(record(req).id);
      return { ...conversation, beyondFreeWindow: conversationBeyondFreeWindow(db, conversation.id) };
    },
    getMessages: (req) => {
      const r = record(req);
      return getMessages(db, {
        conversationId: requireConversation(r.conversationId).id,
        before: optionalTs(r.before, 'before'),
        after: optionalTs(r.after, 'after'),
        around: optionalTs(r.around, 'around'),
        limit: optionalInt(r.limit, 'limit', { min: 1, max: 200 }),
      });
    },
    getThread: (req) => {
      const r = record(req);
      const ts = requiredTs(r.threadTs, 'thread');
      return getThread(db, requireConversation(r.conversationId).id, ts);
    },
    getRevisions: (req) => {
      const r = record(req);
      const ts = requiredTs(r.ts, 'message');
      return getMessageRevisions(db, requireConversation(r.conversationId).id, ts);
    },
    search: (req) => search(db, searchParams(req)),
    getEmoji: () => listCustomEmoji(db),
  };
}
