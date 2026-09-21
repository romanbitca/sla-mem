/**
 * Loose shapes of raw Slack objects as returned by the Web API and as found in Slack export
 * JSON files (standard admin exports and slackdump exports use the same shapes).
 * Only the fields the archive reads are typed; everything else is preserved via the index
 * signature and stored verbatim in the `raw` JSON columns.
 */

export interface SlackProfile {
  real_name?: string;
  display_name?: string;
  image_48?: string;
  image_72?: string;
  image_192?: string;
  [k: string]: unknown;
}

export interface SlackUser {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: SlackProfile;
  [k: string]: unknown;
}

export interface SlackConversation {
  id: string;
  name?: string;
  /** API: flags. Export files don't carry these; importers set them from which file listed the conversation. */
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  /** IM: the other user. */
  user?: string;
  /** Export files (dms.json, mpims.json, groups.json) list members. */
  members?: string[];
  created?: number;
  topic?: { value?: string; creator?: string; last_set?: number };
  purpose?: { value?: string; creator?: string; last_set?: number };
  [k: string]: unknown;
}

export interface SlackReaction {
  name: string;
  count?: number;
  users?: string[];
}

export interface SlackFile {
  id: string;
  /** 'hidden_by_limit' (Free plan >90d), 'tombstone' (deleted), 'external', 'hosted', 'snippet', 'post'… */
  mode?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  size?: number;
  user?: string;
  created?: number;
  timestamp?: number;
  is_external?: boolean;
  external_type?: string;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  permalink_public?: string;
  thumb_64?: string;
  thumb_360?: string;
  thumb_480?: string;
  thumb_720?: string;
  thumb_960?: string;
  thumb_1024?: string;
  thumb_pdf?: string;
  thumb_video?: string;
  original_w?: number;
  original_h?: number;
  [k: string]: unknown;
}

export interface SlackAttachment {
  id?: number;
  color?: string;
  fallback?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  text?: string;
  image_url?: string;
  thumb_url?: string;
  service_name?: string;
  service_icon?: string;
  footer?: string;
  fields?: { title?: string; value?: string; short?: boolean }[];
  from_url?: string;
  original_url?: string;
  is_msg_unfurl?: boolean;
  is_share?: boolean;
  [k: string]: unknown;
}

/** Block Kit blocks are kept loose; normalize.ts extracts text from them. */
export type SlackBlock = { type: string; [k: string]: unknown };

export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  blocks?: SlackBlock[];
  attachments?: SlackAttachment[];
  files?: SlackFile[];
  reactions?: SlackReaction[];
  reply_count?: number;
  reply_users?: string[];
  reply_users_count?: number;
  latest_reply?: string;
  edited?: { user?: string; ts?: string };
  icons?: { image_36?: string; image_48?: string; image_72?: string; emoji?: string; [k: string]: unknown };
  bot_profile?: { name?: string; icons?: Record<string, string>; [k: string]: unknown };
  /** Exports embed the author's profile on each message. */
  user_profile?: { real_name?: string; display_name?: string; name?: string; image_72?: string; [k: string]: unknown };
  /** Present on API messages when the file/message is limited by the Free plan. */
  is_locked?: boolean;
  [k: string]: unknown;
}

/** Common envelope of every Slack Web API response. */
export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  needed?: string;
  provided?: string;
  warning?: string;
  response_metadata?: { next_cursor?: string; messages?: string[]; warnings?: string[] };
  [k: string]: unknown;
}
