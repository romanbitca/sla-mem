import { memo, type KeyboardEvent, type ReactNode } from 'react';
import { Link, type To } from 'react-router';
import clsx from 'clsx';
import type { MessageDTO, SearchHit } from '../../../shared/types';
import { isNotesToSelf, useDirectory } from '../../lib/directory';
import { formatFullDateTime, formatShortDate, isBeyondFreeWindow, isoDateTime, pluralize } from '../../lib/format';
import { conversationPath, messagePath } from '../../lib/links';
import { mrkdwnToPlainText, useMrkdwnContext } from '../../lib/mrkdwn';
import { messageKey } from '../../lib/searchNav';
import { tsToDate } from '../../lib/ts';
import { ConversationIcon, conversationTitle } from '../conversation/ConversationIcon';
import { ArchiveIcon, ArrowUpIcon, CornerDownRightIcon, FileIcon, ThreadIcon } from '../icons';
import { resolveAuthor } from '../message/author';
import { Avatar } from '../message/Avatar';
import { Button } from '../ui/Button';
import { groupHitsByConversation, hitKey } from './hits';
import type { SearchView } from './searchUrl';
import { Snippet, snippetText } from './snippet';

export interface SearchResultsProps {
  hits: readonly SearchHit[];
  view: SearchView;
  /** Conversation ids currently filtered on (hides the "only this conversation" action). */
  filteredConversations: readonly string[];
  onOnlyConversation: (conversationId: string) => void;
  /** ArrowUp from the first hit returns here (the search box). */
  onExitUp?: () => void;
  /** Where a result opens (the page decides: the preview, or the conversation). */
  linkFor?: (message: MessageDTO) => ResultLink;
  /** Where a conversation heading opens (grouped layout). */
  conversationLinkFor?: (conversationId: string) => ResultLink;
  /** The result open in the preview (`messageKey`). */
  selectedKey?: string | null;
}

/** A router link target, with its history state. */
export interface ResultLink {
  to: To;
  state?: unknown;
  replace?: boolean;
}

const defaultLinkFor = (message: MessageDTO): ResultLink => ({ to: messagePath(message) });
const defaultConversationLinkFor = (conversationId: string): ResultLink => ({ to: conversationPath(conversationId) });

/** Hits are links; ↑/↓ moves between them like a list. */
function onResultsKeyDown(e: KeyboardEvent<HTMLElement>, onExitUp?: () => void) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const target = e.target as HTMLElement;
  if (!target.matches('[data-search-hit]')) return;
  const links = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-search-hit]'));
  const index = links.indexOf(target);
  e.preventDefault();
  const next = index + (e.key === 'ArrowDown' ? 1 : -1);
  if (next < 0) onExitUp?.();
  else links[Math.min(next, links.length - 1)]?.focus();
}

