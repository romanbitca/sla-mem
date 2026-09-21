import { useId, useState, type FormEvent } from 'react';
import type { SlackConnectionDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { useConnectWithCookie } from '../../lib/queries';
import { readPref, writePref } from '../../lib/storage';
import { Code } from '../home/parts';
import { Button } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { FieldError, SecretInput, TextInput } from '../settings/fields';
import { validateCookie, validateWorkspace } from './connection';

/** Per-viewer convenience: the workspace typed last time. */
const WORKSPACE_PREF = 'connect.workspace';

export interface CookieConnectFormProps {
  /** Prefill for the workspace field (e.g. the archive's own workspace). */
  defaultWorkspace?: string | null;
  onConnected?: (connection: SlackConnectionDTO) => void;
  /** A sign-in window is open: this form waits for it. */
  disabled?: boolean;
}

/**
 * The last-resort way to connect (PLAN §2.4, point 3): paste the session cookie from a browser
 * where Slack is already signed in. This form is the only place the app names the cookie.
 */
export function CookieConnectForm({ defaultWorkspace, onConnected, disabled = false }: CookieConnectFormProps) {
  const [workspace, setWorkspace] = useState(() => defaultWorkspace ?? readPref(WORKSPACE_PREF) ?? '');
  const [cookie, setCookie] = useState('');
  const [errors, setErrors] = useState<{ workspace?: string | null; cookie?: string | null }>({});
  const connect = useConnectWithCookie();
  const ids = {
    workspace: useId(),
    cookie: useId(),
    workspaceError: useId(),
    cookieError: useId(),
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next = { workspace: validateWorkspace(workspace), cookie: validateCookie(cookie) };
    setErrors(next);
    if (next.workspace || next.cookie) return;
    connect.mutate(
      { workspace: workspace.trim(), cookie: cookie.trim() },
      {
        onSuccess: (connection) => {
          setCookie('');
          writePref(WORKSPACE_PREF, workspace.trim());
          onConnected?.(connection);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Only if signing in doesn’t work: connect with your browser’s Slack session instead.
      </p>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px] leading-relaxed text-ink-muted marker:text-ink-faint">
        <li>Open Slack in your web browser (Chrome, Edge or Brave) and sign in.</li>
        <li>
          Open the developer tools: press <Kbd>F12</Kbd>, or <Kbd>⌥⌘I</Kbd> on a Mac.
        </li>
        <li>
          Go to <span className="font-medium text-ink">Application → Cookies →</span> <Code>https://app.slack.com</Code>.
        </li>
        <li>
          Copy the value of the cookie named <Code>d</Code>. It starts with <Code>xoxd-</Code>.
        </li>
      </ol>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={ids.workspace} className="text-xs font-medium text-ink-muted">
              Workspace
            </label>
            <TextInput
              id={ids.workspace}
              value={workspace}
              onChange={(e) => {
                setWorkspace(e.target.value);
                setErrors((prev) => ({ ...prev, workspace: null }));
              }}
              placeholder="9h.slack.com"
              autoComplete="off"
              spellCheck={false}
              invalid={!!errors.workspace}
              aria-describedby={errors.workspace ? ids.workspaceError : undefined}
            />
            <FieldError id={ids.workspaceError}>{errors.workspace}</FieldError>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={ids.cookie} className="text-xs font-medium text-ink-muted">
              Value of the d cookie
            </label>
            <SecretInput
              id={ids.cookie}
              value={cookie}
              onChange={(e) => {
                setCookie(e.target.value);
                setErrors((prev) => ({ ...prev, cookie: null }));
              }}
              placeholder="xoxd-…"
              invalid={!!errors.cookie}
              aria-describedby={errors.cookie ? ids.cookieError : undefined}
            />
            <FieldError id={ids.cookieError}>{errors.cookie}</FieldError>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={connect.isPending} disabled={disabled}>
            Connect
          </Button>
          <span className="text-xs text-ink-faint">Signing out of Slack in that browser ends this connection too.</span>
        </div>
        {connect.isError && <FieldError>{describeError(connect.error, { allowCookie: true })}</FieldError>}
      </form>
    </div>
  );
}
