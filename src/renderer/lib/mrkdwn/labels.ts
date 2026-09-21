/**
 * Display text for references, shared by the React renderer and the plain-text converter so
 * tooltips and rendered messages always agree.
 */
import type { MrkdwnContext } from './context';
import { slackDateTitle } from './date';
import type { ChannelMentionNode, DateNode, UserMentionNode, UsergroupMentionNode } from './types';

type Labels = Partial<Pick<MrkdwnContext, 'userLabel' | 'channelLabel'>>;

/** Current name from the archive wins over the (possibly stale) inline label. */
export function userMentionLabel(node: UserMentionNode, ctx: Labels): string {
  return ctx.userLabel?.(node.id) || node.label || node.id;
}

export function channelMentionLabel(node: ChannelMentionNode, ctx: Labels): string {
  return ctx.channelLabel?.(node.id) || node.label || node.id;
}

export function usergroupLabel(node: UsergroupMentionNode): string {
  const label = node.label || node.id;
  return label.startsWith('@') ? label : `@${label}`;
}

export const BROADCAST_LABEL = { here: '@here', channel: '@channel', everyone: '@everyone' } as const;

export function dateLabel(node: DateNode): string {
  return node.fallback || slackDateTitle(node.timestamp, node.format);
}
