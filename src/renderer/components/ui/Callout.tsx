import type { ReactNode } from 'react';
import clsx from 'clsx';

const TONES = {
  warn: 'border-warn/35 bg-warn-soft text-warn',
  danger: 'border-danger/35 bg-danger-soft text-danger',
  info: 'border-accent/30 bg-accent-soft text-accent-text',
  success: 'border-success/30 bg-success/8 text-success',
} as const;

export type CalloutTone = keyof typeof TONES;

/** A tinted note inside a card or page: a problem, a warning, or good news. */
export function Callout({
  tone,
  icon,
  children,
  role,
  className,
}: {
  tone: CalloutTone;
  icon?: ReactNode;
  children: ReactNode;
  role?: 'alert' | 'status';
  className?: string;
}) {
  return (
    <div
      role={role}
      className={clsx(
        'flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed',
        TONES[tone],
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
