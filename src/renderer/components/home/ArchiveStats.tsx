import type { ReactNode } from 'react';
import { Link } from 'react-router';
import clsx from 'clsx';
import { differenceInCalendarDays } from 'date-fns';
import type { StatsDTO, StorageDTO } from '../../../shared/types';
import { FREE_PLAN_WINDOW_DAYS, formatBytes, formatDate, pluralize } from '../../lib/format';
import { conversationPath } from '../../lib/links';
import { tsToDate } from '../../lib/ts';
import { ArchiveIcon, CalendarIcon, DatabaseIcon, FileIcon, HashIcon, MessageIcon } from '../icons';
import { ErrorState } from '../ui/EmptyState';

export interface ArchiveStatsProps {
  stats: StatsDTO | undefined;
  /** Disk usage from main (optional: the stats' own byte counts are the fallback). */
  storage: StorageDTO | undefined;
  error: unknown;
  onRetry: () => void;
}

/** Headline numbers: how much is archived, over what period, and what it costs on disk. */
export function ArchiveStats({ stats, storage, error, onRetry }: ArchiveStatsProps) {
  if (!stats) {
    if (error) return <ErrorState compact error={error} title="Couldn’t load archive numbers" onRetry={onRetry} />;
    return <StatsSkeleton />;
  }
  const dbBytes = storage?.databaseBytes ?? stats.dbBytes;
  const filesBytes = storage?.attachmentsBytes ?? stats.filesBytes;
  const total = storage?.totalBytes ?? dbBytes + filesBytes;
  return (
    // Six tracks: three cards on the first row, two wider ones (range, disk) on the second.
    <ul aria-label="Archive statistics" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
      <StatCard
        className="lg:col-span-2"
        icon={<MessageIcon size={16} />}
        label="Messages"
        value={stats.messageCount.toLocaleString()}
        detail={`From ${pluralize(stats.userCount, 'person', 'people')}`}
      />
      <StatCard
        className="lg:col-span-2"
        icon={<HashIcon size={16} />}
        label="Conversations"
        value={stats.conversationCount.toLocaleString()}
        detail="Channels, direct messages and group DMs"
      />
      <FilesCard stats={stats} filesBytes={filesBytes} />
      <RangeCard stats={stats} />
      <StatCard
        className="lg:col-span-3"
        icon={<DatabaseIcon size={16} />}
        label="Space used on this computer"
        value={formatBytes(total) || '0 B'}
        detail={`Messages ${formatBytes(dbBytes) || '0 B'} · attachments ${formatBytes(filesBytes) || '0 B'}`}
      />
    </ul>
  );
}

interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  className?: string;
  children?: ReactNode;
}

function StatCard({ icon, label, value, detail, className, children }: StatCardProps) {
  return (
    <li
      className={clsx(
        'flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-raised px-4 py-3.5 shadow-xs',
        className,
      )}
    >
      <p className="flex items-center gap-2 text-xs font-medium text-ink-muted">
        <span className="text-ink-faint">{icon}</span>
        {label}
      </p>
      <p className="truncate text-2xl font-semibold tracking-tight text-ink tabular-nums">{value}</p>
      {detail && <p className="truncate text-xs text-ink-faint">{detail}</p>}
      {children}
    </li>
  );
}

function FilesCard({ stats, filesBytes }: { stats: StatsDTO; filesBytes: number }) {
  const { fileCount, filesDownloaded } = stats;
  const percent = fileCount > 0 ? Math.round((filesDownloaded / fileCount) * 100) : 0;
  return (
    <StatCard
      className="sm:col-span-2 lg:col-span-2"
      icon={<FileIcon size={16} />}
      label="Attachments saved"
      value={
        <>
          {filesDownloaded.toLocaleString()}
          <span className="text-base font-medium text-ink-faint"> / {fileCount.toLocaleString()}</span>
        </>
      }
      detail={fileCount > 0 ? `${percent}% saved · ${formatBytes(filesBytes) || '0 B'}` : 'No attachments yet'}
    >
      {fileCount > 0 && (
        <div
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-inset"
          role="img"
          aria-label={`${percent}% of attachments saved`}
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        </div>
      )}
    </StatCard>
  );
}

