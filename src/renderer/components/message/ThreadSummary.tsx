import { memo } from 'react';
import type { MessageDTO } from '../../../shared/types';
import { useDirectory } from '../../lib/directory';
import { formatTsShort, pluralize } from '../../lib/format';
import { isValidTs } from '../../lib/ts';
import { ChevronRightIcon } from '../icons';
import { Avatar } from './Avatar';

const MAX_AVATARS = 4;

/** "N replies · last reply …" row under a thread parent; opens the thread panel. */
export const ThreadSummary = memo(function ThreadSummary({
  message,
  onOpen,
}: {
  message: MessageDTO;
  onOpen: (threadTs: string) => void;
}) {
  const dir = useDirectory();
  const users = message.replyUsers.slice(0, MAX_AVATARS);
  return (
    <button
      type="button"
      onClick={() => onOpen(message.ts)}
      className="focus-ring group/thread mt-1.5 -ml-1.5 flex max-w-full items-center gap-2 rounded-lg border border-transparent py-1 pr-2 pl-1.5 text-left transition-colors hover:border-line hover:bg-raised"
      aria-label={`View thread, ${pluralize(message.replyCount, 'reply', 'replies')}`}
    >
      {users.length > 0 && (
        <span className="flex shrink-0 -space-x-1">
          {users.map((id) => {
            const user = dir.users.get(id);
            return (
              <Avatar
                key={id}
                seed={id}
                label={user?.label ?? id}
                src={user?.avatarUrl}
                size={20}
                className="ring-2 ring-canvas"
              />
            );
          })}
        </span>
      )}
      <span className="text-[13px] font-semibold text-accent-text group-hover/thread:underline">
        {pluralize(message.replyCount, 'reply', 'replies')}
      </span>
      {isValidTs(message.latestReply) && (
        <span className="truncate text-xs text-ink-faint">Last reply {formatTsShort(message.latestReply)}</span>
      )}
      <ChevronRightIcon
        size={14}
        className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover/thread:opacity-100"
      />
    </button>
  );
});
