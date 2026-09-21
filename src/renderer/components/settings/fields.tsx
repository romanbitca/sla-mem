/** Form controls for the Settings page, styled like the rest of the app's inputs. */
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import clsx from 'clsx';
import { ChevronDownIcon, EyeOffIcon } from '../icons';

const INPUT =
  'focus-ring h-8.5 w-full min-w-0 rounded-lg border bg-canvas px-2.5 text-[13px] text-ink placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-60';

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid, mono, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={clsx(
        INPUT,
        mono && 'font-mono text-[12.5px] placeholder:font-sans',
        invalid ? 'border-danger' : 'border-line',
        className,
      )}
      {...rest}
    />
  );
});

/**
 * A secret field (cookie, token): masked by default, with a Show/Hide toggle. Never autofilled
 * or spell-checked, so the value doesn't end up in the browser's form history.
 */
export const SecretInput = forwardRef<HTMLInputElement, Omit<TextInputProps, 'type'>>(function SecretInput(
  { className, ...rest },
  ref,
) {
  const [shown, setShown] = useState(false);
  return (
    <div className={clsx('relative min-w-0', className)}>
      <TextInput
        ref={ref}
        type={shown ? 'text' : 'password'}
        mono
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        data-1p-ignore
        className="pr-16"
        {...rest}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-pressed={shown}
        className="focus-ring absolute top-1/2 right-1 inline-flex h-6.5 -translate-y-1/2 items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-muted hover:bg-hover hover:text-ink"
      >
        {shown ? <EyeOffIcon size={13} /> : null}
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={clsx('relative', className)}>
      <select {...rest} className={clsx(INPUT, 'appearance-none border-line pr-8')}>
        {children}
      </select>
      <ChevronDownIcon
        size={14}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-faint"
      />
    </div>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}

/** On/off switch (a checkbox with the switch role), keyboard-operable with Space. */
export function Switch({ checked, onChange, disabled, ...aria }: SwitchProps) {
  return (
    <span className="relative inline-flex shrink-0">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer focus-ring absolute inset-0 z-10 m-0 cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed"
        {...aria}
      />
      <span
        aria-hidden="true"
        className={clsx(
          'flex h-5 w-9 items-center rounded-full p-0.5 transition-colors duration-150 peer-disabled:opacity-55',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span
          className={clsx(
            'size-4 rounded-full bg-raised shadow-xs transition-transform duration-150',
            checked && 'translate-x-4',
          )}
        />
      </span>
    </span>
  );
}

/** A labelled settings row: text on the left, control on the right (stacked on narrow screens). */
export function SettingRow({
  label,
  labelId,
  htmlFor,
  description,
  descriptionId,
  children,
}: {
  label: ReactNode;
  labelId?: string;
  htmlFor?: string;
  description?: ReactNode;
  descriptionId?: string;
  children: ReactNode;
}) {
  const labelClass = 'text-[13.5px] font-medium text-ink';
  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-6">
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <label id={labelId} htmlFor={htmlFor} className={labelClass}>
            {label}
          </label>
        ) : (
          <p id={labelId} className={labelClass}>
            {label}
          </p>
        )}
        {description && (
          <div id={descriptionId} className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            {description}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:justify-end">{children}</div>
    </div>
  );
}

export function FieldError({ children, id }: { children: ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="text-[13px] text-danger">
      {children}
    </p>
  );
}

export interface RadioChoice<V extends string> {
  value: V;
  label: ReactNode;
  detail?: ReactNode;
}

/** A group of large, labelled radio options (one decision, a few well-explained choices). */
export function RadioGroup<V extends string>({
  legend,
  value,
  choices,
  onChange,
  disabled,
  describedBy,
}: {
  legend: ReactNode;
  value: V | null;
  choices: readonly RadioChoice<V>[];
  onChange: (value: V) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled} aria-describedby={describedBy}>
      <legend className="mb-2 text-[13.5px] font-medium text-ink">{legend}</legend>
      {choices.map((choice) => {
        const checked = choice.value === value;
        return (
          <label
            key={choice.value}
            className={clsx(
              'flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-2.5 transition-colors',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
              checked ? 'border-accent/50 bg-accent-soft' : 'border-line bg-canvas hover:bg-hover',
            )}
          >
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={checked}
              onChange={() => onChange(choice.value)}
              className="mt-0.5 size-4 shrink-0 accent-accent"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-ink">{choice.label}</span>
              {choice.detail && <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{choice.detail}</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
