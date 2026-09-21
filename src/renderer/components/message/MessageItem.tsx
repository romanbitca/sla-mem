import { memo } from 'react';
import clsx from 'clsx';
import type { MessageDTO } from '../../../shared/types';
import { Mrkdwn } from '../../lib/mrkdwn';
import { useDirectory } from '../../lib/directory';
import { hasVisibleBlocks } from '../../lib/blockkit';
import { isSystemMessage } from '../../lib/grouping';
import { slackPermalink } from '../../lib/links';
import { CornerDownRightIcon, ThreadIcon } from '../icons';
import { IconButton } from '../ui/IconButton';
import { Attachments } from './Attachments';
import { Avatar } from './Avatar';
import { BlockKit } from './BlockKit';
import { CopyLinkButton } from './CopyLinkButton';
import { DeletedBadge } from './DeletedBadge';
import { FileList } from './FileList';
import { MessageTime } from './MessageTime';
import { Reactions } from './Reactions';
import { RevisionsPopover } from './RevisionsPopover';
import { ThreadSummary } from './ThreadSummary';
import { resolveAuthor } from './author';

export interface MessageItemProps {
  message: MessageDTO;
  /** Same author within a few minutes: hide avatar and name. */
  continuation?: boolean;
  /** Flash the row (jump target). */
  highlighted?: boolean;
  /** Show the "N replies" row (channel view; the thread panel hides it). */
  showThreadSummary?: boolean;
  /** Opens a thread by its root ts. Should be referentially stable: rows are memoized. */
  onOpenThread?: (threadTs: string) => void;
  className?: string;
}

/**
 * Slack derives `text` from attachment fallbacks for attachment-only bot posts; showing both
 * would print the same content twice.
 */
function textDuplicatesAttachment(message: MessageDTO): boolean {
  const text = message.text.trim();
  return text !== '' && message.attachments.some((a) => a.fallback?.trim() === text);
}

/**
 * One message row. Memoized and free of per-row state for hover (CSS only), so scrolling and
 * hovering a 600-row list never re-renders siblings.
 */
export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  if (isSystemMessage(props.message)) return <SystemMessageRow {...props} />;
  return <StandardMessageRow {...props} />;
});

