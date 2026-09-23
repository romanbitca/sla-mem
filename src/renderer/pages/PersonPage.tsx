import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import clsx from 'clsx';
import type {
  ConversationDTO,
  FileDTO,
  MessageDTO,
  PersonConversationDTO,
  PersonDTO,
  PersonLinkDTO,
  UserDTO,
} from '../../shared/types';
import { isNotFound } from '../lib/api';
import type { AskDraftState } from '../lib/askChat';
import { useDirectory, type Directory } from '../lib/directory';
import { formatDate, formatShortDate, joinNames, pluralize } from '../lib/format';
import { useNow } from '../lib/hooks';
import { conversationPath, messagePath, PEOPLE_PATH, searchPath } from '../lib/links';
import { briefQuestion, firstName, shortUrl } from '../lib/people';
import { usePerson } from '../lib/queries';
import { tsToDate, tsToMs } from '../lib/ts';
import { workspaceHost } from '../lib/workspaceName';
import { Fact } from '../components/home/parts';
import { timeAgo } from '../components/home/runs';
import {
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileIcon,
  HashIcon,
  HistoryIcon,
  LockIcon,
  MailIcon,
  MessageIcon,
  SearchIcon,
  SparklesIcon,
  UsersIcon,
} from '../components/icons';
import { PageNav } from '../components/layout/shell';
import { Avatar } from '../components/message/Avatar';
import { LocalTime } from '../components/people/LocalTime';
import { WeekBars } from '../components/people/WeekBars';
import { HitRow } from '../components/search/SearchResults';
import { Button, buttonClass } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { LoadingState } from '../components/ui/Spinner';

/** Channels shown before "Show all", files and links before "Show more": the rest is a click away. */
const CHANNELS_SHOWN = 5;
const FILES_SHOWN = 8;
const LINKS_SHOWN = 5;

/**
 * `/people/:id`: one person. Who they are (title, their local time), what is open between you
 * (questions either of you left unanswered), your latest messages together, where you talk, and
 * what they shared. "Brief me" hands Ask AI a question about them, ready to send.
 */
export default function PersonPage() {
  const { id = '' } = useParams();
  const query = usePerson(id);
  const dir = useDirectory();
  const user = dir.users.get(id);
  const label = user?.label ?? id;

  let body;
  if (query.isPending) body = <LoadingState label="Loading…" />;
  else if (query.isError)
    body = isNotFound(query.error) ? (
      <EmptyState
        icon={<UsersIcon size={20} />}
        title="That person isn’t in the archive"
        action={
          <Link to={PEOPLE_PATH} className={buttonClass('secondary', 'md')}>
            All people
          </Link>
        }
      />
    ) : (
      <ErrorState error={query.error} title="Couldn’t load this person" onRetry={() => void query.refetch()} />
    );
  else body = <PersonView key={id} person={query.data} user={user} />;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 animate-page-in flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <PageNav />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[15px]">
          <Link to={PEOPLE_PATH} className="focus-ring shrink-0 rounded-sm font-medium text-ink-muted hover:text-ink">
            People
          </Link>
          <ChevronRightIcon size={14} className="shrink-0 text-ink-faint" />
          <h1 className="truncate font-semibold text-ink">{label}</h1>
        </nav>
      </header>
      {/* Keyed by person: someone else's page starts at the top, not where the last one was left. */}
      <div key={id} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {body}
      </div>
    </section>
  );
}

