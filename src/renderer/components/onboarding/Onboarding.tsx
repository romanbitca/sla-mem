import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import type { SettingsDTO, SlackConnectionDTO } from '../../../shared/types';
import { describeError, isConflict, presentableMessage } from '../../lib/api';
import { FREE_PLAN_WINDOW_DAYS } from '../../lib/format';
import { useStableCallback } from '../../lib/hooks';
import {
  isLoginActive,
  useCancelLogin,
  useChooseLoginTeam,
  useCompleteOnboarding,
  useLoginFollower,
  useLoginStatus,
  useStartLogin,
  useStartSync,
  useStats,
  useSyncStatus,
} from '../../lib/queries';
import { workspaceHost } from '../../lib/workspaceName';
import { CookieConnectForm } from '../connect/CookieConnectForm';
import { EmailCodeTip, SignInFailed, SignInSteps } from '../connect/SignInSteps';
import { ProblemCallout } from '../home/ProblemCallout';
import { RunProgress } from '../home/RunProgress';
import { ArchiveIcon, CheckIcon, ChevronDownIcon, InfoIcon, LockIcon, PlugIcon } from '../icons';
import { Button } from '../ui/Button';
import { Callout } from '../ui/Callout';
import { Spinner } from '../ui/Spinner';

type Step = 'welcome' | 'connect' | 'history';

const STEPS: { id: Step; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'connect', label: 'Connect Slack' },
  { id: 'history', label: 'Your history' },
];

function isWorking(connection: SlackConnectionDTO): boolean {
  return connection.connected && !connection.expired;
}

/**
 * First run (PLAN §8.1): three short screens, no jargon, no settings. Shown instead of the main
 * window until main records it as complete; the first sync keeps running after Finish.
 */
