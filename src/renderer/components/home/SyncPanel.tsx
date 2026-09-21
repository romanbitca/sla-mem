import { Link } from 'react-router';
import type { SyncStatusDTO } from '../../../shared/types';
import { describeError, presentableMessage } from '../../lib/api';
import { useNow } from '../../lib/hooks';
import { useCancelSync, useStartSync } from '../../lib/queries';
import { intervalLabel } from '../connect/connection';
import { AlertIcon, CloseIcon, SyncIcon } from '../icons';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Card } from '../ui/Card';
import { ErrorState } from '../ui/EmptyState';
import { LoadingState } from '../ui/Spinner';
import { Fact, TimeAgo } from './parts';
import { RunProgress } from './RunProgress';

export interface SyncPanelProps {
  status: SyncStatusDTO | undefined;
  error: unknown;
  onRetry: () => void;
  className?: string;
}

/** When the last sync ran and the next one will, live progress, and Sync now / Cancel. */
export function SyncPanel({ status, error, onRetry, className }: SyncPanelProps) {
  const startSync = useStartSync();
  const cancelSync = useCancelSync();
  const now = useNow(30_000);

  let body;
  if (!status) {
    body = error ? (
      <ErrorState compact error={error} title="Couldn’t check on syncing" onRetry={onRetry} className="py-4" />
    ) : (
      <LoadingState label="Checking on syncing…" className="py-6" />
    );
  } else {
    const blocked = status.blockedReason != null;
    const importing = status.running && status.currentRun?.kind === 'import';
    const mutationError = startSync.error ?? cancelSync.error;
    body = (
      <>
        {blocked && !status.running && (
          <Callout tone="warn" icon={<AlertIcon size={15} />} role="status">
            <p className="font-medium">
              {presentableMessage(status.blockedReason, 'Syncing isn’t possible right now.')}
            </p>
            <p className="text-ink-muted">
              <Link to="/settings" className="font-medium text-accent-text underline underline-offset-2">
                Open Settings
              </Link>{' '}
              to fix it.
            </p>
          </Callout>
        )}
        {status.running ? (
          <RunProgress run={status.currentRun} progress={status.progress} />
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
            <Fact label="Last successful sync">
              {status.lastSuccessAt ? <TimeAgo ms={status.lastSuccessAt} now={now} past /> : 'Not yet'}
            </Fact>
            <Fact label="Next sync">
              {status.intervalMinutes === 0 ? (
                'When you press Sync now'
              ) : status.nextRunAt ? (
                <TimeAgo ms={status.nextRunAt} now={now} />
              ) : (
                '—'
              )}
            </Fact>
            <Fact label="Schedule">{intervalLabel(status.intervalMinutes)}</Fact>
          </dl>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={<SyncIcon size={15} />}
            loading={startSync.isPending}
            disabled={status.running || blocked}
            onClick={() => startSync.mutate()}
          >
            {!status.running ? 'Sync now' : importing ? 'Importing…' : 'Syncing…'}
          </Button>
          {status.running && (
            <Button
              variant="danger"
              icon={<CloseIcon size={15} />}
              loading={cancelSync.isPending}
              onClick={() => cancelSync.mutate()}
            >
              Cancel
            </Button>
          )}
          {status.running && (
            <span className="text-xs text-ink-faint">Cancelling keeps everything fetched so far.</span>
          )}
        </div>
        {mutationError != null && (
          <p role="alert" className="text-[13px] text-danger">
            {describeError(mutationError)}
          </p>
        )}
      </>
    );
  }

  return (
    <Card title="Sync" icon={<SyncIcon size={15} />} className={className}>
      {body}
    </Card>
  );
}
