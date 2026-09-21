import { useState, type FormEvent } from 'react';
import clsx from 'clsx';
import { Button } from '../ui/Button';
import { datePresets, exclusiveBefore, inclusiveEnd, sameRange } from './dateRange';
import type { DateRange } from './resolve';

export interface DateRangePanelProps {
  value: DateRange;
  onApply: (range: DateRange) => void;
  now?: Date;
}

/**
 * Presets plus a from/to pair. The inputs edit a draft (typing a date passes through invalid
 * intermediate values), applied with the button; presets apply at once.
 */
export function DateRangePanel({ value, onApply, now }: DateRangePanelProps) {
  const [from, setFrom] = useState(value.after ?? '');
  const [to, setTo] = useState(inclusiveEnd(value.before) ?? '');
  const [error, setError] = useState<string | null>(null);
  const presets = datePresets(now);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (from && to && from > to) {
      setError('The start date is after the end date.');
      return;
    }
    onApply({ after: from || null, before: exclusiveBefore(to || null) });
  };

  return (
    <div className="flex flex-col">
      <ul className="flex flex-col p-1" aria-label="Quick ranges">
        {presets.map((preset) => {
          const current = sameRange(preset.range, value);
          return (
            <li key={preset.id}>
              <button
                type="button"
                aria-pressed={current}
                onClick={() => onApply(preset.range)}
                className={clsx(
                  'focus-ring flex w-full items-baseline justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[13px]',
                  current ? 'bg-accent-soft font-medium text-accent-text' : 'text-ink hover:bg-hover',
                )}
              >
                <span>{preset.label}</span>
                {preset.detail && <span className="text-xs text-ink-faint">{preset.detail}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <form onSubmit={onSubmit} className="flex flex-col gap-2.5 border-t border-line p-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
            From
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => {
                setFrom(e.target.value);
                setError(null);
              }}
              className="focus-ring h-8.5 rounded-lg border border-line bg-canvas px-2 text-[13px] text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
            To (inclusive)
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => {
                setTo(e.target.value);
                setError(null);
              }}
              className="focus-ring h-8.5 rounded-lg border border-line bg-canvas px-2 text-[13px] text-ink"
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!value.after && !value.before && !from && !to}
            onClick={() => onApply({ after: null, before: null })}
          >
            Any time
          </Button>
          <Button type="submit" size="sm" variant="primary">
            Apply
          </Button>
        </div>
      </form>
    </div>
  );
}
