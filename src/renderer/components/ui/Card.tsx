import { useId, type ReactNode } from 'react';
import clsx from 'clsx';

export interface CardProps {
  title: ReactNode;
  icon: ReactNode;
  /** Right side of the header (a status pill, "Saved"). */
  aside?: ReactNode;
  /** Beside the title, outside the heading: an InfoButton that explains how the card's numbers are worked out. */
  info?: ReactNode;
  id?: string;
  className?: string;
  children: ReactNode;
}

/** A titled panel; its heading names the region for screen readers. */
export function Card({ title, icon, aside, info, id, className, children }: CardProps) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={clsx('flex min-w-0 flex-col rounded-2xl border border-line bg-raised shadow-xs', className)}
    >
      <header className="flex items-center gap-2.5 border-b border-line px-5 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
          {icon}
        </span>
        <h2 id={headingId} className="text-[14px] font-semibold text-ink">
          {title}
        </h2>
        {info && <span className="-ml-1 flex">{info}</span>}
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </header>
      <div className="flex flex-1 flex-col gap-4 px-5 py-4">{children}</div>
    </section>
  );
}
