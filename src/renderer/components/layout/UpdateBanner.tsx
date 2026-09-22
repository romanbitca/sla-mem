import { useState } from 'react';
import type { RunKind, UpdateInfoDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { currentPlatform, type Platform } from '../../lib/bridge';
import { useInstallUpdate, useOpenUpdateDownload, useUpdateInfo } from '../../lib/queries';
import { readPref, writePref } from '../../lib/storage';
import { CloseIcon, DownloadIcon, InfoIcon } from '../icons';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { IconButton } from '../ui/IconButton';

const DISMISSED_PREF = 'update.dismissed';

/**
 * The one line that goes with an update (PLAN §9.5): what happens when sla-mem installs it itself,
 * or the step that follows the download when it can't.
 */
export function updateInstruction(platform: Platform, canInstall = false): string {
  if (canInstall) {
    // Each version is signed anew, so macOS asks once before the new one may read the sign-in.
    return platform === 'darwin'
      ? 'sla-mem restarts to finish. If your Mac then asks whether it may use the keychain, click Always Allow.'
      : 'sla-mem restarts to finish. Your archive stays where it is.';
  }
  // Finder won't replace an app that is running; the Windows installer closes it by itself.
  if (platform === 'darwin')
    return 'Quit sla-mem, then open the download and drag sla-mem to Applications, replacing the old one.';
  if (platform === 'win32') return 'Run the installer. Your archive stays where it is.';
  return 'Install the new version the same way you installed this one.';
}

const RUN_NAME: Record<RunKind, string> = {
  sync: 'the sync',
  files: 'the attachment download',
  import: 'the import',
};

/** Downloading, waiting to restart or restarting: under way, nothing to click. */
export function isInstalling(info: UpdateInfoDTO): boolean {
  const { state } = info.install;
  return state === 'downloading' || state === 'waiting' || state === 'restarting';
}

export interface UpdateActions {
  install(): void;
  download(): void;
  installing: boolean;
  downloading: boolean;
  /** The Download link was opened (the instruction for doing it by hand then applies). */
  downloaded: boolean;
  error: unknown;
}

/** Update and restart, and the Download link that remains when it can't be used. */
export function useUpdateActions(): UpdateActions {
  const install = useInstallUpdate();
  const download = useOpenUpdateDownload();
  return {
    install: () => install.mutate(),
    download: () => download.mutate(),
    installing: install.isPending,
    downloading: download.isPending,
    downloaded: download.isSuccess,
    error: install.error ?? download.error,
  };
}

/** "Version 1.3.0 is available — What's new", or what the update is doing. */
export function UpdateHeadline({ info, onNotes }: { info: UpdateInfoDTO; onNotes?: () => void }) {
  const version = info.latestVersion;
  const { state, progress } = info.install;
  if (state === 'downloading') {
    const percent = Math.round((progress ?? 0) * 100);
    return (
      <div className="flex items-center gap-2">
        <p className="font-medium text-accent-text">Downloading version {version}…</p>
        <div
          role="progressbar"
          aria-label="Update download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 w-20 overflow-hidden rounded-full bg-accent/15"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${Math.max(percent, 2)}%` }}
          />
        </div>
        <span className="text-ink-muted tabular-nums">{percent}%</span>
      </div>
    );
  }
  if (state === 'waiting') return <p className="font-medium text-accent-text">Version {version} is ready</p>;
  if (state === 'restarting') return <p className="font-medium text-accent-text">Restarting to update…</p>;
  return (
    <p className="font-medium text-accent-text">
      Version {version} is available
      {info.notes && onNotes && (
        <>
          {' — '}
          <button
            type="button"
            onClick={onNotes}
            className="focus-ring rounded underline underline-offset-2 hover:no-underline"
          >
            What’s new
          </button>
        </>
      )}
    </p>
  );
}

/** The line under the headline: what will happen, what it waits for, or why it didn't work. */
export function UpdateDetail({ info, actions }: { info: UpdateInfoDTO; actions: UpdateActions }) {
  const platform = currentPlatform();
  const { state, waitingFor, error } = info.install;
  let line = null;
  if (state === 'waiting') {
    line = <p className="text-ink-muted">sla-mem restarts as soon as {RUN_NAME[waitingFor ?? 'sync']} finishes.</p>;
  } else if (state === 'failed') {
    line = <p className="text-danger">{error}</p>;
  } else if (state === 'idle') {
    line = <p className="text-ink-muted">{updateInstruction(platform, info.canInstall)}</p>;
  }
  return (
    <>
      {line}
      {actions.downloaded && info.canInstall && <p className="text-ink-muted">{updateInstruction(platform, false)}</p>}
      {actions.error != null && <p className="text-danger">{describeError(actions.error)}</p>}
    </>
  );
}

/** Update and restart (Try again after a failure, with Download beside it), or just Download. */
export function UpdateButtons({ info, actions }: { info: UpdateInfoDTO; actions: UpdateActions }) {
  const installing = isInstalling(info);
  if (!installing && !info.canInstall) {
    return (
      <Button
        size="sm"
        variant="primary"
        icon={<DownloadIcon size={14} />}
        loading={actions.downloading}
        onClick={actions.download}
      >
        Download
      </Button>
    );
  }
  if (info.install.state === 'failed') {
    return (
      <>
        <Button size="sm" variant="primary" loading={actions.installing} onClick={actions.install}>
          Try again
        </Button>
        <Button size="sm" icon={<DownloadIcon size={14} />} loading={actions.downloading} onClick={actions.download}>
          Download
        </Button>
      </>
    );
  }
  return (
    <Button
      size="sm"
      variant="primary"
      icon={<DownloadIcon size={14} />}
      loading={installing || actions.installing}
      onClick={actions.install}
    >
      Update and restart
    </Button>
  );
}

/**
 * A quiet bar over the main pane when a newer version exists: what's new, Update and restart (or
 * the download and the one instruction that goes with it), and how the update is getting on.
 * Dismissed per version, so the next release shows again; an update under way stays in view.
 */
export function UpdateBanner() {
  const info = useUpdateInfo().data;
  const [dismissed, setDismissed] = useState(() => readPref(DISMISSED_PREF));
  const [notesOpen, setNotesOpen] = useState(false);
  const actions = useUpdateActions();

  if (!info?.latestVersion) return null;
  const version = info.latestVersion;
  const installing = isInstalling(info);
  const failed = info.install.state === 'failed';
  if (!installing && (!info.available || (dismissed === version && !failed))) return null;

  return (
    <div
      role="region"
      aria-label="Update available"
      className="flex shrink-0 animate-slide-down items-start gap-3 border-b border-accent/25 bg-accent-soft px-4 py-2 text-[13px] sm:items-center"
    >
      <InfoIcon size={15} className="mt-0.5 shrink-0 text-accent-text sm:mt-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
        <UpdateHeadline info={info} onNotes={() => setNotesOpen(true)} />
        <UpdateDetail info={info} actions={actions} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <UpdateButtons info={info} actions={actions} />
      </div>
      {!installing && (
        <IconButton
          size="sm"
          label="Hide until the next version"
          icon={<CloseIcon size={14} />}
          onClick={() => {
            writePref(DISMISSED_PREF, version);
            setDismissed(version);
          }}
        />
      )}
      <ReleaseNotesDialog open={notesOpen} info={info} actions={actions} onClose={() => setNotesOpen(false)} />
    </div>
  );
}

function ReleaseNotesDialog({
  open,
  info,
  actions,
  onClose,
}: {
  open: boolean;
  info: UpdateInfoDTO;
  actions: UpdateActions;
  onClose: () => void;
}) {
  const installing = isInstalling(info);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`What’s new in version ${info.latestVersion}`}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {!installing && (
            <Button
              variant="primary"
              icon={<DownloadIcon size={14} />}
              onClick={() => {
                if (info.canInstall) actions.install();
                else actions.download();
                onClose();
              }}
            >
              {info.canInstall ? 'Update and restart' : 'Download'}
            </Button>
          )}
        </>
      }
    >
      {/* Release notes are plain text written for readers; shown as text, never as HTML. */}
      <div className="scroll-thin max-h-80 overflow-y-auto rounded-lg border border-line bg-canvas px-3 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">
        {info.notes}
      </div>
    </Dialog>
  );
}
