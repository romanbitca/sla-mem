import { Link } from 'react-router';
import type { StyleReviewDTO } from '../../../shared/types';
import { AI_MODEL_INFO, describeUsage } from '../../lib/aiModels';
import { describeError } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useReviewStyle, useSettings, useStyleReview } from '../../lib/queries';
import { SparklesIcon } from '../icons';
import { Button, buttonClass } from '../ui/Button';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';
import { Example } from './Writing';

/** Your latest messages Claude reads (main's REVIEW_MESSAGES). */
const REVIEW_MESSAGES = 150;

/**
 * Claude's review of your writing: what the rules can't see (tone, clarity, how you put requests),
 * with some of your messages rewritten, and the words you misspell. It is saved and shown until
 * you ask for a new one; only then do your latest messages (only yours) go to Anthropic.
 */
export function ReviewCard() {
  const settings = useSettings().data;
  const saved = useStyleReview();
  const review = useReviewStyle();
  const hasKey = settings?.ai.saved ?? false;
  const model = settings ? AI_MODEL_INFO[settings.preferences.aiModel].name : 'Claude';
  const shown = review.data ?? saved.data ?? null;

  const action = hasKey ? (
    <Button
      variant={shown ? 'secondary' : 'primary'}
      size="sm"
      icon={<SparklesIcon size={14} />}
      loading={review.isPending}
      onClick={() => review.mutate()}
      title={`Sends your latest ${REVIEW_MESSAGES} messages (only yours) to ${model}`}
    >
      {shown ? 'Review again' : 'Review my writing'}
    </Button>
  ) : (
    <Link to="/settings" className={buttonClass('secondary', 'sm')}>
      Add an API key
    </Link>
  );

  return (
    <Card title="Claude’s review" icon={<SparklesIcon size={15} />} aside={action}>
      {review.isPending ? (
        <p className="flex items-center gap-2 text-[13px] text-ink-muted">
          <Spinner size={13} /> {model} is reading your latest {REVIEW_MESSAGES} messages…
        </p>
      ) : shown ? (
        <ReviewBody review={shown} />
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          A second opinion on what rules can’t see: your tone, how clear you are, how you put requests. {model} reads
          your latest {REVIEW_MESSAGES} messages (only yours), rewrites a few, and lists the words you misspell. It
          costs a few cents on your Anthropic key{hasKey ? '' : ', which you add in Settings → Ask AI'}. The review is
          kept here until you ask for a new one.
        </p>
      )}
      {review.isError && (
        <p role="alert" className="text-[13px] text-danger">
          {describeError(review.error)}
        </p>
      )}
    </Card>
  );
}

function ReviewBody({ review }: { review: StyleReviewDTO }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[14px] leading-relaxed text-ink">{review.summary}</p>
      {review.strengths.length > 0 && (
        <div>
          <h3 className="pb-1 text-xs font-semibold text-ink-faint">What works</h3>
          <ul className="flex flex-wrap gap-1.5">
            {review.strengths.map((s) => (
              <li key={s} className="rounded-full bg-success/12 px-2.5 py-0.5 text-[12.5px] text-success">
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
      {review.tips.length > 0 && (
        <ol className="flex flex-col gap-4">
          {review.tips.map((tip, i) => (
            <li key={`${i}:${tip.title}`} className="flex flex-col gap-2">
              <div>
                <h3 className="text-[13.5px] font-semibold text-ink">
                  <span className="mr-1.5 text-ink-faint tabular-nums">{i + 1}.</span>
                  {tip.title}
                </h3>
                <p className="text-[13px] leading-relaxed text-ink-muted">{tip.tip}</p>
              </div>
              {tip.before && (
                <Example
                  example={{
                    before: tip.before,
                    after: tip.after,
                    conversationId: tip.message?.conversationId,
                    ts: tip.message?.ts,
                    threadTs: tip.message?.threadTs ?? null,
                    isReply: tip.message?.isReply ?? false,
                  }}
                />
              )}
            </li>
          ))}
        </ol>
      )}
      {review.typos.length > 0 && (
        <div>
          <h3 className="pb-1 text-xs font-semibold text-ink-faint">Words you misspell</h3>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {review.typos.map((t) => (
              <li key={t.wrong}>
                <span className="text-ink-muted line-through decoration-danger/60">{t.wrong}</span>
                <span className="px-1 text-ink-faint">→</span>
                <span className="text-ink">{t.right}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-ink-faint">
        {formatDate(new Date(review.at), 'MMM d, yyyy')} · your latest {review.messageCount} messages ·{' '}
        {describeUsage(review.usage)}
      </p>
    </div>
  );
}
