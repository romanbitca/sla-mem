import { useId, type ReactNode } from 'react';
import clsx from 'clsx';
import type { SyncStatusDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { isLoginActive, useImportExport, useLoginStatus } from '../../lib/queries';
import { CookieConnectForm } from '../connect/CookieConnectForm';
import { RunProgress } from '../home/RunProgress';
import { summarizeRun } from '../home/runs';
import { ChevronDownIcon, FolderIcon } from '../icons';
import { Button } from '../ui/Button';
import { FieldError } from './fields';

export interface AdvancedCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: SyncStatusDTO | undefined;
  /** The archive's workspace, to prefill the connect form. */
  teamDomain: string | null;
}

/**
 * Folded away on purpose (PLAN §8.4): importing a Slack export, and the last-resort way to
 * connect when signing in doesn't work.
 */
export function AdvancedCard({ open, onOpenChange, status, teamDomain }: AdvancedCardProps) {
  const panelId = useId();
  const signingIn = isLoginActive(useLoginStatus().data?.state);
  return (
    <section id="advanced" aria-label="Advanced" className="rounded-2xl border border-line bg-raised shadow-xs">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
          className="focus-ring flex w-full items-center gap-2 rounded-2xl px-5 py-3.5 text-left text-[14px] font-semibold text-ink hover:bg-hover/60"
        >
          <ChevronDownIcon
            size={15}
            className={clsx('text-ink-faint transition-transform duration-150', !open && '-rotate-90')}
          />
          Advanced
        </button>
      </h2>
      {open && (
        <div id={panelId} className="flex flex-col divide-y divide-line border-t border-line">
          <Section title="Import a Slack export">
            <ImportExport status={status} />
          </Section>
          <Section title="Paste your session cookie">
            <CookieConnectForm defaultWorkspace={teamDomain} disabled={signingIn} />
          </Section>
        </div>
      )}
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 px-5 py-4">
      <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function ImportExport({ status }: { status: SyncStatusDTO | undefined }) {
  const start = useImportExport();
  const runId = start.data?.runId;
  const importing = status?.running === true && status.currentRun?.kind === 'import';
  const finished = runId != null && !importing ? status?.recentRuns.find((r) => r.id === runId) : undefined;
  return (
    <>
      <p className="text-[13px] leading-relaxed text-ink-muted">
        Have an export of your Slack history? Pick its folder or .zip file to add its messages here. Nothing is
        duplicated or deleted, so importing the same export twice is safe.
      </p>
      <div>
        <Button
          icon={<FolderIcon size={14} />}
          loading={start.isPending}
          disabled={status?.running === true}
          onClick={() => start.mutate()}
        >
          Import a Slack export (folder or .zip)…
        </Button>
      </div>
      {status?.running && !importing && (
        <p className="text-xs text-ink-faint">A sync is running. You can import once it finishes.</p>
      )}
      {importing && <RunProgress run={status.currentRun} progress={status.progress} />}
      {finished && finished.status !== 'running' && (
        <p role="status" className="text-[13px] text-ink-muted">
          {finished.status === 'ok' ? `Import finished: ${summarizeRun(finished)}.` : summarizeRun(finished)}
        </p>
      )}
      {start.isError && <FieldError>{describeError(start.error)}</FieldError>}
    </>
  );
}
