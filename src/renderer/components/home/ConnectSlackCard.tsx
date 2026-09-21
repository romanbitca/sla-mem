import { useId } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { describeError } from '../../lib/api';
import { AlertIcon, PlugIcon } from '../icons';
import { Button } from '../ui/Button';
import { useReconnect } from './ProblemCallout';
import type { ConnectPrompt } from './runs';

const COPY: Record<ConnectPrompt, { title: string; body: string; action: string }> = {
  'first-run': {
    title: 'Connect Slack to start your archive',
    body: 'You’ll sign in to Slack in a window, just like in your browser. sla-mem then keeps your channels, direct messages and files, even after Slack hides them.',
    action: 'Connect Slack',
  },
  'not-connected': {
    title: 'Connect Slack to keep your archive up to date',
    body: 'Syncing is off until you sign in. Everything already archived stays here.',
    action: 'Connect Slack',
  },
  expired: {
    title: 'Slack signed you out',
    body: 'Reconnect to keep archiving. Everything already archived stays here.',
    action: 'Reconnect',
  },
};

/** The home page's call to action while there's no working Slack connection. */
export function ConnectSlackCard({ variant }: { variant: ConnectPrompt }) {
  const headingId = useId();
  const { reconnect, pending, error } = useReconnect();
  const copy = COPY[variant];
  const warn = variant === 'expired';
  const hero = variant === 'first-run';
  return (
    <section
      aria-labelledby={headingId}
      className={clsx(
        'flex flex-col gap-4 rounded-2xl border sm:flex-row sm:items-center',
        warn ? 'border-warn/35 bg-warn-soft' : 'border-accent/30 bg-accent-soft',
        hero ? 'px-5 py-5 sm:px-6' : 'px-4 py-3.5',
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'flex shrink-0 items-center justify-center rounded-xl bg-raised',
          warn ? 'text-warn' : 'text-accent-text',
          hero ? 'size-11' : 'size-9',
        )}
      >
        {warn ? <AlertIcon size={hero ? 20 : 17} /> : <PlugIcon size={hero ? 20 : 17} />}
      </span>
      <div className="min-w-0 flex-1">
        <h2
          id={headingId}
          className={clsx('font-semibold', warn ? 'text-warn' : 'text-accent-text', hero ? 'text-base' : 'text-[15px]')}
        >
          {copy.title}
        </h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-ink-muted">{copy.body}</p>
        {hero && (
          <p className="mt-1 text-[13px] text-ink-muted">
            Have a Slack export instead?{' '}
            <Link
              to="/settings#advanced"
              className="focus-ring rounded font-medium text-accent-text underline underline-offset-2"
            >
              Import it in Settings
            </Link>
          </p>
        )}
        {error != null && (
          <p role="alert" className="mt-1 text-[13px] text-danger">
            {describeError(error)}
          </p>
        )}
      </div>
      <Button variant="primary" loading={pending} onClick={reconnect} className="self-start sm:self-center">
        {copy.action}
      </Button>
    </section>
  );
}
