/**
 * Lookup tables (users, conversations, custom emoji) shared by every message component,
 * plus the bridge that feeds them to the mrkdwn renderer so `<@U123>` and `<#C123>` resolve.
 *
 * Built once per load of the underlying queries; message rows read it through context rather
 * than props so memoized rows don't need extra props.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ConversationDTO, UserDTO } from '../../shared/types';
import { MrkdwnProvider, type MrkdwnContext } from './mrkdwn';
import { useConversations, useEmoji, useUsers, useWorkspace } from './queries';
import { conversationPath, personPath } from './links';

export interface Directory {
  users: ReadonlyMap<string, UserDTO>;
  conversations: ReadonlyMap<string, ConversationDTO>;
  /** Custom emoji: name → image URL, or `alias:<name>` for "draw that other emoji". */
  emoji: Readonly<Record<string, string>>;
  selfUserId: string | null;
  /** Slack workspace subdomain ("9h"), for links back into Slack; null before the first sync. */
  teamDomain: string | null;
}

const EMPTY: Directory = { users: new Map(), conversations: new Map(), emoji: {}, selfUserId: null, teamDomain: null };

const DirectoryContext = createContext<Directory>(EMPTY);

export function buildDirectory(
  users: readonly UserDTO[] | undefined,
  conversations: readonly ConversationDTO[] | undefined,
  emoji: Record<string, string> | undefined,
  selfUserId: string | null,
  teamDomain: string | null = null,
): Directory {
  return {
    users: new Map((users ?? []).map((u) => [u.id, u])),
    conversations: new Map((conversations ?? []).map((c) => [c.id, c])),
    emoji: emoji ?? {},
    selfUserId,
    teamDomain,
  };
}

/**
 * The self-DM ("You"): notes to yourself. Slack keeps showing them however old they are, so they
 * are never marked as gone from Slack (main leaves them out of its counts the same way).
 */
export function isNotesToSelf(conversation: ConversationDTO | undefined, selfUserId: string | null): boolean {
  return conversation?.type === 'im' && selfUserId != null && conversation.dmUserId === selfUserId;
}

export function buildMrkdwnContext(dir: Directory): MrkdwnContext {
  return {
    userLabel: (id) => dir.users.get(id)?.label,
    channelLabel: (id) => {
      const conv = dir.conversations.get(id);
      return conv ? (conv.rawName ?? conv.label) : undefined;
    },
    // Own-property lookup: an emoji named "constructor" must not hit Object.prototype.
    customEmojiUrl: (name) => (Object.hasOwn(dir.emoji, name) ? dir.emoji[name] : undefined),
    channelHref: (id) => conversationPath(id),
    // People only: an app's mention stays a chip, as its messages show no page to open.
    userHref: (id) => {
      const user = dir.users.get(id);
      return user && !user.isBot ? personPath(id) : undefined;
    },
  };
}

/** Provides the directory and mrkdwn context from live queries. */
export function DirectoryProvider({ children }: { children: ReactNode }) {
  const users = useUsers().data;
  const conversations = useConversations().data;
  const emoji = useEmoji().data;
  const workspace = useWorkspace().data;
  const selfUserId = workspace?.selfUserId ?? null;
  const teamDomain = workspace?.teamDomain ?? null;
  const directory = useMemo(
    () => buildDirectory(users, conversations, emoji, selfUserId, teamDomain),
    [users, conversations, emoji, selfUserId, teamDomain],
  );
  return <StaticDirectoryProvider directory={directory}>{children}</StaticDirectoryProvider>;
}

/** Provides a fixed directory (tests, or nested overrides such as search highlighting). */
export function StaticDirectoryProvider({
  directory,
  highlight,
  children,
}: {
  directory: Directory;
  highlight?: string[];
  children: ReactNode;
}) {
  const mrkdwn = useMemo(() => ({ ...buildMrkdwnContext(directory), highlight }), [directory, highlight]);
  return (
    <DirectoryContext.Provider value={directory}>
      <MrkdwnProvider value={mrkdwn}>{children}</MrkdwnProvider>
    </DirectoryContext.Provider>
  );
}

export function useDirectory(): Directory {
  return useContext(DirectoryContext);
}

export function useUser(id: string | null | undefined): UserDTO | undefined {
  const { users } = useDirectory();
  return id ? users.get(id) : undefined;
}

export function userLabel(dir: Directory, id: string): string {
  return dir.users.get(id)?.label ?? id;
}
