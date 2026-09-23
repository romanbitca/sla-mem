import type { StyleDTO } from '../../shared/types';
import { formatDate, pluralize } from '../lib/format';
import { useStyle } from '../lib/queries';
import { TONE_LABEL, toneSentence } from '../lib/style';
import { tsToDate } from '../lib/ts';
import { PenNibIcon } from '../components/icons';
import { SidebarToggle } from '../components/layout/shell';
import { ToneInfo } from '../components/style/Explain';
import { PeopleRanking } from '../components/style/PeopleRanking';
import { ReplyTimeCard } from '../components/style/ReplyTimes';
import { ReviewCard } from '../components/style/Review';
import { WritingCard } from '../components/style/Writing';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { InfoButton } from '../components/ui/InfoButton';
import { LoadingState } from '../components/ui/Spinner';

/**
 * `/style`, My style: how you come across in your own messages and how quickly you answer, worked
 * out on this computer; and, on request, Claude's review of your writing.
 */
export default function StylePage() {
  const style = useStyle();

  let body;
  if (style.isPending) body = <LoadingState label="Reading your messages…" />;
  else if (style.isError)
    body = <ErrorState error={style.error} title="Couldn’t read your messages" onRetry={() => void style.refetch()} />;
  else if (style.data.messageCount === 0)
    body = (
      <EmptyState
        icon={<PenNibIcon size={20} />}
        title="Nothing of yours yet"
        description="Once the archive holds messages you wrote, how you write and how fast you answer show here."
      />
    );
  else body = <StyleView style={style.data} />;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 animate-page-in flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <SidebarToggle />
        <h1 className="text-[15px] font-semibold text-ink">My style</h1>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{body}</div>
    </section>
  );
}

function StyleView({ style }: { style: StyleDTO }) {
  const since = style.firstTs ? formatDate(tsToDate(style.firstTs), 'MMM d, yyyy') : null;
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8">
      <div>
        <div className="flex items-center gap-1.5">
          <h2 className="text-xl font-semibold tracking-tight text-ink">
            {style.tone ? TONE_LABEL[style.tone] : 'How you write'}
          </h2>
          {style.tone && (
            <InfoButton title="How the headline is decided">
              <ToneInfo style={style} />
            </InfoButton>
          )}
        </div>
        {style.checks.length > 0 && (
          <p className="mt-1 text-sm leading-relaxed text-ink-muted">{toneSentence(style.checks)}</p>
        )}
        <p className="mt-1.5 text-xs text-ink-faint">
          From your latest {pluralize(style.messageCount, 'message')}
          {since ? ` since ${since}` : ''}, worked out on this computer.
        </p>
      </div>
      <ReplyTimeCard style={style} />
      <PeopleRanking style={style} />
      <WritingCard style={style} />
      <ReviewCard />
    </div>
  );
}