function StandardMessageRow({
  message,
  continuation = false,
  highlighted = false,
  showThreadSummary = true,
  onOpenThread,
  className,
}: MessageItemProps) {
  const dir = useDirectory();
  const author = resolveAuthor(message, dir);
  // App/bot layouts: the blocks are the message and `text` is only its notification fallback
  // (unless the blocks draw nothing the archive can show, e.g. only form inputs).
  const hasBlocks = hasVisibleBlocks(message.blocks);
  const showText = !hasBlocks && message.text.trim() !== '' && !textDuplicatesAttachment(message);
  const permalink = slackPermalink(dir.teamDomain, message);
  const isBroadcast = message.subtype === 'thread_broadcast';
  const canOpenThread = Boolean(onOpenThread);
  const hasThread = message.replyCount > 0 && !message.isReply;
  const edited = message.editedTs != null || message.revisionCount > 0;
  const markers = (edited || message.isDeleted) && (
    <>
      {edited && (
        <RevisionsPopover
          conversationId={message.conversationId}
          ts={message.ts}
          editedTs={message.editedTs}
          revisionCount={message.revisionCount}
        />
      )}
      {message.isDeleted && <DeletedBadge />}
    </>
  );

  return (
    <article
      data-msg-ts={message.ts}
      data-highlighted={highlighted || undefined}
      aria-label={`${author.label}${message.isDeleted ? ' (deleted in Slack)' : ''}`}
      className={clsx(
        'group/msg relative flex gap-3 px-5 transition-colors duration-100 hover:bg-hover/55 focus-within:bg-hover/55',
        continuation ? 'py-0.5' : 'pt-2 pb-1',
        highlighted && 'animate-flash',
        message.isDeleted && 'opacity-90',
        className,
      )}
    >
      <div className="w-9 shrink-0">
        {continuation ? (
          <MessageTime
            message={message}
            className="mt-[3px] block text-right text-[10.5px] opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100"
          />
        ) : (
          <Avatar seed={author.seed} label={author.label} src={author.avatarUrl} size={36} className="mt-0.5" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!continuation && (
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 leading-tight">
            <span className={clsx('text-[15px] font-semibold', author.deleted ? 'text-ink-muted' : 'text-ink')}>
              {author.label}
            </span>
            {author.isBot && (
              <span className="rounded bg-inset px-1 py-px text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
                App
              </span>
            )}
            {author.deleted && <span className="text-xs text-ink-faint">(deactivated)</span>}
            <MessageTime message={message} />
            {markers}
          </header>
        )}

        {isBroadcast && message.threadTs && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-faint">
            <CornerDownRightIcon size={12} />
            Replied to a thread
            {canOpenThread && (
              <>
                {' · '}
                <button
                  type="button"
                  className="focus-ring rounded font-medium text-accent-text hover:underline"
                  onClick={() => onOpenThread?.(message.threadTs!)}
                >
                  View thread
                </button>
              </>
            )}
          </p>
        )}

        {showText && (
          <div className={clsx('msg-text text-ink', !continuation && 'mt-0.5')}>
            <Mrkdwn text={message.text} />
          </div>
        )}
        {hasBlocks && <BlockKit blocks={message.blocks} className={clsx(!continuation && 'mt-0.5')} />}
        {continuation && markers && <div className="mt-0.5 flex items-center gap-2">{markers}</div>}

        <FileList files={message.files} />
        <Attachments attachments={message.attachments} />
        <Reactions reactions={message.reactions} />

        {showThreadSummary && hasThread && onOpenThread && <ThreadSummary message={message} onOpen={onOpenThread} />}
      </div>

      {((hasThread && onOpenThread) || permalink) && (
        <div
          className={clsx(
            'absolute -top-3.5 right-4 z-10 flex items-center gap-0.5 rounded-lg border border-line bg-raised p-0.5 shadow-pop',
            'pointer-events-none opacity-0 transition-opacity duration-100',
            'group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100',
          )}
        >
          {hasThread && onOpenThread && (
            <IconButton
              size="sm"
              label="View thread"
              icon={<ThreadIcon size={15} />}
              onClick={() => onOpenThread(message.ts)}
            />
          )}
          {permalink && <CopyLinkButton url={permalink} />}
        </div>
      )}
    </article>
  );
}

/** What a channel event says when Slack stored no text for it. */
const SYSTEM_EVENT: Record<string, string> = {
  channel_join: 'joined the channel',
  group_join: 'joined the channel',
  channel_leave: 'left the channel',
  group_leave: 'left the channel',
  channel_topic: 'changed the topic',
  group_topic: 'changed the topic',
  channel_purpose: 'changed the description',
  group_purpose: 'changed the description',
  channel_name: 'renamed the channel',
  group_name: 'renamed the channel',
  channel_archive: 'archived the channel',
  group_archive: 'archived the channel',
  channel_unarchive: 'unarchived the channel',
  group_unarchive: 'unarchived the channel',
  pinned_item: 'pinned a message',
  unpinned_item: 'unpinned a message',
  bot_add: 'added an app',
  bot_remove: 'removed an app',
};

/** "Alice joined the channel", for an event without stored text (never the raw subtype). */
export function systemEventFallback(subtype: string | null, authorLabel: string): string {
  const what = subtype && Object.hasOwn(SYSTEM_EVENT, subtype) ? SYSTEM_EVENT[subtype] : 'updated the channel';
  return `${authorLabel} ${what}`;
}

function SystemMessageRow({ message, highlighted = false, className }: MessageItemProps) {
  const dir = useDirectory();
  const author = resolveAuthor(message, dir);
  return (
    <article
      data-msg-ts={message.ts}
      data-highlighted={highlighted || undefined}
      className={clsx(
        'group/msg flex items-center gap-3 px-5 py-1 text-[13px] text-ink-muted',
        highlighted && 'animate-flash',
        className,
      )}
    >
      <div className="flex w-9 shrink-0 justify-end">
        <Avatar seed={author.seed} label={author.label} src={author.avatarUrl} size={20} />
      </div>
      <div className="min-w-0 flex-1">
        {message.text.trim() ? (
          <Mrkdwn text={message.text} inline />
        ) : (
          <span>{systemEventFallback(message.subtype, author.label)}</span>
        )}{' '}
        <MessageTime message={message} className="ml-1 opacity-0 group-hover/msg:opacity-100" />
      </div>
    </article>
  );
}
