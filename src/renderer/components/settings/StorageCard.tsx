import { useId, useRef, useState } from 'react';
import { describeError, presentableMessage } from '../../lib/api';
import { fileBrowserName } from '../../lib/bridge';
import { formatBytes, pluralize } from '../../lib/format';
import {
  useBackupNow,
  useDeleteOldAttachments,
  useImportBackup,
  useShowDataFolder,
  useStorage,
} from '../../lib/queries';
import { CLEANUP_MONTHS, monthsLabel } from '../connect/connection';
import { Fact } from '../home/parts';
import { AlertIcon, ArchiveIcon, CheckIcon, DatabaseIcon, FolderIcon, TrashIcon } from '../icons';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Card } from '../ui/Card';
import { ConfirmDialog } from '../ui/Dialog';
import { ErrorState } from '../ui/EmptyState';
import { LoadingState } from '../ui/Spinner';
import { FieldError, Select } from './fields';

/**
 * Disk use split into messages and attachments, the archive folder, freeing space by removing
 * old downloads (messages are never deleted), and a backup to a folder of the reader's choice.
 */
export function StorageCard() {
  const storage = useStorage();
  const data = storage.data;
  const showFolder = useShowDataFolder();

  let body;
  if (data) {
    body = (
      <>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-4">
          <Fact label="Total">{formatBytes(data.totalBytes) || '0 B'}</Fact>
          <Fact label="Messages">{formatBytes(data.databaseBytes) || '0 B'}</Fact>
          <Fact label="Attachments">
            {formatBytes(data.attachmentsBytes) || '0 B'}
            <span className="text-ink-faint"> · {pluralize(data.filesDownloaded, 'file')}</span>
          </Fact>
          <Fact label="Free on this disk">{data.diskFreeBytes != null ? formatBytes(data.diskFreeBytes) : '—'}</Fact>
        </dl>
        {data.warning && (
          <Callout tone="warn" icon={<AlertIcon size={15} />} role="status">
            {presentableMessage(data.warning, 'Your disk is nearly full. Free up space so new messages can be saved.')}
          </Callout>
        )}
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-xs text-ink-faint">Archive folder</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-inset px-2.5 py-1.5 font-mono text-[12px] text-ink">
              {data.dataDir}
            </code>
            <Button icon={<FolderIcon size={14} />} loading={showFolder.isPending} onClick={() => showFolder.mutate()}>
              {fileBrowserName() ? `Show in ${fileBrowserName()}` : 'Show folder'}
            </Button>
          </div>
          {showFolder.isError && <FieldError>{describeError(showFolder.error)}</FieldError>}
        </div>
      </>
    );
  } else if (storage.isError) {
    body = (
      <ErrorState
        compact
        error={storage.error}
        title="Couldn’t measure the archive"
        onRetry={() => void storage.refetch()}
      />
    );
  } else {
    body = <LoadingState label="Measuring the archive…" className="py-6" />;
  }

  return (
    <Card id="storage" title="Storage" icon={<DatabaseIcon size={15} />}>
      {body}
      <div className="-mx-5 border-t border-line" />
      <CleanupRow />
      <div className="-mx-5 border-t border-line" />
      <BackupRow />
      <div className="-mx-5 border-t border-line" />
      <ImportBackupRow />
    </Card>
  );
}

function CleanupRow() {
  const [months, setMonths] = useState(12);
  const [confirming, setConfirming] = useState(false);
  const cleanup = useDeleteOldAttachments();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selectId = useId();
  const result = cleanup.data;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={selectId} className="text-[13.5px] font-medium text-ink">
        Delete downloaded attachments older than…
      </label>
      <p className="text-xs leading-relaxed text-ink-muted">
        Frees space on this computer. Messages are never deleted, and the archive still shows which files were shared.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          id={selectId}
          value={String(months)}
          onChange={(e) => setMonths(Number(e.target.value))}
          className="w-36"
        >
          {CLEANUP_MONTHS.map((m) => (
            <option key={m} value={m}>
              {monthsLabel(m)}
            </option>
          ))}
        </Select>
        <Button
          ref={buttonRef}
          variant="danger"
          icon={<TrashIcon size={14} />}
          onClick={() => {
            cleanup.reset();
            setConfirming(true);
          }}
        >
          Delete…
        </Button>
      </div>
      {result && (
        <p role="status" className="flex items-center gap-1.5 text-[13px] text-success">
          <CheckIcon size={14} />
          {result.filesRemoved === 0
            ? 'Nothing to delete: no downloaded attachments are that old.'
            : `Deleted ${pluralize(result.filesRemoved, 'attachment')}, freeing ${formatBytes(result.bytesFreed) || '0 B'}.`}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Delete attachments older than ${monthsLabel(months)}?`}
        description={`Downloaded attachments from more than ${monthsLabel(months)} ago are removed from this computer. Messages are never deleted. Slack no longer has files that old, so they can’t be downloaded again.`}
        confirmLabel="Delete attachments"
        destructive
        busy={cleanup.isPending}
        returnFocusRef={buttonRef}
        error={cleanup.isError ? describeError(cleanup.error) : null}
        onCancel={() => setConfirming(false)}
        onConfirm={() => cleanup.mutate(months, { onSuccess: () => setConfirming(false) })}
      />
    </div>
  );
}

function BackupRow() {
  const backup = useBackupNow();
  const result = backup.data;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13.5px] font-medium text-ink">Back up</p>
      <p className="text-xs leading-relaxed text-ink-muted">
        Saves a copy of the whole archive as one file in a folder you choose, for example on an external drive. It’s
        also how you move Slamem to another computer.
      </p>
      <div>
        <Button icon={<ArchiveIcon size={14} />} loading={backup.isPending} onClick={() => backup.mutate()}>
          Back up now
        </Button>
      </div>
      {result && (
        <p role="status" className="flex items-start gap-1.5 text-[13px] text-success">
          <CheckIcon size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-all">
            Backup saved ({formatBytes(result.bytes) || '0 B'}): {result.path}
          </span>
        </p>
      )}
      {backup.isError && <FieldError>{describeError(backup.error)}</FieldError>}
    </div>
  );
}

/** Moving from another computer: a backup made there is merged into this archive. */
function ImportBackupRow() {
  const restore = useImportBackup();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13.5px] font-medium text-ink">Import a backup</p>
      <p className="text-xs leading-relaxed text-ink-muted">
        Moving from another computer? Choose the backup you made there. Its messages and attachments are added to this
        archive (nothing here is lost or duplicated), and syncing carries on from where it stopped.
      </p>
      <div>
        <Button loading={restore.isPending} onClick={() => restore.mutate()}>
          Import a backup…
        </Button>
      </div>
      {restore.data && (
        <p role="status" className="flex items-start gap-1.5 text-[13px] text-success">
          <CheckIcon size={14} className="mt-0.5 shrink-0" />
          Importing the backup: you can follow it on the Archive page.
        </p>
      )}
      {restore.isError && <FieldError>{describeError(restore.error)}</FieldError>}
    </div>
  );
}
