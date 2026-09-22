import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import clsx from 'clsx';
import type { ConversationDTO, SyncStatusDTO } from '../../../shared/types';
import { isAnswering, useAskChat } from '../../lib/askChat';
import { useDirectory } from '../../lib/directory';
import { formatCount } from '../../lib/format';
import { conversationPath } from '../../lib/links';
import { useConversations, useSettings, useWorkspace } from '../../lib/queries';
import { useLastSearch } from '../../lib/searchNav';
import { readJsonPref, writeJsonPref } from '../../lib/storage';
import { workspaceHost } from '../../lib/workspaceName';
import {
  ChevronDownIcon,
  CloseIcon,
  FilterIcon,
  HashIcon,
  LockIcon,
  OverviewIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  UsersIcon,
} from '../icons';
import { Avatar } from '../message/Avatar';
import { IconButton } from '../ui/IconButton';
import { Kbd, modKeyLabel } from '../ui/Kbd';
import { Spinner } from '../ui/Spinner';
import { SyncIndicator } from './SyncIndicator';

type SectionId = 'channels' | 'dms' | 'groups';

interface Section {
  id: SectionId;
  title: string;
  items: ConversationDTO[];
}

export function buildSections(conversations: readonly ConversationDTO[], filter: string): Section[] {
  const needle = filter.trim().toLowerCase();
  const matches = (c: ConversationDTO) =>
    !needle || c.label.toLowerCase().includes(needle) || (c.rawName ?? '').toLowerCase().includes(needle);
  const visible = conversations.filter(matches);
  const byLabel = (a: ConversationDTO, b: ConversationDTO) => a.label.localeCompare(b.label);
  return [
    {
      id: 'channels',
      title: 'Channels',
      items: visible.filter((c) => c.type === 'channel' || c.type === 'private_channel').sort(byLabel),
    },
    // DMs keep main's recency order (most recent first).
    { id: 'dms', title: 'Direct messages', items: visible.filter((c) => c.type === 'im') },
    { id: 'groups', title: 'Group DMs', items: visible.filter((c) => c.type === 'mpim') },
  ];
}

const COLLAPSE_KEY = 'sidebar.collapsed';

export interface SidebarProps {
  syncStatus: SyncStatusDTO | undefined;
  syncError: unknown;
  /** Present on narrow layouts where the sidebar is a drawer. */
  onClose?: () => void;
  className?: string;
  inert?: boolean;
}

