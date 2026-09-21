import { useRef, useState } from 'react';
import clsx from 'clsx';
import type { SlackConnectionDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { formatFullDateTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import {
  isLoginActive,
  useCancelLogin,
  useChooseLoginTeam,
  useDisconnect,
  useLoginFollower,
  useLoginStatus,
  useStartLogin,
} from '../../lib/queries';
import { workspaceHost } from '../../lib/workspaceName';
import { METHOD_LABEL } from '../connect/connection';
import { EmailCodeTip, SignInFailed, SignInSteps } from '../connect/SignInSteps';
import { timeAgo } from '../home/runs';
import { AlertIcon, CheckIcon, LogOutIcon, PlugIcon, SyncIcon } from '../icons';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Card } from '../ui/Card';
import { ConfirmDialog } from '../ui/Dialog';

type Pill = { text: string; tone: 'ok' | 'warn' | 'off' | 'busy' };

/**
 * The Slack connection (PLAN §8.4): who and where, Reconnect (the sign-in window again) and
 * Disconnect, which removes only the Slack login and never the archive.
 */
export function ConnectionCard({ connection }: { connection: SlackConnectionDTO }) {
  const now = useNow(30_000);
  const login = useLoginStatus();
  const status = login.data;
  const follower = useLoginFollower(status);
  const start = useStartLogin();
  const cancel = useCancelLogin();
  const choose = useChooseLoginTeam();
  const disconnect = useDisconnect();
  const [confirming, setConfirming] = useState(false);
  const disconnectRef = useRef<HTMLButtonElement>(null);

  const state = status?.state;
  const active = isLoginActive(state);
  const failed = follower.followed && (state === 'error' || state === 'cancelled');
  const justConnected = follower.followed && state === 'connected' && connection.connected && !connection.expired;
  const hasAccount = connection.connected || connection.teamId != null;
  const teamName = connection.teamName || workspaceHost(connection.teamDomain) || 'Your Slack workspace';
  const host = workspaceHost(connection.teamDomain);

  const signIn = () =>
    start.mutate(connection.teamDomain ? { workspace: connection.teamDomain } : {}, { onSuccess: follower.follow });

  const pill: Pill = active
    ? { text: 'Signing in…', tone: 'busy' }
    : connection.expired
      ? { text: 'Signed out', tone: 'warn' }
      : connection.connected
        ? { text: 'Connected', tone: 'ok' }
        : { text: 'Not connected', tone: 'off' };

  let body;
  if (active && status) {
    body = (
      <SignInSteps
        status={status}
        onCancel={() => cancel.mutate(undefined, { onSuccess: follower.reset })}
        cancelling={cancel.isPending}
        onChoose={(teamId) => choose.mutate(teamId)}
        choosing={choose.isPending}
        error={cancel.error ?? choose.error}
      />
    );
  } else {
    body = (
      <>
        {failed && status && <SignInFailed status={status} onRetry={signIn} retrying={start.isPending} />}
        {justConnected && (
          <Callout tone="success" icon={<CheckIcon size={15} />} role="status">
            <p className="font-medium">Connected to {teamName}.</p>
            <p className="text-ink-muted">Slack Archive is fetching your history in the background.</p>
          </Callout>
        )}
        {connection.expired && !failed && (
          <Callout tone="warn" icon={<AlertIcon size={15} />} role="alert">
            <p className="font-medium">Slack signed you out. Reconnect to keep archiving.</p>
            <p className="text-ink-muted">Everything already archived stays here.</p>
            <div className="mt-2">
              <Button size="sm" variant="primary" loading={start.isPending} onClick={signIn}>
                Reconnect
              </Button>
            </div>
          </Callout>
        )}

        {hasAccount ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-lg font-bold text-accent-ink"
              >
                {teamName.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-ink">{teamName}</p>
                {host && <p className="truncate text-[13px] text-ink-muted">{host}</p>}
                <p className="mt-1 text-xs text-ink-faint">
                  {[
                    connection.userName && `Signed in as ${connection.userName}`,
                    connection.method && METHOD_LABEL[connection.method],
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  {connection.connectedAt != null && (
                    <>
                      {connection.userName || connection.method ? ' · ' : ''}
                      Connected{' '}
                      <time
                        dateTime={new Date(connection.connectedAt).toISOString()}
                        title={formatFullDateTime(new Date(connection.connectedAt))}
                      >
                        {timeAgo(connection.connectedAt, now)}
                      </time>
                    </>
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!connection.expired && (
                <Button icon={<SyncIcon size={14} />} loading={start.isPending} onClick={signIn}>
                  Reconnect
                </Button>
              )}
              {connection.connected && (
                <Button
                  ref={disconnectRef}
                  variant="danger"
                  icon={<LogOutIcon size={14} />}
                  onClick={() => setConfirming(true)}
                >
                  Disconnect
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px] leading-relaxed text-ink-muted">
              You’ll sign in to Slack in a window, just like in your browser. Slack Archive then keeps a copy of your
              own conversations on this computer. Nothing is uploaded anywhere.
            </p>
            <div>
              <Button variant="primary" icon={<PlugIcon size={15} />} loading={start.isPending} onClick={signIn}>
                Connect Slack
              </Button>
            </div>
            <EmailCodeTip />
          </div>
        )}

        {start.isError && (
          <p role="alert" className="text-[13px] text-danger">
            {describeError(start.error)}
          </p>
        )}
      </>
    );
  }

  return (
    <Card id="connection" title="Slack connection" icon={<PlugIcon size={15} />} aside={<StatusPill pill={pill} />}>
      {body}
      <ConfirmDialog
        open={confirming}
        title="Disconnect Slack?"
        description="Your archive stays on this computer — only the Slack login is removed. Syncing stops until you connect again."
        confirmLabel="Disconnect"
        destructive
        busy={disconnect.isPending}
        returnFocusRef={disconnectRef}
        error={disconnect.isError ? describeError(disconnect.error) : null}
        onCancel={() => {
          setConfirming(false);
          disconnect.reset();
        }}
        onConfirm={() =>
          disconnect.mutate(undefined, {
            onSuccess: () => {
              setConfirming(false);
              follower.reset();
            },
          })
        }
      />
    </Card>
  );
}

const PILL_STYLE: Record<Pill['tone'], string> = {
  ok: 'bg-success/12 text-success',
  warn: 'bg-warn-soft text-warn',
  off: 'bg-inset text-ink-muted',
  busy: 'bg-accent-soft text-accent-text',
};

function StatusPill({ pill }: { pill: Pill }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        PILL_STYLE[pill.tone],
      )}
    >
      <span
        aria-hidden="true"
        className={clsx('size-1.5 rounded-full bg-current', pill.tone === 'busy' && 'animate-pulse')}
      />
      {pill.text}
    </span>
  );
}
