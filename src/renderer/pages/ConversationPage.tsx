import { useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ConversationView } from '../components/conversation/ConversationView';
import { ThreadPanel } from '../components/thread/ThreadPanel';
import { parseTsParam } from '../lib/ts';

/** `/c/:id` — conversation in the main pane, optional thread (`?thread=`) on the right. */
export default function ConversationPage() {
  const { id = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const threadTs = parseTsParam(searchParams.get('thread'));
  const ts = parseTsParam(searchParams.get('ts'));
  const replyTs = threadTs && ts && ts !== threadTs ? ts : null;

  const closeThread = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      const current = parseTsParam(next.get('ts'));
      // A ts that pointed into the thread means nothing once it's closed.
      if (current && current !== next.get('thread')) next.delete('ts');
      next.delete('thread');
      return next;
    });
  }, [setSearchParams]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* Keyed so switching conversations starts with a fresh window and scroll state. */}
      <ConversationView key={id} conversationId={id} />
      {threadTs && (
        <ThreadPanel
          key={`${id}:${threadTs}`}
          conversationId={id}
          threadTs={threadTs}
          highlightTs={replyTs}
          onClose={closeThread}
        />
      )}
    </div>
  );
}
