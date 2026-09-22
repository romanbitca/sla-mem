import { useState } from 'react';
import clsx from 'clsx';
import { remoteImageSrc } from '../../lib/remoteImage';

export interface WorkspaceIconProps {
  /** The workspace name: its first letter stands in for the logo. */
  name: string;
  /** The logo Slack has for the workspace (a Slack image URL), if a sync has read it. */
  icon?: string | null;
  /** Size, corner radius and the initial's font size. */
  className?: string;
}

/**
 * The workspace's logo, or its initial on the accent colour when it has none, no sync has read it
 * yet, or the image can't load (offline). Decorative: the name is always shown beside it.
 */
export function WorkspaceIcon({ name, icon, className }: WorkspaceIconProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = remoteImageSrc(icon);
  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedSrc(src)}
        className={clsx('shrink-0 bg-inset object-cover', className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={clsx('flex shrink-0 items-center justify-center bg-accent font-bold text-accent-ink', className)}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
