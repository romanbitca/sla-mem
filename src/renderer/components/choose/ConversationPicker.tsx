import { useId, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { ConversationDTO } from '../../../shared/types';
import { formatCount } from '../../lib/format';
import { ConversationIcon } from '../conversation/ConversationIcon';

export interface ConversationPickerProps {
  conversations: readonly ConversationDTO[];
  /** Conversations not to archive (unticked). */
  excluded: ReadonlySet<string>;
  onChange: (excluded: Set<string>) => void;
  /** Taller list for a dialog, shorter inline (onboarding). */
  size?: 'md' | 'lg';
}

interface Group {
  id: string;
  title: string;
  items: ConversationDTO[];
}

function groups(conversations: readonly ConversationDTO[], filter: string): Group[] {
  const needle = filter.trim().toLowerCase();
  const matches = (c: ConversationDTO) =>
    !needle || c.label.toLowerCase().includes(needle) || (c.rawName ?? '').toLowerCase().includes(needle);
  const byLabel = (a: ConversationDTO, b: ConversationDTO) => a.label.localeCompare(b.label);
  const visible = conversations.filter(matches);
  return [
    {
      id: 'channels',
      title: 'Channels',
      items: visible.filter((c) => c.type === 'channel' || c.type === 'private_channel').sort(byLabel),
    },
    { id: 'dms', title: 'Direct messages', items: visible.filter((c) => c.type === 'im').sort(byLabel) },
    { id: 'groups', title: 'Group DMs', items: visible.filter((c) => c.type === 'mpim').sort(byLabel) },
  ].filter((g) => g.items.length > 0);
}

/**
 * Which conversations to archive: every one is ticked by default; unticking one means sla-mem
 * never fetches its messages, threads or attachments. Grouped like the sidebar, with a filter and
 * All / None per group.
 */
export function ConversationPicker({ conversations, excluded, onChange, size = 'md' }: ConversationPickerProps) {
  const [filter, setFilter] = useState('');
  const filterId = useId();
  const shown = useMemo(() => groups(conversations, filter), [conversations, filter]);
  const archivedCount = conversations.filter((c) => !excluded.has(c.id)).length;

  const set = (ids: readonly string[], archive: boolean) => {
    const next = new Set(excluded);
    for (const id of ids) {
      if (archive) next.delete(id);
      else next.add(id);
    }
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <label htmlFor={filterId} className="sr-only">
          Filter conversations
        </label>
        <input
          id={filterId}
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter conversations"
          className="focus-ring h-8.5 min-w-0 flex-1 rounded-lg border border-line bg-raised px-2.5 text-[13px] text-ink placeholder:text-ink-faint"
        />
        <span role="status" className="shrink-0 text-xs text-ink-muted tabular-nums">
          {archivedCount.toLocaleString()} of {conversations.length.toLocaleString()} archived
        </span>
      </div>
      <div
        className={clsx(
          'scroll-thin overflow-y-auto rounded-xl border border-line',
          size === 'lg' ? 'max-h-[min(52vh,440px)]' : 'max-h-72',
        )}
      >
        {shown.length === 0 && (
          <p className="px-3 py-4 text-[13px] text-ink-muted">No conversations match “{filter.trim()}”.</p>
        )}
        {shown.map((group) => (
          <PickerGroup
            key={group.id}
            group={group}
            excluded={excluded}
            onSet={set}
            onToggle={(id) => set([id], excluded.has(id))}
          />
        ))}
      </div>
    </div>
  );
}

function PickerGroup({
  group,
  excluded,
  onSet,
  onToggle,
}: {
  group: Group;
  excluded: ReadonlySet<string>;
  onSet: (ids: readonly string[], archive: boolean) => void;
  onToggle: (id: string) => void;
}) {
  const headingId = useId();
  const ids = group.items.map((c) => c.id);
  return (
    <section aria-labelledby={headingId} className="border-b border-line last:border-b-0">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-inset px-3 py-1.5">
        <h3 id={headingId} className="flex-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
          {group.title}
        </h3>
        <button
          type="button"
          onClick={() => onSet(ids, true)}
          aria-label={`Archive all ${group.title.toLowerCase()}`}
          className="focus-ring rounded px-1.5 text-xs font-medium text-accent-text hover:underline"
        >
          All
        </button>
        <button
          type="button"
          onClick={() => onSet(ids, false)}
          aria-label={`Archive no ${group.title.toLowerCase()}`}
          className="focus-ring rounded px-1.5 text-xs font-medium text-accent-text hover:underline"
        >
          None
        </button>
      </div>
      <ul>
        {group.items.map((c) => (
          <PickerRow key={c.id} conversation={c} archived={!excluded.has(c.id)} onToggle={() => onToggle(c.id)} />
        ))}
      </ul>
    </section>
  );
}

function PickerRow({
  conversation: c,
  archived,
  onToggle,
}: {
  conversation: ConversationDTO;
  archived: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <li>
      <label
        htmlFor={id}
        className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[13.5px] transition-colors duration-100 hover:bg-hover/60"
      >
        <input
          id={id}
          type="checkbox"
          checked={archived}
          onChange={onToggle}
          className="size-4 shrink-0 accent-accent"
        />
        <span className={clsx('shrink-0', archived ? 'text-ink-muted' : 'text-ink-faint')}>
          <ConversationIcon conversation={c} size={14} />
        </span>
        <span
          className={clsx(
            'min-w-0 flex-1 truncate transition-colors duration-150',
            archived ? 'text-ink' : 'text-ink-faint line-through',
          )}
        >
          {c.label}
        </span>
        {c.messageCount > 0 && (
          <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">
            {formatCount(c.messageCount)} archived
          </span>
        )}
      </label>
    </li>
  );
}