export function SearchResults({
  hits,
  view,
  filteredConversations,
  onOnlyConversation,
  onExitUp,
  linkFor = defaultLinkFor,
  conversationLinkFor = defaultConversationLinkFor,
  selectedKey = null,
}: SearchResultsProps) {
  return (
    <div onKeyDown={(e) => onResultsKeyDown(e, onExitUp)}>
      {view === 'grouped' ? (
        <GroupedResults
          hits={hits}
          filteredConversations={filteredConversations}
          onOnlyConversation={onOnlyConversation}
          linkFor={linkFor}
          conversationLinkFor={conversationLinkFor}
          selectedKey={selectedKey}
        />
      ) : (
        <ol aria-label="Search results" className="flex flex-col gap-0.5">
          {hits.map((hit) => (
            <li key={hitKey(hit)}>
              <HitRow hit={hit} showConversation linkFor={linkFor} selected={selectedKey === messageKey(hit.message)} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function GroupedResults({
  hits,
  filteredConversations,
  onOnlyConversation,
  linkFor,
  conversationLinkFor,
  selectedKey,
}: Omit<SearchResultsProps, 'view' | 'onExitUp' | 'linkFor' | 'conversationLinkFor'> & {
  linkFor: (message: MessageDTO) => ResultLink;
  conversationLinkFor: (conversationId: string) => ResultLink;
}) {
  const dir = useDirectory();
  const groups = groupHitsByConversation(hits);
  const onlyOne = filteredConversations.length === 1;
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => {
        const conv = dir.conversations.get(group.conversationId);
        const title = conv ? conversationTitle(conv) : group.conversationId;
        const headingId = `search-group-${group.conversationId}`;
        const heading = conversationLinkFor(group.conversationId);
        return (
          <section key={group.conversationId} aria-labelledby={headingId}>
            <header className="flex items-center gap-2 border-b border-line px-3 pb-2">
              <span className="flex size-6 items-center justify-center rounded-md bg-inset text-ink-muted">
                {conv && <ConversationIcon conversation={conv} size={14} />}
              </span>
              <h2 id={headingId} className="min-w-0 truncate text-sm font-semibold text-ink">
                <Link
                  to={heading.to}
                  state={heading.state}
                  replace={heading.replace}
                  className="focus-ring rounded hover:underline"
                >
                  {title}
                </Link>
              </h2>
              <span className="shrink-0 text-xs text-ink-faint tabular-nums">
                {pluralize(group.hits.length, 'match', 'matches')}
              </span>
              {!(onlyOne && filteredConversations[0] === group.conversationId) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => onOnlyConversation(group.conversationId)}
                >
                  Only this conversation
                </Button>
              )}
            </header>
            <ol aria-label={`Results in ${title}`} className="mt-1 flex flex-col gap-0.5">
              {group.hits.map((hit) => (
                <li key={hitKey(hit)}>
                  <HitRow
                    hit={hit}
                    showConversation={false}
                    linkFor={linkFor}
                    selected={selectedKey === messageKey(hit.message)}
                  />
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

const FALLBACK_CHARS = 220;

/**
 * What to show when the server had no snippet (e.g. a file-only or blocks-only message).
 * Pass null when a snippet exists so the mrkdwn isn't parsed for nothing.
 */
function useFallbackText(message: MessageDTO | null): string {
  const ctx = useMrkdwnContext();
  if (!message) return '';
  const text = message.text ? mrkdwnToPlainText(message.text, ctx) : '';
  if (text) return text.length > FALLBACK_CHARS ? `${text.slice(0, FALLBACK_CHARS)}…` : text;
  const files = message.files.map((f) => f.title || f.name).filter(Boolean);
  return files.length ? files.join(', ') : '(no text)';
}

/**
 * One result: the whole row is a single link to the message (replies open their thread), in the
 * preview or in its conversation, as `linkFor` says. The previewed one is marked as current.
 */
export const HitRow = memo(function HitRow({
  hit,
  showConversation,
  linkFor = defaultLinkFor,
  selected = false,
}: {
  hit: SearchHit;
  showConversation: boolean;
  linkFor?: (message: MessageDTO) => ResultLink;
  selected?: boolean;
}) {
  const dir = useDirectory();
  const { message } = hit;
  const author = resolveAuthor(message, dir);
  const conv = dir.conversations.get(message.conversationId);
  const date = tsToDate(message.ts);
  const fallback = useFallbackText(hit.snippet ? null : message);
  const beyond = isBeyondFreeWindow(date) && !isNotesToSelf(conv, dir.selfUserId);
  const where = conv ? conversationTitle(conv) : message.conversationId;
  const text = hit.snippet ? snippetText(hit.snippet) : fallback;
  const link = linkFor(message);

  return (
    <Link
      to={link.to}
      state={link.state}
      replace={link.replace}
      data-search-hit={messageKey(message)}
      data-selected={selected || undefined}
      aria-current={selected ? 'true' : undefined}
      // A concise name that still includes the message: the visual row is badges and fragments.
      aria-label={`${author.label} in ${where}, ${formatFullDateTime(date)}: ${text}`}
      className={clsx(
        'focus-ring group/hit flex gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150',
        selected ? 'bg-accent-soft/70 ring-1 ring-accent/20' : 'hover:bg-hover/70',
      )}
    >
      <Avatar seed={author.seed} label={author.label} src={author.avatarUrl} size={32} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px] leading-tight">
          <span className={clsx('font-semibold', author.deleted ? 'text-ink-muted' : 'text-ink')}>{author.label}</span>
          {showConversation && (
            <span className="inline-flex min-w-0 items-center gap-1 text-ink-muted">
              {/* The icon already says "#" or "lock", so the label goes without the prefix. */}
              {conv && <ConversationIcon conversation={conv} size={12} />}
              <span className="truncate">{conv ? conv.label : where}</span>
            </span>
          )}
          <time
            dateTime={isoDateTime(date)}
            title={formatFullDateTime(date)}
            className="text-xs text-ink-faint tabular-nums"
          >
            {formatShortDate(date)}
          </time>
          {message.isReply && (
            <Tag icon={<CornerDownRightIcon size={11} />}>
              {message.subtype === 'thread_broadcast' ? 'Reply, also sent to channel' : 'Thread reply'}
            </Tag>
          )}
          {beyond && (
            <Tag icon={<ArchiveIcon size={11} />} title="Older than 90 days: no longer visible in Slack Free">
              Archive only
            </Tag>
          )}
          {message.isDeleted && <Tag>Deleted in Slack</Tag>}
        </div>
        {hit.snippet ? (
          <Snippet text={hit.snippet} className="mt-1 line-clamp-3 text-[14px] leading-relaxed text-ink" />
        ) : (
          <p className="mt-1 line-clamp-3 text-[14px] leading-relaxed break-words text-ink-muted">{fallback}</p>
        )}
        <HitMeta message={message} />
      </div>
      <ArrowUpIcon
        size={14}
        aria-hidden="true"
        className="mt-1 shrink-0 rotate-45 text-ink-faint opacity-0 transition-opacity group-hover/hit:opacity-100 group-focus-visible/hit:opacity-100"
      />
    </Link>
  );
});

function Tag({ children, icon, title }: { children: ReactNode; icon?: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 self-center rounded bg-inset px-1.5 py-px text-[11px] font-medium text-ink-muted"
    >
      {icon}
      {children}
    </span>
  );
}

function HitMeta({ message }: { message: MessageDTO }) {
  const files = message.files.length;
  const replies = !message.isReply ? message.replyCount : 0;
  if (!files && !replies) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-faint">
      {files > 0 && (
        <span className="inline-flex min-w-0 items-center gap-1">
          <FileIcon size={12} />
          <span className="truncate">
            {files === 1 ? message.files[0].title || message.files[0].name || '1 file' : pluralize(files, 'file')}
          </span>
        </span>
      )}
      {replies > 0 && (
        <span className="inline-flex items-center gap-1">
          <ThreadIcon size={12} />
          {pluralize(replies, 'reply', 'replies')}
        </span>
      )}
    </p>
  );
}
