import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button } from '../ui/Button';

export interface PickerOption {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  /** Group heading shown when the list isn't filtered. */
  section?: string;
  dimmed?: boolean;
}

export interface MultiSelectPickerProps {
  options: readonly PickerOption[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  onDone: () => void;
  filterLabel: string;
  emptyText: string;
  loading?: boolean;
}

/** Rendering thousands of rows in a popover is wasted work: typing narrows it instead. */
const MAX_VISIBLE = 150;

interface Group {
  title: string | null;
  items: PickerOption[];
}

function groupOptions(options: readonly PickerOption[], selected: readonly string[], filtering: boolean): Group[] {
  if (filtering) return [{ title: null, items: [...options] }];
  // Unfiltered: what's selected comes first so it's easy to review and untick.
  const chosen = options.filter((o) => selected.includes(o.id));
  const rest = options.filter((o) => !selected.includes(o.id));
  const groups: Group[] = chosen.length ? [{ title: 'Selected', items: chosen }] : [];
  for (const option of rest) {
    const title = option.section ?? null;
    const last = groups[groups.length - 1];
    if (last && last.title === title && last.title !== 'Selected') last.items.push(option);
    else groups.push({ title, items: [option] });
  }
  return groups;
}

function matches(option: PickerOption, needle: string): boolean {
  return (
    option.label.toLowerCase().includes(needle) ||
    (option.detail ?? '').toLowerCase().includes(needle) ||
    option.id.toLowerCase() === needle
  );
}

/** Filterable checkbox list. Changes apply immediately; the parent decides how to record them. */
export function MultiSelectPicker({
  options,
  selected,
  onChange,
  onDone,
  filterLabel,
  emptyText,
  loading = false,
}: MultiSelectPickerProps) {
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const needle = filter.trim().toLowerCase();

  const visible = useMemo(() => (needle ? options.filter((o) => matches(o, needle)) : options), [options, needle]);
  const groups = useMemo(
    () => groupOptions(visible.slice(0, MAX_VISIBLE), selected, needle !== ''),
    [visible, selected, needle],
  );

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  const checkboxes = () => Array.from(listRef.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []);

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      checkboxes()[0]?.focus();
    } else if (e.key === 'Enter') {
      // Enter picks the best match, the quickest path for "type a name, hit Enter".
      e.preventDefault();
      if (visible[0]) toggle(visible[0].id);
    }
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const boxes = checkboxes();
    const index = boxes.indexOf(e.target as HTMLInputElement);
    if (index < 0) return;
    e.preventDefault();
    const next = index + (e.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) listRef.current?.parentElement?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    else boxes[Math.min(next, boxes.length - 1)]?.focus();
  };

  return (
    <div className="flex flex-col">
      <div className="border-b border-line p-2">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKeyDown}
          placeholder={filterLabel}
          aria-label={filterLabel}
          autoFocus
          className="focus-ring h-8 w-full rounded-md border border-line bg-canvas px-2.5 text-[13px] text-ink placeholder:text-ink-faint"
        />
      </div>
      <div ref={listRef} onKeyDown={onListKeyDown} className="scroll-thin max-h-72 overflow-y-auto p-1">
        {loading && <p className="px-2.5 py-3 text-[13px] text-ink-muted">Loading…</p>}
        {!loading && visible.length === 0 && <p className="px-2.5 py-3 text-[13px] text-ink-muted">{emptyText}</p>}
        {groups.map((group, gi) => (
          <div key={`${group.title ?? ''}:${gi}`} role="group" aria-labelledby={group.title ? `${baseId}-g${gi}` : undefined}>
            {group.title && (
              <p
                id={`${baseId}-g${gi}`}
                className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase"
              >
                {group.title}
              </p>
            )}
            {group.items.map((option) => {
              const checked = selected.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={clsx(
                    'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-hover has-[:focus-visible]:bg-hover',
                    option.dimmed && !checked ? 'text-ink-faint' : 'text-ink',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(option.id)}
                    // The row also holds an avatar/icon; name the box by its text only.
                    aria-label={option.detail ? `${option.label} (${option.detail})` : option.label}
                    className="size-3.5 shrink-0 accent-accent"
                  />
                  {option.icon && <span className="flex shrink-0 items-center text-ink-muted">{option.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.detail && <span className="shrink-0 truncate text-xs text-ink-faint">{option.detail}</span>}
                </label>
              );
            })}
          </div>
        ))}
        {visible.length > MAX_VISIBLE && (
          <p className="px-2.5 py-2 text-xs text-ink-faint">
            Showing {MAX_VISIBLE} of {visible.length}. Type to narrow the list.
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line p-2">
        <Button size="sm" variant="ghost" disabled={selected.length === 0} onClick={() => onChange([])}>
          Clear
        </Button>
        <Button size="sm" variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
