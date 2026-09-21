import { useId } from 'react';
import clsx from 'clsx';
import type { ThemePreference } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { currentPlatform } from '../../lib/bridge';
import {
  useAppInfo,
  useCheckForUpdates,
  useOpenExternal,
  useOpenUpdateDownload,
  useSettings,
  useShowLogs,
  useUpdatePreferences,
} from '../../lib/queries';
import { THEME_LABELS } from '../../lib/theme';
import { GUIDE_URL } from '../connect/connection';
import { AlertIcon, CheckIcon, ExternalLinkIcon, InfoIcon, MonitorIcon, MoonIcon, SunIcon, SyncIcon } from '../icons';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Card } from '../ui/Card';
import { FieldError } from './fields';

const THEME_ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;
const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

/** Version and updates, the guide, logs for when something's wrong, and light/dark. */
export function AboutCard() {
  const info = useAppInfo();
  const check = useCheckForUpdates();
  const download = useOpenUpdateDownload();
  const openGuide = useOpenExternal();
  const showLogs = useShowLogs();
  const result = check.data;
  const mac = currentPlatform() === 'darwin';
  const error = check.error ?? download.error ?? openGuide.error ?? showLogs.error;

  return (
    <Card id="about" title="About" icon={<InfoIcon size={15} />}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-[13.5px] text-ink">
          <span className="font-semibold">Slack Archive</span>{' '}
          {info.data ? (
            <span className="text-ink-muted tabular-nums">version {info.data.version}</span>
          ) : info.isError ? (
            <span className="text-ink-faint">version unknown</span>
          ) : null}
        </p>
        <Button size="sm" icon={<SyncIcon size={13} />} loading={check.isPending} onClick={() => check.mutate()}>
          Check for updates
        </Button>
      </div>
      {result && !result.available && !result.error && (
        <p role="status" className="flex items-center gap-1.5 text-[13px] text-success">
          <CheckIcon size={14} /> You have the latest version.
        </p>
      )}
      {result?.error && (
        <p role="status" className="text-[13px] text-ink-muted">
          Couldn’t check for updates right now. Slack Archive tries again by itself later.
        </p>
      )}
      {result?.available && (
        <Callout tone="info" icon={<InfoIcon size={15} />} role="status">
          <p className="font-medium">Version {result.latestVersion} is available.</p>
          <p className="text-ink-muted">
            {mac
              ? 'Open the download and drag Slack Archive to Applications, replacing the old one.'
              : 'Run the installer to update.'}
          </p>
          <div className="mt-2">
            <Button size="sm" variant="primary" loading={download.isPending} onClick={() => download.mutate()}>
              Download
            </Button>
          </div>
        </Callout>
      )}
      {info.data && !info.data.installedProperly && (
        <Callout tone="warn" icon={<AlertIcon size={15} />}>
          Slack Archive is running from the download. Drag it into your Applications folder so it can start by itself
          and keep syncing.
        </Callout>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          icon={<ExternalLinkIcon size={14} />}
          loading={openGuide.isPending}
          onClick={() => openGuide.mutate(GUIDE_URL)}
        >
          Install and user guide
        </Button>
        <Button loading={showLogs.isPending} onClick={() => showLogs.mutate()}>
          Show logs
        </Button>
      </div>
      {error != null && <FieldError>{describeError(error)}</FieldError>}

      <div className="-mx-5 border-t border-line" />
      <ThemeChoice />
    </Card>
  );
}

/** System / Light / Dark. The saved choice lives in main; the page switches at once. */
function ThemeChoice() {
  const settings = useSettings();
  const update = useUpdatePreferences();
  const theme = settings.data?.preferences.theme;
  const name = useId();
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p id={labelId} className="text-[13.5px] font-medium text-ink">
        Appearance
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="flex w-fit rounded-lg border border-line bg-canvas p-0.5"
      >
        {THEMES.map((value) => {
          const Icon = THEME_ICONS[value];
          return (
            <label
              key={value}
              className={clsx(
                'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors',
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent',
                'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55',
                theme === value
                  ? 'bg-accent-soft font-medium text-accent-text'
                  : 'text-ink-muted hover:bg-hover hover:text-ink',
              )}
            >
              <input
                type="radio"
                name={name}
                value={value}
                checked={theme === value}
                disabled={!settings.data}
                onChange={() => update.mutate({ theme: value })}
                className="sr-only"
              />
              <Icon size={14} />
              {THEME_LABELS[value]}
            </label>
          );
        })}
      </div>
      {update.isError && <FieldError>Couldn’t save: {describeError(update.error)}</FieldError>}
    </div>
  );
}
