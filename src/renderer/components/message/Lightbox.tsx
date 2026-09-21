import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { FileDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { fileBrowserName } from '../../lib/bridge';
import { formatBytes } from '../../lib/format';
import { trapTab, useKeydown } from '../../lib/hooks';
import { useOpenFile, useRevealFile } from '../../lib/queries';
import { remoteImageSrc } from '../../lib/remoteImage';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, ExternalLinkIcon, FolderIcon } from '../icons';
import { IconButton } from '../ui/IconButton';

export interface LightboxProps {
  images: FileDTO[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * Full-screen image viewer. Esc closes, ←/→ step through the message's images.
 * Keys are handled in the capture phase and consumed so Esc doesn't also close the thread.
 */
export function Lightbox({ images, index, onIndexChange, onClose }: LightboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = useOpenFile();
  const reveal = useRevealFile();
  const file = images[index];
  const count = images.length;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  useKeydown(
    (e) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight' && count > 1) {
        e.preventDefault();
        onIndexChange((index + 1) % count);
      } else if (e.key === 'ArrowLeft' && count > 1) {
        e.preventDefault();
        onIndexChange((index - 1 + count) % count);
      } else {
        // A modal: Tab cycles through the viewer's own buttons, never the page behind it.
        trapTab(e, rootRef.current);
      }
    },
    { overlay: true },
  );

  if (!file) return null;
  // The full image when it's safe to show inline, else the thumbnail Slack made of it.
  const src = remoteImageSrc(file.url ?? file.thumbUrl) ?? undefined;
  const title = file.title || file.name || 'Image';
  const error = open.error ?? reveal.error;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image viewer: ${title}`}
      className="fixed inset-0 z-50 flex animate-fade-in flex-col bg-scrim backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header className="flex items-center gap-3 bg-black/40 px-4 py-2.5 text-white">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="text-xs text-white/65">
            {count > 1 && `${index + 1} of ${count}`}
            {count > 1 && file.size ? ' · ' : ''}
            {formatBytes(file.size)}
          </p>
          {error != null && (
            <p role="alert" className="text-xs text-white">
              {describeError(error)}
            </p>
          )}
        </div>
        <IconButton
          label="Open with the default app"
          icon={<ExternalLinkIcon size={17} />}
          onClick={() => open.mutate(file.id)}
          variant="overlay"
        />
        <IconButton
          label={`Show in ${fileBrowserName() ?? 'folder'}`}
          icon={<FolderIcon size={17} />}
          onClick={() => reveal.mutate(file.id)}
          variant="overlay"
        />
        <IconButton
          ref={closeRef}
          label="Close image viewer"
          icon={<CloseIcon size={18} />}
          onClick={onClose}
          variant="overlay"
        />
      </header>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-4 sm:p-8"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {src && (
          <img
            key={file.id}
            src={src}
            alt={title}
            className="max-h-full max-w-full animate-pop-in rounded-md object-contain shadow-2xl"
          />
        )}
        {count > 1 && (
          <>
            <IconButton
              label="Previous image"
              icon={<ChevronLeftIcon size={22} />}
              onClick={() => onIndexChange((index - 1 + count) % count)}
              variant="overlay"
              size="lg"
              className="absolute top-1/2 left-3 -translate-y-1/2"
            />
            <IconButton
              label="Next image"
              icon={<ChevronRightIcon size={22} />}
              onClick={() => onIndexChange((index + 1) % count)}
              variant="overlay"
              size="lg"
              className="absolute top-1/2 right-3 -translate-y-1/2"
            />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