export function Sidebar({ syncStatus, syncError, onClose, className, inert }: SidebarProps) {
  const workspace = useWorkspace().data;
  const conversations = useConversations();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readJsonPref(COLLAPSE_KEY, {}));
  const listRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const filtering = filter.trim() !== '';
  // Conversations left out of the archive show only while they still hold older messages.
  const excludedIds = useSettings().data?.preferences.excludedConversationIds;
  const excluded = useMemo(() => new Set(excludedIds ?? []), [excludedIds]);
  const shown = useMemo(
    () => (conversations.data ?? []).filter((c) => !excluded.has(c.id) || c.messageCount > 0),
    [conversations.data, excluded],
  );
  const sections = useMemo(() => buildSections(shown, filter), [shown, filter]);
  // Keyboard navigation walks what's visible: collapsed sections are skipped unless filtering.
  const flat = useMemo(
    () => sections.flatMap((s) => (filtering || !collapsed[s.id] ? s.items : [])),
    [sections, collapsed, filtering],
  );

  useEffect(() => setActiveIndex(-1), [filter]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-nav-index="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const toggleSection = (id: SectionId) => {
    // Saved outside the state updater: updaters must stay pure (StrictMode runs them twice).
    const next = { ...collapsed, [id]: !collapsed[id] };
    writeJsonPref(COLLAPSE_KEY, next);
    setCollapsed(next);
  };

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(-1, i - 1));
    } else if (e.key === 'Enter') {
      const target = flat[activeIndex >= 0 ? activeIndex : 0];
      if (target) {
        e.preventDefault();
        navigate(conversationPath(target.id));
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (filter) setFilter('');
      else e.currentTarget.blur();
    }
  };

  let navIndex = 0;
  const teamName = workspace?.teamName || 'Slamem';
  const host = workspaceHost(workspace?.teamDomain);
  // No Slack session saved: the footer points at Settings → Connect Slack.
  const needsConnection = workspace != null && !workspace.connected;

  return (
    <aside
      className={clsx('flex h-full flex-col border-r border-line bg-panel', className)}
      aria-label="Sidebar"
      inert={inert || undefined}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-ink">
          {teamName.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm leading-tight font-semibold text-ink">{teamName}</p>
          <p className="truncate text-[11px] leading-tight text-ink-faint">{host || 'Local archive'}</p>
        </div>
        {onClose && (
          <IconButton
            size="sm"
            label="Hide sidebar"
            icon={<CloseIcon size={16} />}
            onClick={onClose}
            className="lg:hidden"
          />
        )}
      </div>

      <nav className="flex flex-col gap-px px-2 pb-3" aria-label="Places">
        <NavLink to="/" end className={({ isActive }) => primaryNavClass(isActive)}>
          <OverviewIcon size={16} />
          Overview
        </NavLink>
        <SearchNavLink />
        <AskNavLink />
      </nav>

      {/* The conversations start here: set apart from the places above by a line. */}
      <div className="mx-3 border-t border-line pt-3 pb-2">
        <div className="relative">
          <FilterIcon
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-muted"
          />
          <input
            ref={filterRef}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder="Filter conversations"
            aria-label="Filter conversations"
            aria-controls="sidebar-conversations"
            aria-activedescendant={activeIndex >= 0 ? `sidebar-item-${activeIndex}` : undefined}
            className="focus-ring h-8 w-full rounded-md border border-line-strong bg-raised pr-8 pl-8 text-[13px] text-ink shadow-xs placeholder:text-ink-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear filter"
              title="Clear"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setFilter('');
                filterRef.current?.focus();
              }}
              className="focus-ring absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-ink-muted hover:bg-hover hover:text-ink"
            >
              <CloseIcon size={13} />
            </button>
          )}
        </div>
      </div>

      <nav
        ref={listRef}
        id="sidebar-conversations"
        aria-label="Conversations"
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      >
        {conversations.isPending && (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-ink-faint">
            <Spinner size={12} /> Loading conversations…
          </div>
        )}
        {conversations.isError && <p className="px-2 py-3 text-xs text-danger">Couldn’t load conversations.</p>}
        {conversations.data && flat.length === 0 && filtering && (
          <p className="px-2 py-3 text-xs text-ink-faint">No conversations match “{filter.trim()}”.</p>
        )}
        {conversations.data?.length === 0 && (
          <p className="px-2 py-3 text-xs text-ink-faint">No conversations archived yet.</p>
        )}
        {sections.map((section) => {
          if (section.items.length === 0) return null;
          const open = filtering || !collapsed[section.id];
          return (
            <SidebarSection
              key={section.id}
              title={section.title}
              count={section.items.length}
              open={open}
              onToggle={filtering ? undefined : () => toggleSection(section.id)}
            >
              {open &&
                section.items.map((c) => {
                  const index = navIndex++;
                  return (
                    <SidebarItem
                      key={c.id}
                      conversation={c}
                      index={index}
                      keyboardActive={index === activeIndex}
                      excluded={excluded.has(c.id)}
                    />
                  );
                })}
            </SidebarSection>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-1 border-t border-line px-2 py-2">
        <SyncIndicator status={syncStatus} error={syncError} needsConnection={needsConnection} />
        <NavLink
          to="/settings"
          aria-label="Settings"
          title="Settings"
          className={({ isActive }) =>
            clsx(
              'focus-ring inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150 hover:bg-hover hover:text-ink',
              isActive ? 'bg-hover text-ink' : 'text-ink-muted',
            )
          }
        >
          <SettingsIcon size={15} />
        </NavLink>
      </div>
    </aside>
  );
}

function primaryNavClass(isActive: boolean): string {
  return clsx(
    'focus-ring group/nav flex h-8 items-center gap-2.5 rounded-md px-2 text-sm font-medium transition-colors',
    isActive ? 'bg-accent-soft text-accent-text' : 'text-ink-muted hover:bg-hover hover:text-ink',
  );
}

/**
 * Search is a place, like Overview: it opens the search screen with the last search (its results,
 * filters and open message), or an empty one. ⌘K does the same from anywhere.
 */
function SearchNavLink() {
  const lastSearch = useLastSearch();
  return (
    <NavLink to={lastSearch} className={({ isActive }) => primaryNavClass(isActive)}>
      <SearchIcon size={16} />
      <span className="flex-1">Search</span>
      <span className="flex gap-0.5 opacity-70 transition-opacity group-hover/nav:opacity-100" aria-hidden="true">
        <Kbd>{modKeyLabel()}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </NavLink>
  );
}

/** Ask AI, with a spinner while an answer is being written (it keeps going on other screens). */
function AskNavLink() {
  const answering = isAnswering(useAskChat());
  return (
    <NavLink to="/ask" className={({ isActive }) => primaryNavClass(isActive)}>
      <SparklesIcon size={16} />
      <span className="flex-1">Ask AI</span>
      {answering && <Spinner size={12} label="Writing an answer" className="opacity-70" />}
    </NavLink>
  );
}

function SidebarSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-3 first:mt-1">
      <button
        type="button"
        onClick={onToggle}
        disabled={!onToggle}
        aria-expanded={open}
        className="focus-ring group/section flex h-7 w-full items-center gap-1 rounded-md px-1.5 text-left text-xs font-semibold text-ink-faint enabled:hover:text-ink-muted"
      >
        <ChevronDownIcon size={13} className={clsx('transition-transform duration-150', !open && '-rotate-90')} />
        <span className="flex-1">{title}</span>
        <span className="font-normal tabular-nums opacity-0 transition-opacity group-hover/section:opacity-100">
          {count}
        </span>
      </button>
      {open && <ul className="mt-0.5 flex flex-col gap-px">{children}</ul>}
    </div>
  );
}

