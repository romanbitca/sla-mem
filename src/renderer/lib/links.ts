import type { MessageDTO } from '../../shared/types';
import { workspaceHost } from './workspaceName';

/** In-app path that opens a message: replies open their thread and highlight the reply. */
export function messagePath(message: Pick<MessageDTO, 'conversationId' | 'ts' | 'threadTs' | 'isReply'>): string {
  const base = `/c/${encodeURIComponent(message.conversationId)}`;
  if (message.isReply && message.threadTs) {
    return `${base}?thread=${message.threadTs}&ts=${message.ts}`;
  }
  return `${base}?ts=${message.ts}`;
}

export function conversationPath(conversationId: string): string {
  return `/c/${encodeURIComponent(conversationId)}`;
}

export function searchPath(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}

/** Slack's `p` + ts without the dot (six fractional digits): "1712345678.1234" → "p1712345678123400". */
function permalinkTs(ts: string): string | null {
  const m = /^(\d{9,11})\.(\d{1,6})$/.exec(ts);
  return m ? `p${m[1]}${m[2].padEnd(6, '0')}` : null;
}

/**
 * The message's address in Slack (what Slack's own "Copy link" gives), e.g.
 * `https://9h.slack.com/archives/C123/p1712345678123456`; replies add `thread_ts` and `cid`.
 * The archive lives only on this computer, so this is the only link worth sharing. Null when
 * the workspace address isn't known yet (nothing synced from Slack).
 */
export function slackPermalink(
  teamDomain: string | null | undefined,
  message: Pick<MessageDTO, 'conversationId' | 'ts' | 'threadTs' | 'isReply'>,
): string | null {
  const host = workspaceHost(teamDomain);
  const p = permalinkTs(message.ts);
  if (!host || !p || !/^[A-Za-z0-9]+$/.test(message.conversationId)) return null;
  const url = `https://${host}/archives/${message.conversationId}/${p}`;
  if (message.isReply && message.threadTs) {
    return `${url}?thread_ts=${encodeURIComponent(message.threadTs)}&cid=${message.conversationId}`;
  }
  return url;
}