export default function Onboarding({ settings }: { settings: SettingsDTO }) {
  // Someone who connected and quit before finishing picks up where they left off.
  const [step, setStep] = useState<Step>(() => (isWorking(settings.connection) ? 'history' : 'welcome'));
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Each screen change moves focus to its heading, so keyboard and screen reader users follow.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const connected = isWorking(settings.connection);
  useEffect(() => {
    if (step === 'connect' && connected) setStep('history');
  }, [step, connected]);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-canvas text-ink">
      <header className="flex shrink-0 items-center gap-2.5 px-6 py-4">
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
          <ArchiveIcon size={17} />
        </span>
        <span className="text-[15px] font-semibold">Slack Archive</span>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-4 pb-12 sm:items-center sm:pt-0">
        <div className="flex w-full max-w-xl flex-col gap-6">
          <StepIndicator current={step} />
          <div className="rounded-2xl border border-line bg-raised px-6 py-7 shadow-pop sm:px-8">
            {step === 'welcome' && <WelcomeStep headingRef={headingRef} onNext={() => setStep('connect')} />}
            {step === 'connect' && (
              <ConnectStep
                headingRef={headingRef}
                connection={settings.connection}
                onBack={() => setStep('welcome')}
                onConnected={() => setStep('history')}
              />
            )}
            {step === 'history' && <HistoryStep headingRef={headingRef} connection={settings.connection} />}
          </div>
        </div>
      </main>
    </div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const index = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="flex items-center justify-center gap-2 text-xs" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2" aria-current={i === index ? 'step' : undefined}>
          {i > 0 && (
            <span aria-hidden="true" className={clsx('h-px w-6', i <= index ? 'bg-accent' : 'bg-line-strong')} />
          )}
          <span
            className={clsx(
              'flex size-5 items-center justify-center rounded-full text-[11px] font-semibold',
              i < index && 'bg-accent text-accent-ink',
              i === index && 'bg-accent-soft text-accent-text ring-1 ring-accent/50',
              i > index && 'bg-inset text-ink-faint',
            )}
            aria-hidden="true"
          >
            {i < index ? <CheckIcon size={11} strokeWidth={2.5} /> : i + 1}
          </span>
          <span className={clsx(i === index ? 'font-medium text-ink' : 'text-ink-faint', 'max-sm:sr-only')}>
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepHeading({
  headingRef,
  children,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>;
  children: ReactNode;
}) {
  return (
    <h1 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight text-ink outline-none">
      {children}
    </h1>
  );
}

// ---------------------------------------------------------------------------------------------
// 1. Welcome

function WelcomeStep({ headingRef, onNext }: { headingRef: RefObject<HTMLHeadingElement | null>; onNext: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <StepHeading headingRef={headingRef}>Welcome to Slack Archive</StepHeading>
      <p className="text-[15px] leading-relaxed text-ink">
        Slack Archive keeps a private copy of your Slack history on this computer, so you can still read and search it
        after Slack hides it. Your data never leaves your machine.
      </p>
      {/* PLAN §2.9: said plainly, once. */}
      <p className="flex items-start gap-2.5 rounded-xl bg-inset px-4 py-3 text-[13.5px] leading-relaxed text-ink-muted">
        <LockIcon size={16} className="mt-0.5 shrink-0 text-ink-faint" />
        <span>
          It uses your own Slack login to make a personal copy of your own history, here on this computer. Nothing is
          uploaded anywhere, and it never posts or changes anything in Slack.
        </span>
      </p>
      <div>
        <Button variant="primary" onClick={onNext} className="h-10 px-5 text-[15px]">
          Get started
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Connect Slack

function ConnectStep({
  headingRef,
  connection,
  onBack,
  onConnected,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>;
  connection: SlackConnectionDTO;
  onBack: () => void;
  onConnected: () => void;
}) {
  const login = useLoginStatus();
  const status = login.data;
  const follower = useLoginFollower(status);
  const start = useStartLogin();
  const cancel = useCancelLogin();
  const choose = useChooseLoginTeam();
  const [otherOpen, setOtherOpen] = useState(false);
  const otherId = useId();

  const active = isLoginActive(status?.state);
  // Main pushes "cancelled" before it answers Cancel: that's the reader's own choice, not a failure.
  const failed = follower.followed && !cancel.isPending && (status?.state === 'error' || status?.state === 'cancelled');
  const signIn = () =>
    start.mutate(connection.teamDomain ? { workspace: connection.teamDomain } : {}, { onSuccess: follower.follow });

  // The sign-in this screen started finished: move on (the saved connection follows).
  const connectedHere = follower.followed && status?.state === 'connected';
  const advance = useStableCallback(onConnected);
  useEffect(() => {
    if (connectedHere) advance();
  }, [connectedHere, advance]);

  return (
    <div className="flex flex-col gap-5">
      <StepHeading headingRef={headingRef}>Connect Slack</StepHeading>
      {active && status ? (
        <SignInSteps
          status={status}
          onCancel={() => cancel.mutate(undefined, { onSuccess: follower.reset })}
          cancelling={cancel.isPending}
          onChoose={(teamId) => choose.mutate(teamId)}
          choosing={choose.isPending}
          error={cancel.error ?? choose.error}
        />
      ) : status?.state === 'connected' && follower.followed ? (
        <p role="status" className="flex items-center gap-2.5 text-[14px] font-medium text-ink">
          <Spinner size={16} className="text-accent-text" />
          Connected. Getting ready…
        </p>
      ) : (
        <>
          {failed && status ? (
            <SignInFailed status={status} onRetry={signIn} retrying={start.isPending}>
              <OtherWays
                open={otherOpen}
                onOpenChange={setOtherOpen}
                panelId={otherId}
                teamDomain={connection.teamDomain}
              />
            </SignInFailed>
          ) : (
            <>
              <p className="text-[15px] leading-relaxed text-ink">
                You’ll sign in to Slack in a window, just like in your browser.
              </p>
              <div>
                <Button
                  variant="primary"
                  icon={<PlugIcon size={17} />}
                  loading={start.isPending}
                  onClick={signIn}
                  className="h-11 px-6 text-[15px]"
                >
                  Connect Slack
                </Button>
              </div>
              <EmailCodeTip />
            </>
          )}
          {start.isError && (
            <p role="alert" className="text-[13px] text-danger">
              {describeError(start.error)}
            </p>
          )}
          <div>
            <button
              type="button"
              onClick={onBack}
              className="focus-ring rounded text-[13px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** The advanced way to connect, for when signing in fails twice (PLAN §2.4, point 3). */
function OtherWays({
  open,
  onOpenChange,
  panelId,
  teamDomain,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panelId: string;
  teamDomain: string | null;
}) {
  return (
    <div className="mt-3 rounded-xl border border-line bg-raised text-ink">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
        className="focus-ring flex w-full items-center gap-2 rounded-xl px-3.5 py-2.5 text-left text-[13px] font-medium"
      >
        <ChevronDownIcon size={14} className={clsx('text-ink-faint transition-transform', !open && '-rotate-90')} />
        Still stuck? Advanced: connect another way
      </button>
      {open && (
        <div id={panelId} className="border-t border-line px-3.5 py-3">
          <CookieConnectForm defaultWorkspace={teamDomain} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Getting your history

function HistoryStep({
  headingRef,
  connection: saved,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>;
  connection: SlackConnectionDTO;
}) {
  const navigate = useNavigate();
  const sync = useSyncStatus();
  const stats = useStats();
  const complete = useCompleteOnboarding();
  // Right after signing in, the sign-in's own result may arrive before the saved settings do.
  const justSignedIn = useLoginStatus().data?.connection;
  const connection = saved.teamName || saved.teamDomain || !justSignedIn ? saved : justSignedIn;
  // Default on (PLAN §5.3): a sync that only runs when someone remembers leaves holes.
  const [launchAtLogin, setLaunchAtLogin] = useState(true);
  const checkboxId = useId();
  const status = sync.data;
  const team = connection.teamName || workspaceHost(connection.teamDomain);
  const firstSyncDone = status != null && !status.running && status.lastSuccessAt != null;
  const messages = stats.data?.messageCount ?? 0;

  return (
    <div className="flex flex-col gap-5">
      <StepHeading headingRef={headingRef}>Getting your history</StepHeading>
      {team && (
        <p className="flex items-center gap-2 text-[13.5px] text-success">
          <CheckIcon size={15} strokeWidth={2.25} /> Connected to {team}
          {connection.userName ? ` as ${connection.userName}` : ''}
        </p>
      )}

      <div className="rounded-xl border border-line bg-canvas px-4 py-3.5">
        {status?.running ? (
          <RunProgress run={status.currentRun} progress={status.progress} compact />
        ) : firstSyncDone ? (
          <p role="status" className="flex items-center gap-2 text-[14px] font-medium text-ink">
            <CheckIcon size={16} className="text-success" />
            {messages > 0
              ? `Your history is in: ${messages.toLocaleString()} messages archived.`
              : 'Your first sync is done.'}
          </p>
        ) : status?.problem ? (
          <ProblemCallout problem={status.problem} />
        ) : sync.isError ? (
          <p className="text-[13.5px] text-ink-muted">
            Couldn’t check on the first sync: {describeError(sync.error)} It continues in the background.
          </p>
        ) : (
          <FirstSyncWaiting blockedReason={status?.blockedReason ?? null} />
        )}
      </div>

      <p className="flex items-start gap-2.5 text-[14px] leading-relaxed text-ink">
        <InfoIcon size={16} className="mt-0.5 shrink-0 text-accent-text" />
        <span>
          Slack only lets us see the last {FREE_PLAN_WINDOW_DAYS} days. From now on, everything we fetch is kept
          forever.
        </span>
      </p>

      <label
        htmlFor={checkboxId}
        className="flex cursor-pointer items-start gap-3 rounded-xl border border-line px-4 py-3"
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={launchAtLogin}
          onChange={(e) => setLaunchAtLogin(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-accent"
        />
        <span className="min-w-0">
          <span className="block text-[14px] font-medium text-ink">Start Slack Archive when I log in</span>
          <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-muted">
            Recommended: it then keeps your archive up to date in the background, without you having to remember.
          </span>
        </span>
      </label>

      {complete.isError && (
        <Callout tone="danger" role="alert">
          {describeError(complete.error)}
        </Callout>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          loading={complete.isPending}
          onClick={() => complete.mutate(launchAtLogin, { onSuccess: () => navigate('/') })}
          className="h-10 px-5 text-[15px]"
        >
          Finish
        </Button>
        {!firstSyncDone && (
          <span className="text-[13px] text-ink-muted">
            You can finish now: the first sync carries on in the background.
          </span>
        )}
      </div>
    </div>
  );
}

/** How long "Starting the first sync…" may show before offering to start it by hand. */
export const FIRST_SYNC_GRACE_MS = 10_000;

/**
 * Main starts the first sync as soon as Slack is connected. If nothing has started after a
 * moment (it was cancelled by quitting, or syncing is blocked), say so and offer to start it,
 * rather than showing "Starting…" forever.
 */
function FirstSyncWaiting({ blockedReason }: { blockedReason: string | null }) {
  const [late, setLate] = useState(false);
  const startSync = useStartSync();
  useEffect(() => {
    const id = setTimeout(() => setLate(true), FIRST_SYNC_GRACE_MS);
    return () => clearTimeout(id);
  }, []);

  if (!late) {
    return (
      <p role="status" className="flex items-center gap-2.5 text-[14px] text-ink-muted">
        <Spinner size={15} className="text-accent-text" />
        Starting the first sync…
      </p>
    );
  }
  // "Already running" means it did start: the progress replaces this in a moment.
  const error = startSync.isError && !isConflict(startSync.error) ? startSync.error : null;
  return (
    <div className="flex flex-col items-start gap-2.5">
      <p className="text-[14px] text-ink-muted">
        {presentableMessage(blockedReason, 'The first sync hasn’t started yet.')}
      </p>
      <Button size="sm" variant="primary" loading={startSync.isPending} onClick={() => startSync.mutate()}>
        Start it now
      </Button>
      {error != null && (
        <p role="alert" className="text-[13px] text-danger">
          {describeError(error)}
        </p>
      )}
    </div>
  );
}
