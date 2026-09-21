import clsx from 'clsx';

export function Spinner({ size = 16, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={clsx('animate-spin text-current', className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Centered spinner with a caption, for whole-pane loading states. */
export function LoadingState({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div
      className={clsx('flex flex-1 items-center justify-center gap-2.5 py-16 text-sm text-ink-muted', className)}
      role="status"
    >
      <Spinner size={16} />
      <span>{label}</span>
    </div>
  );
}
