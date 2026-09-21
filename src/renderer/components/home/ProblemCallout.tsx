import { useNavigate } from 'react-router';
import type { ProblemDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { useSettings, useShowLogs, useStartLogin, useStartSync, useWorkspace } from '../../lib/queries';
import { AlertIcon } from '../icons';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';

/**
 * Starts the Slack sign-in again for the archive's own workspace, then shows Settings, where the
 * connection card follows the sign-in window step by step.
 */
export function useReconnect() {
  const navigate = useNavigate();
  const start = useStartLogin();
  const connection = useSettings().data?.connection;
  const workspace = useWorkspace().data;
  const teamDomain = connection?.teamDomain ?? workspace?.teamDomain ?? null;
  const reconnect = () =>
    start.mutate(teamDomain ? { workspace: teamDomain } : {}, { onSuccess: () => navigate('/settings') });
  return { reconnect, pending: start.isPending, error: start.error };
}

/**
 * The last run's failure (PLAN §8.5): main's plain-language message plus the one action that
 * fixes it. Unexpected failures offer both "Try again" and "Show logs".
 */
export function ProblemCallout({ problem, className }: { problem: ProblemDTO; className?: string }) {
  const { reconnect, pending: reconnecting, error: reconnectError } = useReconnect();
  const startSync = useStartSync();
  const showLogs = useShowLogs();
  const error = reconnectError ?? startSync.error ?? showLogs.error;
  const retry = problem.action === 'retry' || problem.kind === 'unexpected';
  const logs = problem.action === 'show_logs' || problem.kind === 'unexpected';

  return (
    <Callout
      tone={problem.kind === 'offline' ? 'warn' : 'danger'}
      icon={<AlertIcon size={15} />}
      role="alert"
      className={className}
    >
      <p className="font-medium">{problem.message}</p>
      {(problem.action === 'reconnect' || retry || logs) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {problem.action === 'reconnect' && (
            <Button size="sm" variant="primary" loading={reconnecting} onClick={reconnect}>
              Reconnect
            </Button>
          )}
          {retry && (
            <Button
              size="sm"
              variant={problem.action === 'retry' ? 'primary' : 'secondary'}
              loading={startSync.isPending}
              onClick={() => startSync.mutate()}
            >
              Try again
            </Button>
          )}
          {logs && (
            <Button size="sm" loading={showLogs.isPending} onClick={() => showLogs.mutate()}>
              Show logs
            </Button>
          )}
        </div>
      )}
      {error != null && <p className="mt-1.5 text-ink-muted">{describeError(error)}</p>}
    </Callout>
  );
}