/**
 * The period the archive covers. When a handful of messages reach months further back than the
 * rest (Slack still shows notes to yourself and threads with recent replies past its 90 days), the
 * range starts where most of the history does, and those few are named, with a link to the oldest.
 */
function RangeCard({ stats }: { stats: StatsDTO }) {
  const main = stats.mainStart;
  const start = tsToDate(main?.ts ?? stats.oldestTs ?? '');
  const newest = tsToDate(stats.newestTs ?? '');
  const from = formatDate(start, 'MMM d, yyyy');
  const to = formatDate(newest, 'MMM d, yyyy');
  if (!from || !to) {
    return (
      <StatCard
        className="lg:col-span-3"
        icon={<CalendarIcon size={16} />}
        label="Archive covers"
        value="—"
        detail="Nothing archived yet"
      />
    );
  }
  const days = pluralize(differenceInCalendarDays(newest, start) + 1, 'day');
  const oldest = formatDate(tsToDate(stats.oldestTs ?? ''), 'MMM d, yyyy');
  return (
    <StatCard
      className="lg:col-span-3"
      icon={<CalendarIcon size={16} />}
      label="Archive covers"
      value={<span className="text-xl">{`${from} – ${to}`}</span>}
      detail={
        main && oldest ? (
          <span title="Slack still showed these past its 90 days, for example notes to yourself or threads with recent replies.">
            {days} · plus {pluralize(main.olderCount, 'older message')}, back to{' '}
            {stats.oldestConversationId && stats.oldestTs ? (
              <Link
                to={`${conversationPath(stats.oldestConversationId)}?ts=${stats.oldestTs}`}
                className="text-accent-text hover:underline"
              >
                {oldest}
              </Link>
            ) : (
              oldest
            )}
          </span>
        ) : (
          `${days} of history`
        )
      }
    />
  );
}

/**
 * The payoff (PLAN §8.2): how much of the archive Slack itself no longer shows. Before anything
 * is that old, it explains what will happen instead.
 */
export function FreeWindowHero({ stats }: { stats: StatsDTO }) {
  const n = stats.beyondFreeWindowCount;
  if (stats.messageCount === 0) return null;
  return (
    <section
      aria-label="Messages only in your archive"
      className="flex items-start gap-4 rounded-2xl border border-accent/30 bg-accent-soft px-5 py-4"
    >
      <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-accent-text">
        <ArchiveIcon size={20} />
      </span>
      <div className="min-w-0">
        {n > 0 ? (
          <>
            <p className="text-lg leading-snug font-semibold text-accent-text">
              <span className="tabular-nums">{n.toLocaleString()}</span> {n === 1 ? 'message' : 'messages'} older than{' '}
              {FREE_PLAN_WINDOW_DAYS} days — no longer visible in Slack
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
              They’re kept here for good. Slack deletes older history on the Free plan, so this archive may be the only
              copy left.
            </p>
          </>
        ) : (
          <>
            <p className="text-lg leading-snug font-semibold text-accent-text">
              Everything archived is still inside Slack’s {FREE_PLAN_WINDOW_DAYS}-day window
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
              From day {FREE_PLAN_WINDOW_DAYS + 1}, messages disappear from Slack but stay here. Keep Slamem syncing and
              nothing is lost.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function StatsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading archive numbers"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6"
    >
      {Array.from({ length: 5 }, (_, i) => (
        <div
          key={i}
          className={clsx(
            'flex h-[98px] flex-col gap-2 rounded-2xl border border-line bg-raised px-4 py-3.5',
            i < 3 ? 'lg:col-span-2' : 'lg:col-span-3',
            i === 2 && 'sm:col-span-2',
          )}
        >
          <div className="h-3 w-20 animate-pulse rounded bg-inset" />
          <div className="h-6 w-28 animate-pulse rounded bg-inset" />
          <div className="h-3 w-32 animate-pulse rounded bg-inset" />
        </div>
      ))}
    </div>
  );
}
