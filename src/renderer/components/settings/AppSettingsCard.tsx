import { useId } from 'react';
import type { PreferencesDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { reopenHint, trayPlaceName } from '../../lib/bridge';
import { useFlag } from '../../lib/hooks';
import { useUpdatePreferences } from '../../lib/queries';
import { CheckIcon, MonitorIcon } from '../icons';
import { Card } from '../ui/Card';
import { FieldError, SettingRow, Switch } from './fields';

/**
 * How Slamem itself behaves on this computer: whether it starts at login and whether it keeps
 * an icon in the menu bar / tray (saved on change). Syncing has its own card.
 */
export function AppSettingsCard({ preferences }: { preferences: PreferencesDTO }) {
  const update = useUpdatePreferences();
  const [saved, flashSaved] = useFlag(2000);
  const ids = { login: useId(), loginHint: useId(), tray: useId(), trayHint: useId() };

  return (
    <Card
      id="app"
      title="App"
      icon={<MonitorIcon size={15} />}
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
          label="Start Slamem when I log in"
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
          label={`Show Slamem in the ${trayPlaceName()}`}
          labelId={ids.tray}
          description={
            preferences.showTrayIcon
              ? 'Shows sync progress and opens Slamem at any time.'
              : `Slamem keeps syncing in the background. Open it from ${reopenHint()} to see it again.`
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
    </Card>
  );
}