function PersonView({ person, user }: { person: PersonDTO; user: UserDTO | undefined }) {
  const now = useNow(60_000);
  const name = user?.realName || user?.label || person.userId;
  const first = person.isSelf ? 'you' : firstName(user?.label ?? name);
  const open = person.waitingOnYou.length + person.waitingOnThem.length;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8">
      <Profile person={person} user={user} name={name} now={now} />
      <Facts person={person} now={now} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          {!person.isSelf &&
            (open > 0 ? (
              <OpenQuestions person={person} first={first} />
            ) : (
              <p className="flex items-center gap-2 px-1 text-[13px] text-ink-muted">
                <CheckIcon size={15} className="shrink-0 text-success" />
                No open questions between you in the last {person.openQuestionDays} days.
              </p>
            ))}
          {!person.isSelf && <Recent person={person} />}
          <Shared person={person} user={user} first={first} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          {person.weeks.length > 0 && (
            <Card title="Messages between you" icon={<CalendarIcon size={15} />}>
              <p className="-mt-1 text-xs text-ink-muted">Per week, in your DM and the group DMs you share.</p>
              <WeekBars weeks={person.weeks} />
            </Card>
          )}
          <Places person={person} user={user} first={first} />
        </div>
      </div>
    </div>
  );
}

// ─── who they are ────────────────────────────────────────────────────────────────────────────

function Profile({
  person,
  user,
  name,
  now,
}: {
  person: PersonDTO;
  user: UserDTO | undefined;
  name: string;
  now: number;
}) {
  const navigate = useNavigate();
  const { teamDomain } = useDirectory();
  const handle = user?.name && user.name !== person.userId ? user.name : null;
  const host = workspaceHost(teamDomain);
  const inSlack = host
    ? person.dm
      ? `https://${host}/archives/${person.dm.conversationId}`
      : `https://${host}/team/${person.userId}`
    : null;
  const brief = () =>
    navigate('/ask', {
      state: { askDraft: briefQuestion(user ?? { label: name, realName: name, name: '' }) } satisfies AskDraftState,
    });
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <Avatar
        seed={person.userId}
        label={name}
        src={person.avatarUrl ?? user?.avatarUrl ?? null}
        size={72}
        className={clsx(user?.deleted && 'grayscale')}
      />
      <div className="min-w-0 flex-1">
        <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xl font-semibold tracking-tight text-ink">
          <span className="min-w-0 break-words">{name}</span>
          {person.isSelf && <Badge>You</Badge>}
          {user?.deleted && <Badge>Deactivated</Badge>}
          {person.isGuest && <Badge>Guest</Badge>}
        </h2>
        {(person.title || handle) && (
          <p className="mt-0.5 text-sm text-ink-muted">
            {[person.title, handle ? `@${handle}` : null].filter(Boolean).join(' · ')}
          </p>
        )}
        {user?.deleted && (
          <p className="mt-1 text-[13px] text-ink-muted">
            Deactivated in Slack. Everything they wrote stays in your archive.
          </p>
        )}
        {((!person.isSelf && person.tz) || person.email) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-ink-muted">
            {!person.isSelf && <LocalTime tz={person.tz} tzLabel={person.tzLabel} now={now} />}
            {person.email && (
              <a
                href={`mailto:${person.email}`}
                target="_blank"
                rel="noopener noreferrer"
                className="focus-ring inline-flex items-center gap-1.5 rounded-sm hover:text-ink hover:underline"
              >
                <MailIcon size={14} className="shrink-0 text-ink-faint" />
                {person.email}
              </a>
            )}
          </div>
        )}
        <div className="mt-3.5 flex flex-wrap gap-2">
          {person.dm && (
            <Link to={conversationPath(person.dm.conversationId)} className={buttonClass('secondary', 'sm')}>
              <MessageIcon size={14} />
              Open DM
            </Link>
          )}
          {!person.isSelf && (
            <Button
              size="sm"
              icon={<SparklesIcon size={14} />}
              onClick={brief}
              title={`Opens Ask AI with a question about ${name}, ready to send`}
            >
              Brief me
            </Button>
          )}
          {(handle || person.isSelf) && (
            <Link to={searchPath(person.isSelf ? 'from:me' : `from:@${handle}`)} className={buttonClass('ghost', 'sm')}>
              <SearchIcon size={14} />
              {person.isSelf ? 'Your messages' : 'Their messages'}
            </Link>
          )}
          {inSlack && !person.isSelf && (
            <a href={inSlack} target="_blank" rel="noopener noreferrer" className={buttonClass('ghost', 'sm')}>
              <ExternalLinkIcon size={14} />
              Open in Slack
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-inset px-1.5 py-px text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
      {children}
    </span>
  );
}

