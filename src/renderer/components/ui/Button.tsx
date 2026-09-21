import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover border border-transparent shadow-xs',
  secondary: 'bg-raised text-ink border border-line hover:bg-hover hover:border-line-strong shadow-xs',
  ghost: 'bg-transparent text-ink-muted border border-transparent hover:bg-hover hover:text-ink',
  danger: 'bg-raised text-danger border border-line hover:bg-danger-soft hover:border-danger/40',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[13px] gap-1.5 rounded-md',
  md: 'h-8.5 px-3.5 text-sm gap-2 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'focus-ring inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-55',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon}
      {children}
    </button>
  );
});
