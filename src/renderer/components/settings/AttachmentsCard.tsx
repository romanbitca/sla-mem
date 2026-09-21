import { useId } from 'react';
import type { AttachmentPolicy } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { useFlag } from '../../lib/hooks';
import { useUpdatePreferences } from '../../lib/queries';
import { ATTACHMENT_OPTIONS } from '../connect/connection';
import { CheckIcon, FileIcon, InfoIcon } from '../icons';
import { Card } from '../ui/Card';
import { FieldError, RadioGroup } from './fields';

/** Which attachments to download (PLAN §8.4, §10.4–10.5). Saved as soon as it's changed. */
export function AttachmentsCard({ policy }: { policy: AttachmentPolicy }) {
  const update = useUpdatePreferences();
  const [saved, flashSaved] = useFlag(2000);
  const noteId = useId();
  return (
    <Card
      id="attachments"
      title="Attachments"
      icon={<FileIcon size={15} />}
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
      <RadioGroup
        legend="Which attachments to keep on this computer"
        value={policy}
        choices={ATTACHMENT_OPTIONS}
        describedBy={noteId}
        onChange={(attachmentPolicy) => update.mutate({ attachmentPolicy }, { onSuccess: flashSaved })}
      />
      <p id={noteId} className="flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
        <InfoIcon size={14} className="mt-px shrink-0 text-ink-faint" />
        <span>
          Skipped attachments can be downloaded later by choosing a bigger option — but only while Slack still has them.
          Slack keeps attachments for 90 days, so if in doubt, keep more.
        </span>
      </p>
      {update.isError && <FieldError>Couldn’t save: {describeError(update.error)}</FieldError>}
    </Card>
  );
}
