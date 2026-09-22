import { memo, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import type { PersonSummaryDTO, UserDTO } from '../../shared/types';
import { useDirectory } from '../lib/directory';
import { formatShortDate, pluralize } from '../lib/format';
import { useNow } from '../lib/hooks';
import { personPath } from '../lib/links';
import { peopleSections, type PeopleSectionId } from '../lib/people';
import { usePeople } from '../lib/queries';
import { tsToMs } from '../lib/ts';
import { timeAgo } from '../components/home/runs';
import { CloseIcon, FilterIcon, UsersIcon } from '../components/icons';
import { SidebarToggle } from '../components/layout/shell';
import { Avatar } from '../components/message/Avatar';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { LoadingState } from '../components/ui/Spinner';

// Kept while the window is open: coming back from someone's page finds the list as it was left.
let savedFilter = '';

/**
 * `/people`: everyone in the archive, in three groups: people you message (DMs and group DMs),
 * people you only see in channels, and people who left the workspace. Each opens their page.
 */
export default function PeoplePage() {
  const people = usePeople();
  const { users } = useDirectory();
  const now = useNow(60_000);
  const [filter, setFilterState] = useState(savedFilter);
  const inputRef = useRef<HTMLInputElement>(null);
  const setFilter = (value: string) => {
    savedFilter = value;
    setFilterState(value);
  };
  const sections = useMemo(() => peopleSections(people.data ?? [], users, filter), [people.data, users, filter]);
  const filtering = filter.trim() !== '';

  let body;
  if (people.isPending) body = <LoadingState label="Loading people…" />;
  else if (people.isError)
    body = <ErrorState error={people.error} title="Couldn’t load people" onRetry={() => void people.refetch()} />;
  else if (people.data.length === 0)
    body = (
      <EmptyState
        icon={<UsersIcon size={20} />}
        title="No one here yet"
        description="People appear once the first sync brings in messages."
      />
    );
  else
    body = (
      <>
        {sections.length === 0 && <p className="px-3 text-sm text-ink-muted">No one matches “{filter.trim()}”.</p>}
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={`people-${section.id}`}>
            <h2
              id={`people-${section.id}`}
              className="flex items-baseline gap-2 px-3 pb-1.5 text-xs font-semibold text-ink-faint"
            >
              {section.title}
              <span className="font-normal tabular-nums">{section.people.length}</span>
            </h2>
            <ul className="flex flex-col gap-px">
              {section.people.map((p) => (
                <li key={p.userId}>
                  <PersonRow person={p} user={users.get(p.userId)} section={section.id} now={now} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </>
    );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 animate-page-in flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <SidebarToggle />
        <h1 className="text-[15px] font-semibold text-ink">People</h1>
        {people.data && people.data.length > 0 && (
          <span className="text-xs text-ink-faint tabular-nums">{people.data.length.toLocaleString()}</span>
        )}
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
          {people.data && people.data.length > 0 && (
            <div className="relative px-3">
              <FilterIcon
                size={14}
                className="pointer-events-none absolute top-1/2 left-5.5 -translate-y-1/2 text-ink-muted"
              />
              <input
                ref={inputRef}
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && filter) {
                    e.preventDefault();
                    setFilter('');
                  }
                }}
                placeholder="Filter by name or title"
                aria-label="Filter people"
                className="focus-ring h-9 w-full rounded-lg border border-line-strong bg-raised pr-9 pl-8 text-sm text-ink shadow-xs placeholder:text-ink-muted [&::-webkit-search-cancel-button]:hidden"
              />
              {filtering && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  title="Clear"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setFilter('');
                    inputRef.current?.focus();
                  }}
                  className="focus-ring absolute top-1/2 right-4.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-ink-muted hover:bg-hover hover:text-ink"
                >
                  <CloseIcon size={13} />
                </button>
              )}
            </div>
          )}
          {body}
        </div>
      </div>
    </section>
  );
}

/** Talked (DM or group DM) for people you message; their latest message for everyone else. */
function detail(p: PersonSummaryDTO, section: PeopleSectionId, now: number): string {
  const when = (ts: string) => {
    const ms = tsToMs(ts);
    // Relative for the last weeks ("2 days ago"), a date beyond.
    return now - ms < 30 * 86_400_000 ? timeAgo(ms, now) : formatShortDate(new Date(ms));
  };
  if (section === 'talk' && p.lastTalkedTs) {
    const dm = p.dmMessageCount > 0 ? ` · ${pluralize(p.dmMessageCount, 'direct message')}` : ' · in a group DM';
    return `Talked ${when(p.lastTalkedTs)}${dm}`;
  }
  if (p.lastMessageTs) return `Wrote ${when(p.lastMessageTs)} · ${pluralize(p.messageCount, 'message')}`;
  return p.lastTalkedTs ? `Talked ${when(p.lastTalkedTs)}` : '';
}

const PersonRow = memo(function PersonRow({
  person: p,
  user,
  section,
  now,
}: {
  person: PersonSummaryDTO;
  user: UserDTO | undefined;
  section: PeopleSectionId;
  now: number;
}) {
  const label = user?.label ?? p.userId;
  return (
    <Link
      to={personPath(p.userId)}
      className="focus-ring group/person flex items-center gap-3 rounded-xl px-3 py-2 transition-colors duration-150 hover:bg-hover/70"
    >
      <Avatar seed={p.userId} label={label} src={user?.avatarUrl ?? null} size={36} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2 leading-tight">
          <span
            className={clsx('truncate text-[14px] font-semibold', section === 'left' ? 'text-ink-muted' : 'text-ink')}
          >
            {label}
          </span>
          {p.title && <span className="truncate text-[13px] text-ink-muted">{p.title}</span>}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-faint">{detail(p, section, now)}</p>
      </div>
    </Link>
  );
});
