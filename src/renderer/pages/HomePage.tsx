import { differenceInCalendarDays } from 'date-fns';
import type { SyncStatusDTO } from '../../shared/types';
import { describeError } from '../lib/api';
import { FREE_PLAN_WINDOW_DAYS, pluralize } from '../lib/format';
import {
  useAppInfo,
  useSettings,
  useStartSync,
  useStats,
  useStorage,
  useSyncStatus,
  useWorkspace,
} from '../lib/queries';
import { ArchiveStats, FreeWindowHero } from '../components/home/ArchiveStats';
import { ConnectSlackCard } from '../components/home/ConnectSlackCard';
import { ProblemCallout } from '../components/home/ProblemCallout';
import { connectPrompt } from '../components/home/runs';
import { SyncHistory } from '../components/home/SyncHistory';
import { SyncPanel } from '../components/home/SyncPanel';
import { AlertIcon, ClockIcon, SyncIcon } from '../components/icons';
import { SidebarToggle } from '../components/layout/shell';
import { Button } from '../components/ui/Button';
import { Callout } from '../components/ui/Callout';

/**
 * `/` (PLAN §8.2): what's in the archive and, prominently, how much of it Slack no longer shows;
 * whether syncing is healthy (with the fix when it isn't); Sync now; and a short history.
 * Every panel loads on its own, so the archive stays readable when one of them can't.
 */
export default function HomePage() {
  const workspace = useWorkspace();
  const stats = useStats();
  const storage = useStorage();
  const sync = useSyncStatus();
  const settings = useSettings();
  const info = useAppInfo();
  const status = sync.data;
  const teamName = workspace.data?.teamName;
  const problem = status?.problem ?? null;
  const prompt = connectPrompt(workspace.data, stats.data, status, settings.data?.connection);
  // Slack's sign-out comes both as the last run's problem and as an expired connection: say it once.
  const showPrompt = prompt != null && !(prompt === 'expired' && problem?.kind === 'signed_out');
  const firstRun = prompt === 'first-run';

  return (
    <section className="flex min-h-0 min-w-0 flex-1 animate-page-in flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <SidebarToggle />
        <h1 className="text-[15px] font-semibold text-ink">Overview</h1>
      </header>
      <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-ink">
              {teamName ? `${teamName} archive` : 'Your Slack archive'}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              A private copy of your Slack history, kept on this computer and searchable. Nothing here expires.
            </p>
          </div>

          {problem && <ProblemCallout problem={problem} />}
          {showPrompt && <ConnectSlackCard variant={prompt} />}
          {status?.stale && !status.running && <StaleCallout status={status} />}
          {settings.isError && (
            <Callout tone="danger" icon={<AlertIcon size={15} />} role="alert">
              <p className="font-medium">Some settings couldn’t be loaded.</p>
              <p className="text-ink-muted">{describeError(settings.error)}</p>
              <div className="mt-2">
                <Button size="sm" onClick={() => void settings.refetch()}>
                  Try again
                </Button>
              </div>
            </Callout>
          )}
          {info.data && !info.data.installedProperly && (
            <Callout tone="warn" icon={<AlertIcon size={15} />}>
              Slamem is running from the download. Drag it into your Applications folder so it can start by itself and
              keep syncing.
            </Callout>
          )}

          {stats.data && <FreeWindowHero stats={stats.data} />}
          {!(firstRun && stats.data?.messageCount === 0) && (
            <ArchiveStats
              stats={stats.data}
              storage={storage.data}
              error={stats.error}
              onRetry={() => void stats.refetch()}
            />
          )}
          <SyncPanel status={status} error={sync.error} onRetry={() => void sync.refetch()} />
          {status && (!firstRun || status.recentRuns.length > 0) && <SyncHistory runs={status.recentRuns} />}
        </div>
      </div>
    </section>
  );
}

/** PLAN §5.3: a month without syncing risks history Slack is about to hide for good. */
function StaleCallout({ status }: { status: SyncStatusDTO }) {
  const startSync = useStartSync();
  const days = status.lastSuccessAt != null ? differenceInCalendarDays(Date.now(), status.lastSuccessAt) : null;
  // When Slack signed the session out, Reconnect (in the problem above) is the fix, not a sync.
  const canSync = status.blockedReason == null && status.problem?.action !== 'reconnect';
  return (
    <Callout tone="warn" icon={<ClockIcon size={15} />} role="alert">
      <p className="font-medium">
        {days != null
          ? `Your last successful sync was ${pluralize(days, 'day')} ago.`
          : 'Slamem hasn’t synced in a long time.'}
      </p>
      <p className="text-ink-muted">
        Slack only keeps the last {FREE_PLAN_WINDOW_DAYS} days, so sync soon: anything older than that can’t be fetched
        any more.
      </p>
      {canSync && (
        <div className="mt-2">
          <Button
            size="sm"
            variant="primary"
            icon={<SyncIcon size={14} />}
            loading={startSync.isPending}
            onClick={() => startSync.mutate()}
          >
            Sync now
          </Button>
        </div>
      )}
      {startSync.isError && <p className="mt-1.5 text-ink-muted">{describeError(startSync.error)}</p>}
    </Callout>
  );
}
