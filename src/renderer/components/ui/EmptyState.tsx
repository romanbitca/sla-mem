import type { ReactNode } from 'react';
import clsx from 'clsx';
import { AlertIcon } from '../icons';
import { describeError } from '../../lib/api';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact = false }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'mx-auto flex max-w-sm flex-col items-center text-center',
        compact ? 'gap-1.5 px-4 py-8' : 'gap-2 px-6 py-16',
        className,
      )}
    >
      {icon && (
        <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-inset text-ink-faint">{icon}</div>
      )}
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      {description && <div className="text-sm leading-relaxed text-ink-muted">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}

export function ErrorState({ error, title = 'Couldn’t load this', onRetry, className, compact }: ErrorStateProps) {
  return (
    <div role="alert">
      <EmptyState
        compact={compact}
        className={className}
        icon={<AlertIcon size={20} className="text-danger" />}
        title={title}
        description={describeError(error)}
        action={
          onRetry && (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    </div>
  );
}
