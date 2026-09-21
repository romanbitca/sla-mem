import type { ConversationDTO } from '../../../shared/types';
import { useUser } from '../../lib/directory';
import { HashIcon, LockIcon, UsersIcon } from '../icons';
import { Avatar } from '../message/Avatar';

/** '#' for public channels, a lock for private ones, the partner's avatar for DMs. */
export function ConversationIcon({ conversation, size = 16 }: { conversation: ConversationDTO; size?: number }) {
  const dmUser = useUser(conversation.type === 'im' ? conversation.dmUserId : null);
  switch (conversation.type) {
    case 'channel':
      return <HashIcon size={size} className="shrink-0" />;
    case 'private_channel':
      return <LockIcon size={size} className="shrink-0" />;
    case 'mpim':
      return <UsersIcon size={size} className="shrink-0" />;
    case 'im':
      return (
        <Avatar
          seed={conversation.dmUserId ?? conversation.id}
          label={dmUser?.label ?? conversation.label}
          src={dmUser?.avatarUrl}
          size={size + 2}
        />
      );
  }
}

export function conversationTitle(conversation: ConversationDTO): string {
  return conversation.type === 'channel' || conversation.type === 'private_channel'
    ? `#${conversation.label}`
    : conversation.label;
}
