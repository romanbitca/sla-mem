import { describeError } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useBackupNow, useImportBackup } from '../../lib/queries';
import { ArchiveIcon, CheckIcon } from '../icons';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { FieldError } from './fields';

/**
 * Backups: the whole archive as one file in a folder of the reader's choice, and bringing one in
 * from another computer.
 */
export function BackupCard() {
  return (
    <Card id="backup" title="Backup" icon={<ArchiveIcon size={15} />}>
      <BackupRow />
      <div className="-mx-5 border-t border-line" />
      <ImportBackupRow />
    </Card>
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
          Importing the backup: you can follow it on the Overview page.
        </p>
      )}
      {restore.isError && <FieldError>{describeError(restore.error)}</FieldError>}
    </div>
  );
}
