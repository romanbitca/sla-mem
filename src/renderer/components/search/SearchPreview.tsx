import { useNavigate, useSearchParams } from 'react-router';
import { useDirectory } from '../../lib/directory';
import { conversationPath } from '../../lib/links';
import type { FromSearchState, SearchPreviewTarget } from '../../lib/searchNav';
import { ConversationIcon, conversationTitle } from '../conversation/ConversationIcon';
import { ConversationView } from '../conversation/ConversationView';
import { ArrowUpIcon, CloseIcon } from '../icons';
import { ThreadPanel } from '../thread/ThreadPanel';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';

export interface SearchPreviewProps {
  target: SearchPreviewTarget;
  /**
   * This search, preview included (`/search?…`): where the conversation page returns to. Ask AI
   * passes its own screen (`/ask?…`).
   */
  searchUrl: string;
  onClose: () => void;
  /** Names the region for screen readers. */
  label?: string;
}

/** The conversation page showing what the preview shows. */
export function previewConversationPath(target: SearchPreviewTarget): string {
  const params = new URLSearchParams();
  if (target.threadTs) params.set('thread', target.threadTs);
  if (target.ts) params.set('ts', target.ts);
  const query = params.toString();
  return `${conversationPath(target.conversationId)}${query ? `?${query}` : ''}`;
}

/**
 * A search result opened next to the results (wide windows): the conversation at that message,
 * or the thread for a reply. Its own URL keys (`c`, `ts`, `thread`) keep it across back/forward;
 * "Open conversation" goes to the full conversation, which offers the way back here.
 */
export function SearchPreview({ target, searchUrl, onClose, label = 'Search result preview' }: SearchPreviewProps) {
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const conversation = useDirectory().conversations.get(target.conversationId);
  // The icon already says "#" or "lock", so the name goes without the prefix.
  const title = conversation?.label ?? target.conversationId;

  const openConversation = () =>
    navigate(previewConversationPath(target), {
      state: {
        fromSearch: searchUrl,
        hit: `${target.conversationId}:${target.ts ?? ''}`,
      } satisfies FromSearchState,
    });

  // Closing the thread shows the conversation at the thread's first message.
  const closeThread = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const threadTs = next.get('thread');
        next.delete('thread');
        if (threadTs) next.set('ts', threadTs);
        return next;
      },
      { replace: true },
    );

  return (
    <section
      aria-label={label}
      className="flex min-h-0 min-w-0 flex-1 animate-fade-in flex-col border-l border-line bg-canvas"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        {conversation && (
          <span className="shrink-0 text-ink-muted">
            <ConversationIcon conversation={conversation} size={15} />
          </span>
        )}
        <h2
          aria-label={conversation ? conversationTitle(conversation) : title}
          className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink"
        >
          {title}
        </h2>
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowUpIcon size={14} className="rotate-45" />}
          onClick={openConversation}
        >
          Open conversation
        </Button>
        <IconButton size="sm" label="Close preview" icon={<CloseIcon size={16} />} onClick={onClose} />
      </header>
      {target.threadTs ? (
        <ThreadPanel
          key={`${target.conversationId}:${target.threadTs}`}
          variant="fill"
          conversationId={target.conversationId}
          threadTs={target.threadTs}
          highlightTs={target.ts && target.ts !== target.threadTs ? target.ts : null}
          onClose={closeThread}
        />
      ) : (
        // Keyed by conversation: another result in the same one only moves to it.
        <ConversationView key={target.conversationId} conversationId={target.conversationId} header={null} />
      )}
    </section>
  );
}
