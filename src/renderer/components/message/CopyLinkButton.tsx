import { copyText } from '../../lib/clipboard';
import { useFlag } from '../../lib/hooks';
import { CheckIcon, LinkIcon } from '../icons';
import { IconButton } from '../ui/IconButton';

/**
 * Copies the message's Slack link (see `slackPermalink`). The archive itself lives only on this
 * computer, so its own addresses would mean nothing to anyone else.
 */
export function CopyLinkButton({ url }: { url: string }) {
  const [copied, flash] = useFlag(1600);
  return (
    <IconButton
      size="sm"
      label={copied ? 'Link copied' : 'Copy link to this message in Slack'}
      icon={copied ? <CheckIcon size={15} className="text-success" /> : <LinkIcon size={15} />}
      onClick={async () => {
        if (await copyText(url)) flash();
      }}
    />
  );
}
