import type { AiScopeDTO } from '../../../shared/types';
import { hasScope, NO_SCOPE } from '../../lib/askChat';
import { useDirectory, type Directory } from '../../lib/directory';
import { useConversations, useUsers, useWorkspace } from '../../lib/queries';
import { conversationTitle } from '../conversation/ConversationIcon';
import { CalendarIcon, HashIcon, UserIcon } from '../icons';
import { dateRangeLabel } from '../search/dateRange';
import { DateRangePanel } from '../search/DateRangePanel';
import { ConversationPicker, PersonPicker, summarize } from '../search/FilterBar';
import { FilterChip } from '../search/FilterChip';

/**
 * What the next questions are limited to, under the question box: conversations ("In"), who
 * wrote the messages ("From") and when ("Date"), picked the same way as on the search screen.
 * Claude is told, and its tools can't look outside them, so answers come quicker and cheaper.
 */
export function ScopeBar({ scope, onChange }: { scope: AiScopeDTO; onChange: (scope: AiScopeDTO) => void }) {
  const dir = useDirectory();
  const conversations = useConversations().data;
  const users = useUsers().data;
  const selfUserId = useWorkspace().data?.selfUserId ?? null;
  const labels = scopeLabels(scope, dir, selfUserId);

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Limit the question">
      <FilterChip
        label="In"
        placement="above"
        value={summarize(labels.conversations)}
        icon={<HashIcon size={14} />}
        onClear={() => onChange({ ...scope, conversationIds: [] })}
      >
        {({ close }) => (
          <ConversationPicker
            conversations={conversations}
            selected={scope.conversationIds}
            onChange={(ids) => onChange({ ...scope, conversationIds: ids })}
            onDone={close}
          />
        )}
      </FilterChip>
      <FilterChip
        label="From"
        placement="above"
        value={summarize(labels.people)}
        icon={<UserIcon size={14} />}
        onClear={() => onChange({ ...scope, userIds: [] })}
      >
        {({ close }) => (
          <PersonPicker
            users={users}
            selfUserId={selfUserId}
            selected={scope.userIds}
            onChange={(ids) => onChange({ ...scope, userIds: ids })}
            onDone={close}
          />
        )}
      </FilterChip>
      <FilterChip
        label="Date"
        placement="above"
        value={labels.dates}
        icon={<CalendarIcon size={14} />}
        onClear={() => onChange({ ...scope, after: null, before: null })}
        panelClassName="w-72"
      >
        {({ close }) => (
          <DateRangePanel
            value={{ after: scope.after, before: scope.before }}
            onApply={(range) => {
              onChange({ ...scope, after: range.after, before: range.before });
              close();
            }}
          />
        )}
      </FilterChip>
      {hasScope(scope) && (
        <button
          type="button"
          onClick={() => onChange(NO_SCOPE)}
          className="focus-ring rounded-md px-1.5 py-1 text-[13px] font-medium text-accent-text hover:underline"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function scopeLabels(scope: AiScopeDTO, dir: Directory, selfUserId: string | null) {
  return {
    conversations: scope.conversationIds.map((id) => {
      const conversation = dir.conversations.get(id);
      return conversation ? conversationTitle(conversation) : id;
    }),
    people: scope.userIds.map((id) => (id === selfUserId ? 'You' : (dir.users.get(id)?.label ?? id))),
    dates: dateRangeLabel({ after: scope.after, before: scope.before }),
  };
}

/** "In #eng +1 · From Ana · Sep 14 – Sep 20": what a question was limited to, under it. */
export function ScopeSummary({ scope }: { scope: AiScopeDTO }) {
  const dir = useDirectory();
  const selfUserId = useWorkspace().data?.selfUserId ?? null;
  const labels = scopeLabels(scope, dir, selfUserId);
  const parts = [
    labels.conversations.length ? `In ${summarize(labels.conversations)}` : null,
    labels.people.length ? `From ${summarize(labels.people)}` : null,
    labels.dates,
  ].filter(Boolean);
  return <p className="text-right text-[11.5px] text-ink-faint">{parts.join(' · ')}</p>;
}
