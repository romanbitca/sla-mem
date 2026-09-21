import { useId, useState, type FormEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import type { LoginStatusDTO } from '../../../shared/types';
import { describeError, presentableMessage } from '../../lib/api';
import { workspaceHost } from '../../lib/workspaceName';
import { AlertIcon, CloseIcon, InfoIcon } from '../icons';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Spinner } from '../ui/Spinner';

/** The one tip that gets most people through (PLAN §2.4): Slack's own email-code sign-in. */
export function EmailCodeTip({ className }: { className?: string }) {
  return (
    <p className={clsx('flex items-start gap-2 text-[13px] leading-relaxed text-ink-muted', className)}>
      <InfoIcon size={15} className="mt-0.5 shrink-0 text-accent-text" />
      <span>
        <span className="font-medium text-ink">Tip:</span> the easiest option is{' '}
        <span className="font-medium text-ink">“Sign in with email”</span> — Slack emails you a 6-digit code to type in.
      </span>
    </p>
  );
}

export interface SignInStepsProps {
  status: LoginStatusDTO;
  onCancel: () => void;
  cancelling: boolean;
  onChoose: (teamId: string) => void;
  choosing: boolean;
  /** A failed Cancel or Continue request. */
  error: unknown;
}

/** A sign-in in progress: what's happening in the Slack window, the workspace picker, Cancel. */
export function SignInSteps({ status, onCancel, cancelling, onChoose, choosing, error }: SignInStepsProps) {
  let body: ReactNode;
  switch (status.state) {
    case 'choose_team':
      body = <TeamPicker teams={status.teams} onChoose={onChoose} choosing={choosing} />;
      break;
    case 'verifying':
      body = <Working>Checking your sign-in with Slack…</Working>;
      break;
    case 'opening':
      body = <Working>Opening the Slack sign-in window…</Working>;
      break;
    default:
      body = (
        <>
          <Working>Finish signing in in the Slack window…</Working>
          <EmailCodeTip />
        </>
      );
  }
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      {body}
      {error != null && (
        <p role="alert" className="text-[13px] text-danger">
          {describeError(error)}
        </p>
      )}
      <div>
        <Button icon={<CloseIcon size={14} />} loading={cancelling} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Working({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2.5 text-[14px] font-medium text-ink">
      <Spinner size={16} className="text-accent-text" />
      {children}
    </p>
  );
}

function TeamPicker({
  teams,
  onChoose,
  choosing,
}: {
  teams: LoginStatusDTO['teams'];
  onChoose: (teamId: string) => void;
  choosing: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(teams.length === 1 ? teams[0].id : null);
  const name = useId();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (selected) onChoose(selected);
  };
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-[13.5px] text-ink">
          You’re signed in to more than one workspace. Which one should Slack Archive keep a copy of?
        </legend>
        {teams.map((team) => (
          <label
            key={team.id}
            className={clsx(
              'flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
              selected === team.id ? 'border-accent/50 bg-accent-soft' : 'border-line bg-canvas hover:bg-hover',
            )}
          >
            <input
              type="radio"
              name={name}
              value={team.id}
              checked={selected === team.id}
              onChange={() => setSelected(team.id)}
              className="size-4 shrink-0 accent-accent"
            />
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-xs font-bold text-accent-ink">
              {(team.name || team.domain || '?').charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-ink">{team.name || team.domain}</span>
              <span className="block truncate text-xs text-ink-faint">{workspaceHost(team.domain) ?? team.domain}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div>
        <Button type="submit" variant="primary" disabled={!selected} loading={choosing}>
          Continue
        </Button>
      </div>
    </form>
  );
}

export interface SignInFailedProps {
  status: LoginStatusDTO;
  onRetry: () => void;
  retrying: boolean;
  /** Extra ways to connect, shown under the retry (e.g. the advanced option). */
  children?: ReactNode;
}

/** A sign-in that was cancelled or failed: what happened, Try again, and the alternatives. */
export function SignInFailed({ status, onRetry, retrying, children }: SignInFailedProps) {
  const cancelled = status.state === 'cancelled';
  const detail = presentableMessage(
    status.error ?? status.message,
    cancelled ? 'The Slack window was closed before signing in finished.' : 'Slack didn’t let us sign in this time.',
  );
  return (
    <Callout tone={cancelled ? 'warn' : 'danger'} icon={<AlertIcon size={15} />} role="alert">
      <p className="font-medium">{cancelled ? 'Sign-in didn’t finish' : 'Couldn’t connect to Slack'}</p>
      <p className="text-ink-muted">{detail}</p>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-ink-muted marker:text-ink-faint">
        <li>
          Try signing in with email: on Slack’s sign-in page choose{' '}
          <span className="font-medium text-ink">“Sign in with email”</span> and type the 6-digit code Slack sends you.
          It works even when Google sign-in doesn’t.
        </li>
        <li>Keep the Slack window open until Slack Archive says you’re connected.</li>
      </ul>
      <div className="mt-3">
        <Button size="sm" variant="primary" loading={retrying} onClick={onRetry}>
          Try again
        </Button>
      </div>
      {children}
    </Callout>
  );
}
