import type { MessageDTO } from '../../../shared/types';
import type { Directory } from '../../lib/directory';

export interface Author {
  label: string;
  avatarUrl: string | null;
  /** Stable seed for fallback avatar colors. */
  seed: string;
  isBot: boolean;
  deleted: boolean;
}

/**
 * Who a message appears to be from. Integrations (`bot_message`) post under their own
 * `username`/icon even when a user id is attached, so those win for bot messages.
 */
export function resolveAuthor(message: MessageDTO, dir: Directory): Author {
  const user = message.userId ? dir.users.get(message.userId) : undefined;
  const botName = message.username?.trim();
  if (botName && (message.subtype === 'bot_message' || !user)) {
    return {
      label: botName,
      avatarUrl: message.botIconUrl ?? null,
      seed: message.botId ?? botName,
      isBot: true,
      deleted: false,
    };
  }
  if (user) {
    return {
      label: user.label,
      avatarUrl: user.avatarUrl ?? message.botIconUrl ?? null,
      seed: user.id,
      isBot: user.isBot || message.botId != null,
      deleted: user.deleted,
    };
  }
  if (message.userId) {
    return { label: message.userId, avatarUrl: null, seed: message.userId, isBot: false, deleted: false };
  }
  return {
    label: message.botId ? 'Bot' : 'Unknown',
    avatarUrl: message.botIconUrl ?? null,
    seed: message.botId ?? 'unknown',
    isBot: message.botId != null,
    deleted: false,
  };
}
