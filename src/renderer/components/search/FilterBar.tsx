import { useMemo, type ComponentType } from 'react';
import clsx from 'clsx';
import type { ConversationDTO, SearchHas, UserDTO } from '../../../shared/types';
import { useDirectory } from '../../lib/directory';
import { ConversationIcon, conversationTitle } from '../conversation/ConversationIcon';
import { buildSections } from '../layout/Sidebar';
import {
  CalendarIcon,
  FileIcon,
  HashIcon,
  ImageIcon,
  LinkIcon,
  SmileIcon,
  ThreadIcon,
  UserIcon,
  type IconProps,
} from '../icons';
import { Avatar } from '../message/Avatar';
import { dateRangeLabel } from './dateRange';
import { DateRangePanel } from './DateRangePanel';
import { FilterChip, type EditMode } from './FilterChip';
import { MultiSelectPicker, type PickerOption } from './MultiSelectPicker';
import { HAS_VALUES, type QueryFilters, type ResolverData } from './resolve';
import {
  clearFilters,
  setConversationFilter,
  setDateFilter,
  setHasFilter,
  setUserFilter,
  type SearchUrlState,
} from './searchUrl';

export type SearchNavigate = (next: SearchUrlState, mode?: EditMode) => void;

export interface FilterBarProps {
  state: SearchUrlState;
  /** Explicit params plus modifiers typed in the query. */
  effective: QueryFilters;
  /** Directory lists; null while they load. */
  data: ResolverData | null;
  onChange: SearchNavigate;
}

const HAS_META: Record<SearchHas, { label: string; icon: ComponentType<IconProps> }> = {
  file: { label: 'Files', icon: FileIcon },
  link: { label: 'Links', icon: LinkIcon },
  image: { label: 'Images', icon: ImageIcon },
  reaction: { label: 'Reactions', icon: SmileIcon },
  thread: { label: 'Threads', icon: ThreadIcon },
};

/** "#general", "#general +2". */
function summarize(labels: string[]): string | null {
  if (labels.length === 0) return null;
  return labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1}`;
}

export function FilterBar({ state, effective, data, onChange }: FilterBarProps) {
  const dir = useDirectory();
  const hasAny =
    effective.conversation.length > 0 ||
    effective.user.length > 0 ||
    effective.has.length > 0 ||
    effective.after != null ||
    effective.before != null;

  const conversationLabels = effective.conversation.map((id) => {
    const conv = dir.conversations.get(id);
    return conv ? conversationTitle(conv) : id;
  });
  const userLabels = effective.user.map((id) => dir.users.get(id)?.label ?? id);
  const dateLabel = dateRangeLabel(effective);

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
      <FilterChip
        label="In"
        value={summarize(conversationLabels)}
        icon={<HashIcon size={14} />}
        onClear={() => onChange(setConversationFilter(state, [], data))}
      >
        {({ close, nextEdit }) => (
          <ConversationPicker
            conversations={data?.conversations}
            selected={effective.conversation}
            onChange={(ids) => onChange(setConversationFilter(state, ids, data), nextEdit())}
            onDone={close}
          />
        )}
      </FilterChip>

      <FilterChip
        label="From"
        value={summarize(userLabels)}
        icon={<UserIcon size={14} />}
        onClear={() => onChange(setUserFilter(state, [], data))}
      >
        {({ close, nextEdit }) => (
          <PersonPicker
            users={data?.users}
            selfUserId={data?.selfUserId ?? null}
            selected={effective.user}
            onChange={(ids) => onChange(setUserFilter(state, ids, data), nextEdit())}
            onDone={close}
          />
        )}
      </FilterChip>

      <FilterChip
        label="Date"
        value={dateLabel}
        icon={<CalendarIcon size={14} />}
        onClear={() => onChange(setDateFilter(state, { after: null, before: null }, data))}
        panelClassName="w-72"
      >
        {({ close }) => (
          <DateRangePanel
            value={{ after: effective.after, before: effective.before }}
            onApply={(range) => {
              onChange(setDateFilter(state, range, data));
              close();
            }}
          />
        )}
      </FilterChip>

      <span className="mx-0.5 hidden h-5 w-px bg-line sm:block" aria-hidden="true" />

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Has">
        {HAS_VALUES.map((has) => {
          const { label, icon: Icon } = HAS_META[has];
          const pressed = effective.has.includes(has);
          return (
            <button
              key={has}
              type="button"
              aria-pressed={pressed}
              title={pressed ? `Showing only messages with ${label.toLowerCase()}` : `Only messages with ${label.toLowerCase()}`}
              onClick={() =>
                onChange(setHasFilter(state, pressed ? effective.has.filter((h) => h !== has) : [...effective.has, has], data))
              }
              className={clsx(
                'focus-ring inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors',
                pressed
                  ? 'border-accent/35 bg-accent-soft font-medium text-accent-text'
                  : 'border-line bg-raised text-ink-muted hover:border-line-strong hover:text-ink',
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          );
        })}
      </div>

      {hasAny && (
        <button
          type="button"
          onClick={() => onChange(clearFilters(state, data))}
          className="focus-ring ml-1 rounded-md px-1.5 py-1 text-[13px] font-medium text-accent-text hover:underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function ConversationPicker({
  conversations,
  selected,
  onChange,
  onDone,
}: {
  conversations: readonly ConversationDTO[] | undefined;
  selected: string[];
  onChange: (ids: string[]) => void;
  onDone: () => void;
}) {
  const options = useMemo<PickerOption[]>(
    () =>
      buildSections(conversations ?? [], '').flatMap((section) =>
        section.items.map((c) => ({
          id: c.id,
          label: conversationTitle(c),
          detail: c.isArchived ? 'archived' : undefined,
          icon: <ConversationIcon conversation={c} size={14} />,
          section: section.title,
          dimmed: c.isArchived,
        })),
      ),
    [conversations],
  );
  return (
    <MultiSelectPicker
      options={options}
      selected={selected}
      onChange={onChange}
      onDone={onDone}
      filterLabel="Find a channel or conversation"
      emptyText="No conversations match."
      loading={!conversations}
    />
  );
}

/** People first, then apps, then deactivated accounts. */
function personRank(u: UserDTO): number {
  return u.deleted ? 2 : u.isBot ? 1 : 0;
}

function PersonPicker({
  users,
  selfUserId,
  selected,
  onChange,
  onDone,
}: {
  users: readonly UserDTO[] | undefined;
  selfUserId: string | null;
  selected: string[];
  onChange: (ids: string[]) => void;
  onDone: () => void;
}) {
  const options = useMemo<PickerOption[]>(
    () =>
      [...(users ?? [])]
        .sort((a, b) => personRank(a) - personRank(b) || a.label.localeCompare(b.label))
        .map((u) => ({
          id: u.id,
          label: u.id === selfUserId ? `${u.label} (you)` : u.label,
          detail: u.deleted ? 'deactivated' : u.isBot ? 'app' : u.name ? `@${u.name}` : undefined,
          icon: <Avatar seed={u.id} label={u.label} src={u.avatarUrl} size={18} />,
          section: ['People', 'Apps', 'Deactivated'][personRank(u)],
          dimmed: u.deleted,
        })),
    [users, selfUserId],
  );
  return (
    <MultiSelectPicker
      options={options}
      selected={selected}
      onChange={onChange}
      onDone={onDone}
      filterLabel="Find a person"
      emptyText="No one matches."
      loading={!users}
    />
  );
}
