import { TrashIcon } from '../icons';
import { Tooltip } from '../ui/Tooltip';

const EXPLANATION = 'Deleted in Slack after it was archived. The archive keeps the last version it saw.';

export function DeletedBadge() {
  return (
    <Tooltip label={EXPLANATION}>
      <span
        tabIndex={0}
        aria-label={`Deleted in Slack. ${EXPLANATION}`}
        className="focus-ring inline-flex h-5 items-center gap-1 rounded-full bg-danger-soft px-1.5 text-[11px] font-semibold text-danger"
      >
        <TrashIcon size={11} strokeWidth={2} />
        Deleted in Slack
      </span>
    </Tooltip>
  );
}
