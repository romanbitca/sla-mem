import { memo, useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { AiStepDTO, MessageDTO } from '../../../shared/types';
import { describeUsage } from '../../lib/aiModels';
import type { AskTurn } from '../../lib/askChat';
import { messageKey } from '../../lib/searchNav';
import { AlertIcon, LayersIcon, MessageIcon, SearchIcon, SparklesIcon, SyncIcon } from '../icons';
import { HitRow, type ResultLink } from '../search/SearchResults';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { AnswerText, type CitationResolver } from './AnswerText';
import { ScopeSummary } from './ScopeBar';
import { citedRefs } from './parseAnswer';

/** Sources listed under an answer before "Show all". */
const SOURCES_SHOWN = 5;

export interface AskTurnViewProps {
  turn: AskTurn;
  sources: ReadonlyMap<number, MessageDTO>;
  citation: CitationResolver;
  linkFor: (message: MessageDTO) => ResultLink;
  /** The message open beside the chat (`messageKey`). */
  selectedKey: string | null;
  /** Asks the same question again (after a failure). */
  onRetry?: () => void;
}

/** One question and its answer: what Claude looked at, the answer, its sources and its cost. */
export const AskTurnView = memo(function AskTurnView({
  turn,
  sources,
  citation,
  linkFor,
  selectedKey,
  onRetry,
}: AskTurnViewProps) {
  const text = useMemo(
    () =>
      turn.parts
        .filter((p) => p.kind === 'text')
        .map((p) => p.text)
        .join('\n\n'),
    [turn.parts],
  );
  const cited = useMemo(
    () => citedRefs(text).flatMap((ref) => (sources.has(ref) ? [{ ref, message: sources.get(ref)! }] : [])),
    [text, sources],
  );
  const busy = turn.status === 'waiting' || turn.status === 'answering';
  const last = turn.parts[turn.parts.length - 1];
  const thinking = busy && (!last || last.kind === 'step');

  return (
    <article className="flex flex-col gap-3" aria-busy={busy || undefined}>
      <div className="flex flex-col items-end gap-1">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-[14.5px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
          {turn.question}
        </p>
        {turn.scope && <ScopeSummary scope={turn.scope} />}
      </div>
      <div className="flex gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text"
        >
          <SparklesIcon size={14} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          {turn.parts.map((part, i) =>
            part.kind === 'step' ? (
              <StepLine key={i} step={part.step} />
            ) : (
              <AnswerText key={i} text={part.text} citation={citation} />
            ),
          )}
          {thinking && (
            <p role="status" className="flex items-center gap-2 text-[13px] text-ink-faint">
              <Spinner size={12} />
              {turn.parts.length ? 'Reading…' : 'Thinking…'}
            </p>
          )}
          {turn.status === 'stopped' && <p className="text-[13px] text-ink-faint">Stopped.</p>}
          {turn.status === 'error' && turn.error && <TurnError turn={turn} onRetry={onRetry} />}
          {cited.length > 0 && <Sources cited={cited} linkFor={linkFor} selectedKey={selectedKey} />}
          {turn.usage && !busy && (turn.status === 'done' || turn.usage.outputTokens > 0) && (
            <p className="text-[11.5px] text-ink-faint tabular-nums">{describeUsage(turn.usage)}</p>
          )}
        </div>
      </div>
    </article>
  );
});

const STEP_ICONS = { search: SearchIcon, read: MessageIcon, list: LayersIcon } as const;

function StepLine({ step }: { step: AiStepDTO }) {
  const Icon = STEP_ICONS[step.kind] ?? SearchIcon;
  return (
    <p className="-mb-1 flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-faint">
      <Icon size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{step.label}</span>
      {step.detail && <span className="shrink-0">· {step.detail}</span>}
    </p>
  );
}

function TurnError({ turn, onRetry }: { turn: AskTurn; onRetry?: () => void }) {
  const error = turn.error!;
  const keyProblem = error.kind === 'no_key' || error.kind === 'bad_key' || error.kind === 'no_credit';
  const transient = ['rate_limited', 'overloaded', 'offline', 'failed'].includes(error.kind);
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-danger/35 bg-danger-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-danger"
    >
      <AlertIcon size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{error.message}</p>
        {(keyProblem || (transient && onRetry)) && (
          <div className="mt-2 flex gap-2">
            {keyProblem && (
              <Link
                to="/settings#ask-ai"
                className="focus-ring inline-flex h-7 items-center rounded-md border border-line bg-raised px-2.5 text-[13px] font-medium text-ink hover:bg-hover"
              >
                Open Settings
              </Link>
            )}
            {transient && onRetry && (
              <Button size="sm" icon={<SyncIcon size={13} />} onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Sources({
  cited,
  linkFor,
  selectedKey,
}: {
  cited: { ref: number; message: MessageDTO }[];
  linkFor: (message: MessageDTO) => ResultLink;
  selectedKey: string | null;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? cited : cited.slice(0, SOURCES_SHOWN);
  return (
    <section aria-label="Sources" className="mt-1">
      <h3 className="px-1 pb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Sources</h3>
      <ol className="flex flex-col gap-0.5">
        {shown.map(({ ref, message }) => (
          <li key={ref} className="flex items-start">
            <span
              aria-hidden="true"
              className="mt-3.5 w-5 shrink-0 text-right text-[11px] font-semibold text-accent-text tabular-nums"
            >
              {ref}
            </span>
            <div className="min-w-0 flex-1">
              <HitRow
                hit={{ message, snippet: '' }}
                showConversation
                linkFor={linkFor}
                selected={selectedKey === messageKey(message)}
              />
            </div>
          </li>
        ))}
      </ol>
      {cited.length > SOURCES_SHOWN && (
        <Button size="sm" variant="ghost" className="mt-1 ml-5" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${cited.length}`}
        </Button>
      )}
    </section>
  );
}
