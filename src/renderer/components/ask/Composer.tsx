import { useLayoutEffect, type RefObject } from 'react';
import { ArrowUpIcon, StopIcon } from '../icons';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** An answer is being written: Stop replaces Send. */
  answering: boolean;
  disabled?: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

/** The question box: Enter asks, Shift+Enter starts a new line; it grows up to a few lines. */
export function Composer({ value, onChange, onSend, onStop, answering, disabled = false, inputRef }: ComposerProps) {
  const canSend = value.trim() !== '' && !answering && !disabled;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value, inputRef]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
      className="flex items-end gap-2 rounded-2xl border border-line bg-raised py-2 pr-2 pl-3.5 shadow-xs transition-colors focus-within:border-line-strong"
    >
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (canSend) onSend();
        }}
        placeholder="Ask about your messages, e.g. “Where did Ana mention the tests?”"
        aria-label="Question"
        spellCheck
        className="max-h-40 min-h-[26px] flex-1 resize-none bg-transparent py-1 text-[14.5px] leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:cursor-not-allowed"
      />
      {answering ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop"
          title="Stop"
          className="focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-ink text-canvas transition duration-150 ease-soft enabled:active:scale-[0.94]"
        >
          <StopIcon size={14} />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Ask"
          title="Ask (Enter)"
          className="focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-ink transition duration-150 ease-soft enabled:hover:bg-accent-hover enabled:active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowUpIcon size={16} strokeWidth={2} />
        </button>
      )}
    </form>
  );
}
