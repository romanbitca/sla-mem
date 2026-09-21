import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name; also shown as the native tooltip unless `title` is given. */
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** `overlay` is for controls drawn over photos/dark scrims (lightbox). */
  variant?: 'default' | 'overlay';
  active?: boolean;
}

const SIZES = { sm: 'size-7', md: 'size-8', lg: 'size-10' } as const;

// Colors live in the variant so callers never need to override them with conflicting utilities.
const VARIANTS = {
  default: (active: boolean) =>
    clsx('rounded-md hover:bg-hover hover:text-ink', active ? 'bg-hover text-ink' : 'text-ink-muted'),
  overlay: () => 'rounded-full bg-black/35 text-white/85 hover:bg-black/60 hover:text-white',
} as const;

/** Square icon-only button. Always carries an aria-label. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = 'md', variant = 'default', active = false, className, title, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={active || undefined}
      className={clsx(
        'focus-ring inline-flex shrink-0 items-center justify-center transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant](active),
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
