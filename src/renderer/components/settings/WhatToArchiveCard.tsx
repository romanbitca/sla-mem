import { useRef, useState } from 'react';
import type { ConversationDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { joinNames, pluralize } from '../../lib/format';
import { useConversations, useDeleteExcludedArchives, useUpdatePreferences } from '../../lib/queries';
import { ConversationPicker } from '../choose/ConversationPicker';
import { conversationTitle } from '../conversation/ConversationIcon';
import { ListIcon } from '../icons';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ConfirmDialog, Dialog } from '../ui/Dialog';
import { FieldError } from './fields';

const NAMES_SHOWN = 5;

/**
 * Settings → What to archive: conversations can be left out (a channel, or the DMs with someone),
 * and sla-mem then never fetches their messages, threads or attachments. What was archived
 * before stays unless the reader chooses to delete it, which is asked, never assumed.
 */
export function WhatToArchiveCard({ excludedIds }: { excludedIds: readonly string[] }) {
  const conversations = useConversations();
  const update = useUpdatePreferences();
  const remove = useDeleteExcludedArchives();
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [offerDelete, setOfferDelete] = useState<string[] | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  const list = conversations.data ?? [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const excluded = excludedIds.map((id) => byId.get(id)).filter((c): c is ConversationDTO => c != null);
  const stillArchived = excluded.filter((c) => c.messageCount > 0);

  const save = () => {
    if (!draft) return;
    const next = [...draft].sort();
    const newlyWithMessages = next.filter((id) => !excludedIds.includes(id) && (byId.get(id)?.messageCount ?? 0) > 0);
    update.mutate(
      { excludedConversationIds: next },
      {
        onSuccess: () => {
          setDraft(null);
          if (newlyWithMessages.length) setOfferDelete(newlyWithMessages);
        },
      },
    );
  };

  const offered = (offerDelete ?? []).map((id) => byId.get(id)).filter((c): c is ConversationDTO => c != null);
  const offeredMessages = offered.reduce((n, c) => n + c.messageCount, 0);

  return (
    <Card id="what-to-archive" title="What to archive" icon={<ListIcon size={15} />}>
      <div className="flex flex-col gap-3">
        {excluded.length === 0 ? (
          <p className="text-[13.5px] text-ink-muted">Every conversation you’re in is archived.</p>
        ) : (
          <p className="text-[13.5px] leading-relaxed text-ink-muted">
            {pluralize(excluded.length, 'conversation isn’t', 'conversations aren’t')} archived:{' '}
            <span className="text-ink">{joinNames(excluded.map(conversationTitle), NAMES_SHOWN)}</span>.
          </p>
        )}
        {stillArchived.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-muted">
            <span>{stillInArchive(stillArchived.reduce((n, c) => n + c.messageCount, 0))}</span>
            <Button size="sm" onClick={() => setOfferDelete(stillArchived.map((c) => c.id))}>
              Delete them…
            </Button>
          </p>
        )}
        <div>
          <Button ref={openerRef} onClick={() => setDraft(new Set(excludedIds))} disabled={!conversations.data}>
            Choose conversations…
          </Button>
        </div>
        {conversations.isError && (
          <FieldError>Couldn’t load your conversations: {describeError(conversations.error)}</FieldError>
        )}
      </div>

      <Dialog
        open={draft != null}
        onClose={() => setDraft(null)}
        title="What to archive"
        description="Untick a conversation to stop archiving it: sla-mem won’t fetch its messages, threads or attachments."
        returnFocusRef={openerRef}
        className="max-w-xl"
        footer={
          <>
            <Button onClick={() => setDraft(null)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={update.isPending} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        {draft && <ConversationPicker conversations={list} excluded={draft} onChange={setDraft} size="lg" />}
        {update.isError && <FieldError>Couldn’t save: {describeError(update.error)}</FieldError>}
      </Dialog>

      <ConfirmDialog
        open={offerDelete != null}
        title="Delete what’s already archived?"
        description={`${joinNames(offered.map(conversationTitle), NAMES_SHOWN)} already ${
          offered.length === 1 ? 'has' : 'have'
        } ${pluralize(offeredMessages, 'message', 'messages')} in the archive. sla-mem won’t add to ${
          offered.length === 1 ? 'it' : 'them'
        } any more. Delete what’s there too? This can’t be undone.`}
        confirmLabel="Delete"
        cancelLabel="Keep it"
        destructive
        busy={remove.isPending}
        error={remove.isError ? describeError(remove.error) : null}
        onConfirm={() => remove.mutate(offerDelete ?? [], { onSuccess: () => setOfferDelete(null) })}
        onCancel={() => setOfferDelete(null)}
        returnFocusRef={openerRef}
      />
    </Card>
  );
}

function stillInArchive(messages: number): string {
  return `${pluralize(messages, 'message', 'messages')} from before ${messages === 1 ? 'is' : 'are'} still in the archive.`;
}
