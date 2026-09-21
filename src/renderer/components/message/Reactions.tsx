import { memo } from 'react';
import type { ReactionDTO } from '../../../shared/types';
import { Emoji } from '../../lib/mrkdwn';
import { useDirectory, userLabel } from '../../lib/directory';
import { joinNames } from '../../lib/format';
import { Tooltip } from '../ui/Tooltip';

/** Slack encodes skin tones inside reaction names: "+1::skin-tone-3". */
function displayName(name: string): string {
  return `:${name.split('::')[0]}:`;
}

export function reactionSummary(reaction: ReactionDTO, names: string[]): string {
  const who = names.length ? joinNames(names, 4) : `${reaction.count} ${reaction.count === 1 ? 'person' : 'people'}`;
  // `users` may be truncated by Slack for popular reactions: account for the rest.
  const hidden = Math.max(0, reaction.count - names.length);
  const extra = names.length && hidden ? ` and ${hidden} more` : '';
  return `${who}${extra} reacted with ${displayName(reaction.name)}`;
}

/** Read-only reaction pills; the tooltip names who reacted. */
export const Reactions = memo(function Reactions({ reactions }: { reactions: ReactionDTO[] }) {
  const dir = useDirectory();
  if (reactions.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Reactions">
      {reactions.map((reaction) => {
        const summary = reactionSummary(
          reaction,
          reaction.users.map((id) => userLabel(dir, id)),
        );
        return (
          <li key={reaction.name}>
            <Tooltip label={summary}>
              <span
                tabIndex={0}
                aria-label={summary}
                className="focus-ring inline-flex h-6 items-center gap-1 rounded-full border border-line bg-raised px-2 text-xs font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
              >
                <Emoji name={reaction.name} size={15} />
                <span className="tabular-nums">{reaction.count}</span>
              </span>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
});