/** Numbers about you two; plain facts, nothing to click. */
function Facts({ person, now }: { person: PersonDTO; now: number }) {
  const since = person.firstMessageTs ? formatDate(tsToDate(person.firstMessageTs), 'MMM d, yyyy') : null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl border border-line bg-raised px-5 py-4 text-sm shadow-xs sm:grid-cols-4">
      {!person.isSelf && (
        <Fact label="Last talked">{person.lastTalkedTs ? when(person.lastTalkedTs, now) : 'Not yet'}</Fact>
      )}
      {!person.isSelf && (
        <Fact label="Direct messages">{person.dm ? person.dm.messageCount.toLocaleString() : 'None'}</Fact>
      )}
      <Fact label={person.isSelf ? 'Your messages' : 'Their messages'}>{person.messageCount.toLocaleString()}</Fact>
      <Fact label={person.isSelf ? 'Writing since' : 'In your archive since'}>{since ?? '—'}</Fact>
    </dl>
  );
}

/** "2 days ago" for the last month, a date beyond. */
function when(ts: string, now: number): string {
  const ms = tsToMs(ts);
  return now - ms < 30 * 86_400_000 ? timeAgo(ms, now) : formatShortDate(new Date(ms));
}

// ─── between you ─────────────────────────────────────────────────────────────────────────────

function OpenQuestions({ person, first }: { person: PersonDTO; first: string }) {
  const dmId = person.dm?.conversationId ?? null;
  return (
    <Card
      title="Open questions"
      icon={<MessageIcon size={15} />}
      aside={<span className="text-xs text-ink-faint">Last {person.openQuestionDays} days</span>}
    >
      {person.waitingOnYou.length > 0 && (
        <MessageGroup title={`${first} asked you`} messages={person.waitingOnYou} dmId={dmId} />
      )}
      {person.waitingOnThem.length > 0 && (
        <MessageGroup title={`You asked ${first}`} messages={person.waitingOnThem} dmId={dmId} />
      )}
      <p className="text-xs text-ink-faint">
        Questions and requests with no answer in Slack yet. A reply or a reaction counts as one.
      </p>
    </Card>
  );
}