const SidebarItem = memo(function SidebarItem({
  conversation: c,
  index,
  keyboardActive,
  excluded,
}: {
  conversation: ConversationDTO;
  index: number;
  keyboardActive: boolean;
  /** Left out of the archive in Settings (only older messages remain). */
  excluded: boolean;
}) {
  const dir = useDirectory();
  const dmUser = c.type === 'im' && c.dmUserId ? dir.users.get(c.dmUserId) : undefined;
  const dimmed = c.isArchived || dmUser?.deleted || excluded;
  return (
    <li>
      <NavLink
        to={conversationPath(c.id)}
        id={`sidebar-item-${index}`}
        data-nav-index={index}
        title={
          excluded ? `${c.label} (not archived any more)` : c.isArchived ? `${c.label} (archived channel)` : c.label
        }
        className={({ isActive }) =>
          clsx(
            'focus-ring group/item flex h-8 items-center gap-2 rounded-md px-2 text-[13.5px] transition-colors',
            isActive
              ? 'bg-accent-soft font-medium text-accent-text'
              : clsx('hover:bg-hover hover:text-ink', dimmed ? 'text-ink-faint' : 'text-ink-muted'),
            keyboardActive && !isActive && 'bg-hover text-ink ring-1 ring-line-strong',
          )
        }
      >
        <ItemIcon conversation={c} avatarUrl={dmUser?.avatarUrl ?? null} />
        <span className="min-w-0 flex-1 truncate">{c.label}</span>
        {c.messageCount > 0 && (
          <span className="shrink-0 text-[11px] text-ink-faint tabular-nums" aria-label={`${c.messageCount} messages`}>
            {formatCount(c.messageCount)}
          </span>
        )}
      </NavLink>
    </li>
  );
});

function ItemIcon({ conversation: c, avatarUrl }: { conversation: ConversationDTO; avatarUrl: string | null }) {
  switch (c.type) {
    case 'channel':
      return <HashIcon size={15} className="shrink-0 opacity-70" />;
    case 'private_channel':
      return <LockIcon size={14} className="shrink-0 opacity-70" />;
    case 'mpim':
      return <UsersIcon size={15} className="shrink-0 opacity-70" />;
    case 'im':
      return <Avatar seed={c.dmUserId ?? c.id} label={c.label} src={avatarUrl} size={18} />;
  }
}
