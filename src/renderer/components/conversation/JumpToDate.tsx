import { useState, type FormEvent } from 'react';
import { api, describeError } from '../../lib/api';
import { usePopover } from '../../lib/hooks';
import { isValidTs, parseLocalDate, toLocalDateInput, tsJustBefore, tsToDate } from '../../lib/ts';
import { CalendarIcon } from '../icons';
import { Button } from '../ui/Button';

/** Before any plausible Slack message; `after` needs a well-formed ts. */
const EPOCH_TS = '000000000.000000';

/**
 * The first top-level message posted on or after local midnight of `date`, found without search:
 * `after=<just before midnight>&limit=1` returns exactly that message.
 */
export async function firstMessageOnOrAfter(conversationId: string, date: Date | null): Promise<string | null> {
  const after = date && date.getTime() > 1000 ? tsJustBefore(date) : EPOCH_TS;
  const page = await api.getMessages(conversationId, { after, limit: 1 });
  return page.messages[0]?.ts ?? null;
}

export interface JumpToDateProps {
  conversationId: string;
  oldestTs: string | null;
  latestTs: string | null;
  /** Called with the ts to jump to (the view then loads `around` it). */
  onJump: (ts: string) => void;
}

export function JumpToDate({ conversationId, oldestTs, latestTs, onJump }: JumpToDateProps) {
  const { open, setOpen, toggle, containerRef } = usePopover<HTMLDivElement>();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const min = isValidTs(oldestTs) ? toLocalDateInput(tsToDate(oldestTs)) : undefined;
  const max = isValidTs(latestTs) ? toLocalDateInput(tsToDate(latestTs)) : undefined;

  const jump = async (date: Date | null) => {
    setBusy(true);
    setError(null);
    try {
      const ts = await firstMessageOnOrAfter(conversationId, date);
      if (ts) {
        setOpen(false);
        onJump(ts);
      } else {
        setError('No messages on or after that date.');
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const date = parseLocalDate(value);
    if (!date) {
      setError('Pick a date first.');
      return;
    }
    void jump(date);
  };

  return (
    <div ref={containerRef} className="relative">
      <Button
        size="sm"
        variant="ghost"
        icon={<CalendarIcon size={15} />}
        onClick={() => {
          setError(null);
          toggle();
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <span className="hidden sm:inline">Jump to date</span>
        <span className="sr-only sm:hidden">Jump to date</span>
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Jump to date"
          className="absolute top-full right-0 z-40 mt-1.5 w-72 animate-pop-in rounded-xl border border-line bg-raised p-3 shadow-pop"
        >
          <form onSubmit={onSubmit} className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
              Show messages from
              <input
                type="date"
                value={value}
                min={min}
                max={max}
                autoFocus
                onChange={(e) => setValue(e.target.value)}
                className="focus-ring h-8.5 rounded-lg border border-line bg-canvas px-2.5 text-sm text-ink"
                aria-label="Date"
              />
            </label>
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" loading={busy} className="flex-1">
                Jump
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void jump(null)}>
                Beginning
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
