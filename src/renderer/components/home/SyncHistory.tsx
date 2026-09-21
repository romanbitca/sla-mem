import { useId, useState } from 'react';
import clsx from 'clsx';
import type { SyncRunDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { formatFullDateTime, isoDateTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useShowLogs } from '../../lib/queries';
import { readJsonPref, writeJsonPref } from '../../lib/storage';
import { ChevronDownIcon, HistoryIcon } from '../icons';
import { Button } from '../ui/Button';
import { StatusBadge } from './parts';
import { KIND_LABEL, runDuration, summarizeRun, timeAgo } from './runs';

const OPEN_PREF = 'home.historyOpen';

/**
 * Recent syncs and imports in plain words, folded by default: most people only need the last
 * result, which the summary line shows. The technical log is one "Show logs" click away.
 */
export function SyncHistory({ runs }: { runs: readonly SyncRunDTO[] }) {
  const [open, setOpen] = useState(() => readJsonPref<boolean>(OPEN_PREF, false) === true);
  const now = useNow(30_000);
  const showLogs = useShowLogs();
  const panelId = useId();
  const latest = runs[0];

  const toggle = () => {
    writeJsonPref(OPEN_PREF, !open);
    setOpen(!open);
  };

  return (
    <section aria-label="Sync history" className="rounded-2xl border border-line bg-raised shadow-xs">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
          className="focus-ring flex w-full items-center gap-2.5 rounded-2xl px-5 py-3 text-left hover:bg-hover/50"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
            <HistoryIcon size={15} />
          </span>
          <span className="text-[14px] font-semibold text-ink">Sync history</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">
            {latest
              ? `Last: ${KIND_LABEL[latest.kind].toLowerCase()} ${timeAgo(latest.finishedAt ?? latest.startedAt, now)} · ${summarizeRun(latest)}`
              : 'Nothing yet'}
          </span>
          <ChevronDownIcon
            size={15}
            className={clsx('shrink-0 text-ink-faint transition-transform duration-150', !open && '-rotate-90')}
          />
        </button>
      </h2>
      {open && (
        <div id={panelId} className="flex flex-col gap-3 border-t border-line px-5 py-4">
          {runs.length === 0 ? (
            <p className="text-[13px] text-ink-muted">Syncs and imports appear here once they’ve run.</p>
          ) : (
            <ol className="flex flex-col divide-y divide-line">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px] first:pt-0">
                  <StatusBadge status={run.status} />
                  <span className="font-medium text-ink">{KIND_LABEL[run.kind]}</span>
                  <time
                    className="text-ink-muted"
                    dateTime={isoDateTime(new Date(run.startedAt))}
                    title={formatFullDateTime(new Date(run.startedAt))}
                  >
                    {timeAgo(run.startedAt, now)}
                  </time>
                  <span className="text-ink-faint tabular-nums">{runDuration(run, now)}</span>
                  <span
                    className="min-w-0 basis-full truncate text-ink-muted sm:basis-auto sm:flex-1"
                    title={summarizeRun(run)}
                  >
                    {summarizeRun(run)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" loading={showLogs.isPending} onClick={() => showLogs.mutate()}>
              Show logs
            </Button>
            <span className="text-xs text-ink-faint">The detailed log, for when something needs looking into.</span>
          </div>
          {showLogs.isError && (
            <p role="alert" className="text-[13px] text-danger">
              {describeError(showLogs.error)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
