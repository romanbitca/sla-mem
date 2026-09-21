/**
 * Response shapes of the Web API methods the sync uses (only the fields we read). The raw object
 * shapes themselves live in the read-only contract file `types.ts`.
 */
import type { SlackConversation, SlackMessage, SlackUser } from './types';

/** Parameter values accepted by `SlackClient.call`; `undefined` entries are dropped. */
export type SlackParams = Record<string, string | number | boolean | undefined>;

export interface AuthTestResponse {
  url?: string;
  team?: string;
  user?: string;
  team_id?: string;
  user_id?: string;
}

export interface TeamInfoResponse {
  team?: { id?: string; name?: string; domain?: string };
}

export interface UsersListResponse {
  members?: SlackUser[];
}

export interface UsersConversationsResponse {
  channels?: SlackConversation[];
}

export interface ConversationsMembersResponse {
  members?: string[];
}

export interface HistoryResponse {
  messages?: SlackMessage[];
  has_more?: boolean;
}

export interface RepliesResponse {
  messages?: SlackMessage[];
  has_more?: boolean;
}

export interface EmojiListResponse {
  emoji?: Record<string, string>;
}
