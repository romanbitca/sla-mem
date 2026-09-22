import { useId } from 'react';
import type { PreferencesDTO, SyncInterval, SyncStatusDTO } from '../../../shared/types';
import { describeError, presentableMessage } from '../../lib/api';
import { reopenHint, trayPlaceName } from '../../lib/bridge';
import { useFlag, useNow } from '../../lib/hooks';
import { useCancelSync, useStartSync, useUpdatePreferences } from '../../lib/queries';
import { SCHEDULE_OPTIONS } from '../connect/connection';
import { Fact, LastSyncFact, TimeAgo } from '../home/parts';
import { RunProgress } from '../home/RunProgress';
import { CheckIcon, CloseIcon, SyncIcon } from '../icons';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { FieldError, Select, SettingRow, Switch } from './fields';

export interface SyncSettingsCardProps {
  preferences: PreferencesDTO;
  status: SyncStatusDTO | undefined;
  /** Sync status couldn't be loaded (the schedule can still be changed). */
  statusError: unknown;
}

/**
 * How often to sync, whether to start at login and whether to keep an icon in the menu bar /
 * tray (saved on change), plus last/next sync.
 */
export function SyncSettingsCard({ preferences, status, statusError }: SyncSettingsCardProps) {
  const update = useUpdatePreferences();
  const [saved, flashSaved] = useFlag(2000);
  const ids = {
    interval: useId(),
    intervalHint: useId(),
    login: useId(),
    loginHint: useId(),
    tray: useId(),
    trayHint: useId(),
  };

  return (
    <Card
      id="sync"
      title="Sync"
      icon={<SyncIcon size={15} />}
      aside={
        <span role="status" className="text-xs text-ink-faint">
          {update.isPending ? (
            'Saving…'
          ) : saved ? (
            <span className="inline-flex items-center gap-1 text-success">
              <CheckIcon size={13} /> Saved
            </span>
          ) : null}
        </span>
      }
    >
      <div className="flex flex-col divide-y divide-line">
        <SettingRow
          label="How often to sync"
          htmlFor={ids.interval}
          description="Syncing continues in the background while the window is closed."
          descriptionId={ids.intervalHint}
        >
          <Select
            id={ids.interval}
            value={String(preferences.syncIntervalMinutes)}
            aria-describedby={ids.intervalHint}
            onChange={(e) =>
              update.mutate({ syncIntervalMinutes: Number(e.target.value) as SyncInterval }, { onSuccess: flashSaved })
            }
            className="w-48"
          >
            {SCHEDULE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow
          label="Start sla-mem when I log in"
          labelId={ids.login}
          description="Recommended. Slack only keeps the last 90 days, so regular syncing is what keeps your history."
          descriptionId={ids.loginHint}
        >
          <Switch
            checked={preferences.launchAtLogin}
            aria-labelledby={ids.login}
            aria-describedby={ids.loginHint}
            onChange={(checked) => update.mutate({ launchAtLogin: checked }, { onSuccess: flashSaved })}
          />
        </SettingRow>
        <SettingRow
          label={`Show sla-mem in the ${trayPlaceName()}`}
          labelId={ids.tray}
          description={
            preferences.showTrayIcon
              ? 'Shows sync progress and opens sla-mem at any time.'
              : `sla-mem keeps syncing in the background. Open it from ${reopenHint()} to see it again.`
          }
          descriptionId={ids.trayHint}
        >
          <Switch
            checked={preferences.showTrayIcon}
            aria-labelledby={ids.tray}
            aria-describedby={ids.trayHint}
            onChange={(checked) => update.mutate({ showTrayIcon: checked }, { onSuccess: flashSaved })}
          />
        </SettingRow>
      </div>
      {update.isError && <FieldError>Couldn’t save: {describeError(update.error)}</FieldError>}

      <div className="-mx-5 border-t border-line" />
      <SyncNow status={status} error={statusError} manual={preferences.syncIntervalMinutes === 0} />
    </Card>
  );
}

function SyncNow({ status, error, manual }: { status: SyncStatusDTO | undefined; error: unknown; manual: boolean }) {
  const startSync = useStartSync();
  const cancelSync = useCancelSync();
  const now = useNow(30_000);
  if (!status) {
    return error ? (
      <p className="text-[13px] text-ink-muted">Couldn’t check on syncing: {describeError(error)}</p>
    ) : null;
  }
  const syncing = status.running && status.currentRun?.kind !== 'import';
  return (
    <div className="flex flex-col gap-3">
      {status.running ? (
        <RunProgress run={status.currentRun} progress={status.progress} />
      ) : (
        <dl className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2">
          <LastSyncFact status={status} now={now} />
          <Fact label="Next sync">
            {manual ? 'When you press Sync now' : status.nextRunAt ? <TimeAgo ms={status.nextRunAt} now={now} /> : '—'}
          </Fact>
        </dl>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={<SyncIcon size={15} />}
          loading={startSync.isPending}
          disabled={status.running || status.blockedReason != null}
          onClick={() => startSync.mutate()}
        >
          {!status.running ? 'Sync now' : syncing ? 'Syncing…' : 'Importing…'}
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
        {status.blockedReason && !status.running && (
          <span className="text-xs text-ink-muted">
            {presentableMessage(status.blockedReason, 'Syncing isn’t possible right now.')}
          </span>
        )}
      </div>
      {(startSync.error ?? cancelSync.error) != null && (
        <FieldError>{describeError(startSync.error ?? cancelSync.error)}</FieldError>
      )}
    </div>
  );
}
