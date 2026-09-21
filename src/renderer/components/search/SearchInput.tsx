import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import clsx from 'clsx';
import type { ConversationDTO, UserDTO } from '../../../shared/types';
import { ConversationIcon } from '../conversation/ConversationIcon';
import {
  CalendarIcon,
  CloseIcon,
  FileIcon,
  HashIcon,
  SearchIcon,
  ThreadIcon,
  UserIcon,
} from '../icons';
import { Avatar } from '../message/Avatar';
import { Kbd } from '../ui/Kbd';
import { applySuggestion, getAutocomplete, type AutocompleteSource, type Suggestion } from './autocomplete';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Directory lists for people/conversation suggestions (null while loading). */
  source: AutocompleteSource | null;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  /** ArrowDown with no suggestions open: move focus into the results. */
  onExitDown?: () => void;
}

const NO_SOURCE: AutocompleteSource = { users: [], conversations: [], selfUserId: null };

/**
 * Search box with Slack-style modifier completion (ARIA combobox). Enter searches unless a
 * suggestion is highlighted; Tab or Enter accepts one; Esc dismisses the list.
 */
export function SearchInput({ value, onChange, onSubmit, source, inputRef, autoFocus, onExitDown }: SearchInputProps) {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  const listId = useId();
  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState(false);
  const pendingCaret = useRef<number | null>(null);

  const completion = useMemo(
    () => (open ? getAutocomplete(value, Math.min(caret, value.length), source ?? NO_SOURCE) : null),
    [open, value, caret, source],
  );
  const suggestions = completion?.suggestions ?? [];
  const visible = suggestions.length > 0;

  // A new suggestion list starts with its default highlight (first item only when it's the
  // obvious completion; otherwise Enter must still search).
  const listKey = completion ? `${completion.start}:${suggestions.map((s) => s.id).join('|')}` : '';
  const [active, setActive] = useState(-1);
  const [activeFor, setActiveFor] = useState(listKey);
  if (activeFor !== listKey) {
    setActiveFor(listKey);
    setActive(completion?.autoSelect ? 0 : -1);
  }

  useLayoutEffect(() => {
    if (pendingCaret.current == null || !ref.current) return;
    ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const accept = (suggestion: Suggestion) => {
    if (!completion) return;
    const next = applySuggestion(value, completion, suggestion);
    onChange(next.value);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
    setOpen(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (visible) setActive((i) => (i + 1) % suggestions.length);
        else onExitDown?.();
        break;
      case 'ArrowUp':
        if (!visible) return;
        e.preventDefault();
        setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
        break;
      case 'Enter':
        // Enter that confirms an IME composition must not search.
        if (e.nativeEvent.isComposing) return;
        // Handled here rather than via implicit form submission so the two can't both fire.
        e.preventDefault();
        if (visible && active >= 0) {
          accept(suggestions[active]);
        } else {
          setOpen(false);
          onSubmit(value);
        }
        break;
      case 'Tab':
        if (visible && !e.shiftKey) {
          e.preventDefault();
          accept(suggestions[Math.max(active, 0)]);
        }
        break;
      case 'Escape':
        if (visible) {
          e.preventDefault();
          setOpen(false);
        }
        break;
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <form
      role="search"
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(false);
        onSubmit(value);
      }}
    >
      <SearchIcon size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-faint" />
      <input
        ref={ref}
        type="search"
        role="combobox"
        aria-label="Search messages"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={visible && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        autoFocus={autoFocus}
        placeholder="Search messages, or try from:, in:, has:, before:…"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? value.length)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="focus-ring h-11 w-full rounded-xl border border-line bg-raised pr-11 pl-10 text-[15px] text-ink shadow-xs placeholder:text-ink-faint [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search text"
          title="Clear"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange('');
            setCaret(0);
            setOpen(true);
            ref.current?.focus();
          }}
          className="focus-ring absolute top-1/2 right-2.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
        >
          <CloseIcon size={15} />
        </button>
      )}
      <div
        id={listId}
        role="listbox"
        aria-label={completion?.title ?? 'Suggestions'}
        hidden={!visible}
        className="absolute inset-x-0 top-full z-40 mt-1.5 animate-pop-in overflow-hidden rounded-xl border border-line bg-raised shadow-pop"
      >
        {visible && (
          <>
            <p className="px-3.5 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase" aria-hidden="true">
              {completion!.title}
            </p>
            <ul className="scroll-thin max-h-80 overflow-y-auto px-1.5 pb-1.5">
              {suggestions.map((s, i) => (
                <li
                  key={s.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  // Keep focus in the input so typing continues after a click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => accept(s)}
                  className={clsx(
                    'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px]',
                    i === active ? 'bg-accent-soft text-accent-text' : 'text-ink',
                  )}
                >
                  <SuggestionIcon suggestion={s} source={source} />
                  <span className="min-w-0 truncate font-medium">{s.label}</span>
                  {s.detail && <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{s.detail}</span>}
                  {(s.kind === 'user' || s.kind === 'conversation') && (
                    <code className="ml-auto hidden shrink-0 font-mono text-[11px] text-ink-faint sm:inline">{s.insert}</code>
                  )}
                </li>
              ))}
            </ul>
            <p className="flex items-center gap-3 border-t border-line px-3.5 py-1.5 text-[11px] text-ink-faint" aria-hidden="true">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> to move
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Tab</Kbd> to pick
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Esc</Kbd> to dismiss
              </span>
            </p>
          </>
        )}
      </div>
    </form>
  );
}

function SuggestionIcon({ suggestion, source }: { suggestion: Suggestion; source: AutocompleteSource | null }) {
  const box = 'flex size-6 shrink-0 items-center justify-center rounded-md bg-inset text-ink-muted';
  if (suggestion.kind === 'user') {
    const user: UserDTO | undefined = source?.users.find((u) => u.id === suggestion.userId);
    return <Avatar seed={suggestion.userId} label={user?.label ?? suggestion.label} src={user?.avatarUrl} size={24} />;
  }
  if (suggestion.kind === 'conversation') {
    const conv: ConversationDTO | undefined = source?.conversations.find((c) => c.id === suggestion.conversationId);
    return <span className={box}>{conv ? <ConversationIcon conversation={conv} size={14} /> : <HashIcon size={14} />}</span>;
  }
  const key = suggestion.insert.split(':')[0];
  const Icon =
    key === 'from' ? UserIcon : key === 'in' ? HashIcon : key === 'has' ? FileIcon : key === 'is' ? ThreadIcon : CalendarIcon;
  return (
    <span className={box}>
      <Icon size={14} />
    </span>
  );
}
