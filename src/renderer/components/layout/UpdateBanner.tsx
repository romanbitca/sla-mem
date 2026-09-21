import { useState } from 'react';
import type { UpdateInfoDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { currentPlatform, type Platform } from '../../lib/bridge';
import { useOpenUpdateDownload, useUpdateInfo } from '../../lib/queries';
import { readPref, writePref } from '../../lib/storage';
import { CloseIcon, DownloadIcon, InfoIcon } from '../icons';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { IconButton } from '../ui/IconButton';

const DISMISSED_PREF = 'update.dismissed';

/** The one step that follows the download (unsigned builds update by hand; PLAN §9.5). */
export function updateInstruction(platform: Platform): string {
  if (platform === 'darwin') return 'Open the download and drag Slack Archive to Applications, replacing the old one.';
  if (platform === 'win32') return 'Run the installer. Your archive stays where it is.';
  return 'Install the new version the same way you installed this one.';
}

/**
 * A quiet bar over the main pane when a newer version exists: what's new, the download, and the
 * one instruction that goes with it. Dismissed per version, so the next release shows again.
 */
export function UpdateBanner() {
  const info = useUpdateInfo().data;
  const [dismissed, setDismissed] = useState(() => readPref(DISMISSED_PREF));
  const [notesOpen, setNotesOpen] = useState(false);
  const download = useOpenUpdateDownload();

  if (!info?.available || !info.latestVersion || dismissed === info.latestVersion) return null;
  const version = info.latestVersion;

  return (
    <div
      role="region"
      aria-label="Update available"
      className="flex shrink-0 items-start gap-3 border-b border-accent/25 bg-accent-soft px-4 py-2 text-[13px] sm:items-center"
    >
      <InfoIcon size={15} className="mt-0.5 shrink-0 text-accent-text sm:mt-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2">
        <p className="font-medium text-accent-text">
          Version {version} is available
          {info.notes && (
            <>
              {' — '}
              <button
                type="button"
                onClick={() => setNotesOpen(true)}
                className="focus-ring rounded underline underline-offset-2 hover:no-underline"
              >
                What’s new
              </button>
            </>
          )}
        </p>
        <p className="text-ink-muted">{updateInstruction(currentPlatform())}</p>
        {download.isError && <p className="text-danger">{describeError(download.error)}</p>}
      </div>
      <Button
        size="sm"
        variant="primary"
        icon={<DownloadIcon size={14} />}
        loading={download.isPending}
        onClick={() => download.mutate()}
      >
        Download
      </Button>
      <IconButton
        size="sm"
        label={`Hide until the next version`}
        icon={<CloseIcon size={14} />}
        onClick={() => {
          writePref(DISMISSED_PREF, version);
          setDismissed(version);
        }}
      />
      <ReleaseNotesDialog
        open={notesOpen}
        info={info}
        onClose={() => setNotesOpen(false)}
        onDownload={() => download.mutate()}
      />
    </div>
  );
}

function ReleaseNotesDialog({
  open,
  info,
  onClose,
  onDownload,
}: {
  open: boolean;
  info: UpdateInfoDTO;
  onClose: () => void;
  onDownload: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`What’s new in version ${info.latestVersion}`}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            icon={<DownloadIcon size={14} />}
            onClick={() => {
              onDownload();
              onClose();
            }}
          >
            Download
          </Button>
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
