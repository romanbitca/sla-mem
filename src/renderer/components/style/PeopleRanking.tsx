import { Link } from 'react-router';
import clsx from 'clsx';
import type { ReplyPersonDTO, StyleDTO } from '../../../shared/types';
import { useDirectory } from '../../lib/directory';
import { pluralize } from '../../lib/format';
import { personPath } from '../../lib/links';
import { formatWait } from '../../lib/style';
import { UsersIcon } from '../icons';
import { Avatar } from '../message/Avatar';
import { Card } from '../ui/Card';
import { InfoTip } from '../ui/InfoTip';
import { RankingInfo } from './Explain';

/**
 * Whom you answer fastest and slowest, by your average on working time: at most ten each, never the
 * same person on both lists, only people you answered a few times. Each opens their page.
 */
export function PeopleRanking({ style }: { style: StyleDTO }) {
  if (!style.fastest.length && !style.slowest.length) return null;
  return (
    <Card
      title="Who you answer fastest and slowest"
      icon={<UsersIcon size={15} />}
      info={
        <InfoTip label="How the lists are made" align="start">
          <RankingInfo style={style} />
        </InfoTip>
      }
      aside={
        <span className="text-xs text-ink-faint">
          People you answered at least {pluralize(style.rules.rankMinAnswers, 'time')}
        </span>
      }
    >
      <div className={clsx('grid gap-5', style.fastest.length && style.slowest.length && 'sm:grid-cols-2')}>
        <Ranking title="Fastest" people={style.fastest} />
        <Ranking title="Slowest" people={style.slowest} />
      </div>
    </Card>
  );
}

function Ranking({ title, people }: { title: string; people: ReplyPersonDTO[] }) {
  const { users } = useDirectory();
  if (!people.length) return null;
  return (
    <div className="min-w-0">
      <h3 className="pb-1.5 text-xs font-semibold text-ink-faint">{title}</h3>
      <ol className="-mx-2 flex flex-col gap-px">
        {people.map((p, i) => {
          const user = users.get(p.userId);
          const label = user?.label ?? p.userId;
          return (
            <li key={p.userId}>
              <Link
                to={personPath(p.userId)}
                title={`${pluralize(p.count, 'answer')} to ${label}`}
                className="focus-ring flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] transition-colors hover:bg-hover"
              >
                <span className="w-4 shrink-0 text-right text-xs text-ink-faint tabular-nums">{i + 1}</span>
                <Avatar seed={p.userId} label={label} src={user?.avatarUrl ?? null} size={22} />
                <span className="min-w-0 flex-1 truncate text-ink">{label}</span>
                <span className="shrink-0 text-ink-muted tabular-nums">{formatWait(p.averageSeconds)}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