/** Messages as rows. Those in your DM go without the conversation's name: it would be theirs again. */
function MessageGroup({
  title,
  messages,
  dmId,
}: {
  title?: string;
  messages: readonly MessageDTO[];
  dmId: string | null;
}) {
  return (
    <div>
      {title && <h3 className="pb-1 text-xs font-semibold text-ink-faint">{title}</h3>}
      <ol className="-mx-3 flex flex-col gap-0.5">
        {messages.map((m) => (
          <li key={`${m.conversationId}:${m.ts}`}>
            <HitRow hit={{ message: m, snippet: '' }} showConversation={m.conversationId !== dmId} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function Recent({ person }: { person: PersonDTO }) {
  return (
    <Card title="Recent between you" icon={<HistoryIcon size={15} />}>
      {person.recent.length > 0 ? (
        <MessageGroup messages={person.recent} dmId={person.dm?.conversationId ?? null} />
      ) : (
        <p className="text-sm text-ink-muted">Nothing yet: no DM, group DM or mention between you.</p>
      )}
    </Card>
  );
}

// ─── where you talk ──────────────────────────────────────────────────────────────────────────

function Places({ person, user, first }: { person: PersonDTO; user: UserDTO | undefined; first: string }) {
  const dir = useDirectory();
  const [allChannels, setAllChannels] = useState(false);
  const handle = user?.name && user.name !== person.userId ? user.name : null;
  const channels = allChannels ? person.channels : person.channels.slice(0, CHANNELS_SHOWN);
  const privates: PersonConversationDTO[] = person.dm ? [person.dm, ...person.groupDms] : person.groupDms;
  if (!privates.length && !person.channels.length) return null;
  return (
    <Card title={person.isSelf ? 'Where you write' : 'Where you talk'} icon={<HashIcon size={15} />}>
      {privates.length > 0 && (
        <ul className="-mx-2 flex flex-col gap-px">
          {privates.map((c) => {
            const conv = dir.conversations.get(c.conversationId);
            const isDm = c === person.dm;
            return (
              <li key={c.conversationId}>
                <PlaceRow
                  to={conversationPath(c.conversationId)}
                  icon={isDm ? <MessageIcon size={14} /> : <UsersIcon size={14} />}
                  title={isDm ? 'Direct messages' : groupTitle(conv, person.userId, dir)}
                  detail={placeDetail(c)}
                />
              </li>
            );
          })}
        </ul>
      )}
      {person.channels.length > 0 && (
        <div>
          <h3 className="pb-1 text-xs font-semibold text-ink-faint">
            {person.isSelf ? 'Channels you write in' : `Channels ${first} writes in`}
          </h3>
          <ul className="-mx-2 flex flex-col gap-px">
            {channels.map((c) => {
              const conv = dir.conversations.get(c.conversationId);
              const channel = conv?.rawName ?? conv?.label ?? c.conversationId;
              // Their messages there, found by search; the channel itself when it can't be named.
              const who = person.isSelf ? 'me' : handle ? `@${handle}` : null;
              const to =
                who && conv?.rawName
                  ? searchPath(`from:${who} in:#${conv.rawName}`)
                  : conversationPath(c.conversationId);
              return (
                <li key={c.conversationId}>
                  <PlaceRow
                    to={to}
                    icon={conv?.type === 'private_channel' ? <LockIcon size={13} /> : <HashIcon size={14} />}
                    title={channel}
                    detail={placeDetail(c)}
                    tooltip={`${person.isSelf ? 'Your' : `${first}’s`} messages in #${channel}`}
                  />
                </li>
              );
            })}
          </ul>
          {person.channels.length > CHANNELS_SHOWN && (
            <button
              type="button"
              onClick={() => setAllChannels((v) => !v)}
              className="focus-ring mt-1 rounded-sm text-[13px] font-medium text-accent-text hover:underline"
            >
              {allChannels ? 'Show fewer' : `Show all ${person.channels.length}`}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

/** A group DM on someone's page: "With Dana and Felix", the others in it (not you, not them). */
function groupTitle(conv: ConversationDTO | undefined, personId: string, dir: Directory): string {
  const others = (conv?.memberIds ?? [])
    .filter((id) => id !== personId && id !== dir.selfUserId)
    .map((id) => dir.users.get(id)?.label ?? id);
  if (others.length) return `With ${joinNames(others)}`;
  return conv?.label ?? 'Group DM';
}

function placeDetail(c: PersonConversationDTO): string {
  const last = c.latestTs ? formatShortDate(tsToDate(c.latestTs)) : null;
  return [pluralize(c.messageCount, 'message'), last].filter(Boolean).join(' · ');
}

function PlaceRow({
  to,
  icon,
  title,
  detail,
  tooltip,
}: {
  to: string;
  icon: ReactNode;
  title: string;
  detail: string;
  tooltip?: string;
}) {
  return (
    <Link
      to={to}
      title={tooltip}
      className="focus-ring flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] transition-colors hover:bg-hover"
    >
      <span className="shrink-0 text-ink-faint">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-ink">{title}</span>
      <span className="shrink-0 text-xs text-ink-faint tabular-nums">{detail}</span>
    </Link>
  );
}

// ─── what they shared ────────────────────────────────────────────────────────────────────────

interface SharedFile {
  file: FileDTO;
  message: MessageDTO;
}

function Shared({ person, user, first }: { person: PersonDTO; user: UserDTO | undefined; first: string }) {
  const [more, setMore] = useState(false);
  const files: SharedFile[] = person.fileMessages.flatMap((message) =>
    message.files.map((file) => ({ file, message })),
  );
  if (!files.length && !person.links.length) return null;
  const handle = person.isSelf ? 'me' : user?.name && user.name !== person.userId ? `@${user.name}` : null;
  const shownFiles = more ? files : files.slice(0, FILES_SHOWN);
  const shownLinks = more ? person.links : person.links.slice(0, LINKS_SHOWN);
  const images = shownFiles.filter((f) => f.file.isImage && (f.file.thumbUrl || f.file.url));
  const others = shownFiles.filter((f) => !images.includes(f));
  const hidden = files.length - shownFiles.length + person.links.length - shownLinks.length;
  return (
    <Card title={person.isSelf ? 'Shared by you' : `Shared by ${first}`} icon={<FileIcon size={15} />}>
      {images.length > 0 && (
        <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-4" aria-label="Images">
          {images.map(({ file, message }) => (
            <li key={`${file.id}:${message.ts}`}>
              <Link
                to={messagePath(message)}
                title={`${file.title || file.name || 'Image'} · ${formatShortDate(tsToDate(message.ts))}`}
                className="focus-ring block aspect-square overflow-hidden rounded-lg border border-line bg-inset transition-opacity hover:opacity-85"
              >
                <img
                  src={file.thumbUrl ?? file.url ?? undefined}
                  alt={file.title || file.name || 'Image'}
                  loading="lazy"
                  className="size-full object-cover"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="-mx-2 flex flex-col gap-px" aria-label="Files">
          {others.map(({ file, message }) => (
            <li key={`${file.id}:${message.ts}`}>
              <PlaceRow
                to={messagePath(message)}
                icon={<FileIcon size={14} />}
                title={file.title || file.name || 'File'}
                detail={[
                  file.available ? file.filetype?.toUpperCase() : 'Not archived',
                  formatShortDate(tsToDate(message.ts)),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            </li>
          ))}
        </ul>
      )}
      {shownLinks.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Links">
          {shownLinks.map((link) => (
            <LinkRow key={link.url} link={link} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setMore(true)}
            className="focus-ring rounded-sm font-medium text-accent-text hover:underline"
          >
            Show {hidden} more
          </button>
        )}
        {handle && files.length > 0 && (
          <Link
            to={searchPath(`from:${handle} has:file`)}
            className="focus-ring rounded-sm text-ink-muted hover:text-ink hover:underline"
          >
            All files
          </Link>
        )}
        {handle && person.links.length > 0 && (
          <Link
            to={searchPath(`from:${handle} has:link`)}
            className="focus-ring rounded-sm text-ink-muted hover:text-ink hover:underline"
          >
            All links
          </Link>
        )}
      </div>
    </Card>
  );
}

/** The address opens in the browser; the date opens the message it came in. */
function LinkRow({ link }: { link: PersonLinkDTO }) {
  const short = shortUrl(link.url);
  return (
    <li className="flex min-w-0 items-baseline gap-2 text-[13.5px]">
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        title={link.url}
        className="focus-ring min-w-0 flex-1 truncate rounded-sm text-accent-text hover:underline"
      >
        {link.label ?? short}
        {link.label && <span className="ml-1.5 text-xs text-ink-faint">{short.split('/')[0]}</span>}
      </a>
      <Link
        to={messagePath(link)}
        title="The message it came in"
        className="focus-ring shrink-0 rounded-sm text-xs text-ink-faint tabular-nums hover:text-ink-muted hover:underline"
      >
        {formatShortDate(tsToDate(link.ts))}
      </Link>
    </li>
  );
}
