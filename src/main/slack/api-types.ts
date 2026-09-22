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

/** The workspace icon in several sizes; `image_default` means Slack's generated one (no logo set). */
export interface TeamIcon {
  image_34?: string;
  image_44?: string;
  image_68?: string;
  image_88?: string;
  image_102?: string;
  image_132?: string;
  image_230?: string;
  image_default?: boolean;
}

export interface TeamInfoResponse {
  team?: { id?: string; name?: string; domain?: string; icon?: TeamIcon };
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
