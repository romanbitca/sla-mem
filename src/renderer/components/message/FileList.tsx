import { memo, useState, type ComponentType } from 'react';
import clsx from 'clsx';
import type { FileDTO } from '../../../shared/types';
import { describeError } from '../../lib/api';
import { fileBrowserName } from '../../lib/bridge';
import { formatBytes } from '../../lib/format';
import { useOpenFile, useRetryFile, useRevealFile } from '../../lib/queries';
import { remoteImageSrc } from '../../lib/remoteImage';
import { safeHref } from '../../lib/safeUrl';
import {
  AlertIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileTextIcon,
  FilmIcon,
  FolderIcon,
  ImageIcon,
  MusicIcon,
  SyncIcon,
  type IconProps,
} from '../icons';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Lightbox } from './Lightbox';

const CODE_TYPES = new Set([
  'javascript',
  'typescript',
  'python',
  'json',
  'yaml',
  'xml',
  'html',
  'css',
  'shell',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'ruby',
  'php',
  'sql',
  'c',
  'cpp',
  'csharp',
  'diff',
  'markdown',
  'text',
]);
const ARCHIVE_TYPES = new Set(['zip', 'gzip', 'tar', 'rar', '7z', 'bz2', 'dmg']);

export function fileIconFor(file: FileDTO): ComponentType<IconProps> {
  const mime = file.mimetype ?? '';
  const type = (file.filetype ?? '').toLowerCase();
  if (file.isImage || mime.startsWith('image/')) return ImageIcon;
  if (mime.startsWith('video/')) return FilmIcon;
  if (mime.startsWith('audio/')) return MusicIcon;
  if (ARCHIVE_TYPES.has(type) || /zip|compressed|x-tar/.test(mime)) return FileArchiveIcon;
  if (CODE_TYPES.has(type) && type !== 'text') return FileCodeIcon;
  if (mime === 'application/pdf' || mime.startsWith('text/') || /word|document|sheet|presentation/.test(mime)) {
    return FileTextIcon;
  }
  return FileIcon;
}

export interface FileStatusNote {
  /** Short state, shown first: "Not archived", "Couldn’t download"… */
  label: string;
  /** Why, in main's words ("Removed from Slack", "Too large (320 MB)"), when it adds anything. */
  reason: string | null;
  /** A failed download can be tried again from the card. */
  retry: boolean;
}

/** Why a file has no local copy, phrased for the reader; null when it's archived. */
export function fileStatusNote(file: Pick<FileDTO, 'available' | 'status' | 'statusReason'>): FileStatusNote | null {
  if (file.available) return null;
  const reason = (label: string) => (file.statusReason && file.statusReason !== label ? file.statusReason : null);
  switch (file.status) {
    case 'pending':
      return { label: 'Not downloaded yet', reason: reason('Not downloaded yet'), retry: false };
    case 'failed':
      return { label: 'Couldn’t download', reason: reason('Couldn’t download'), retry: true };
    default:
      return { label: 'Not archived', reason: reason('Not archived'), retry: false };
  }
}

function fileTitle(file: FileDTO): string {
  return file.title || file.name || 'Untitled file';
}

function fileMeta(file: FileDTO): string {
  const type = file.filetype ? file.filetype.toUpperCase() : null;
  return [type, formatBytes(file.size)].filter(Boolean).join(' · ');
}

/** Images a message can show inline: saved locally with something displayable. */
function isViewableImage(file: FileDTO): boolean {
  return file.isImage && file.available && Boolean(file.thumbUrl || file.url);
}

export const FileList = memo(function FileList({ files }: { files: FileDTO[] }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  if (files.length === 0) return null;

  const images = files.filter(isViewableImage);
  const others = files.filter((f) => !isViewableImage(f));

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {images.length > 0 && <ImageGrid images={images} onOpen={setLightboxIndex} />}
      {others.map((file) => (
        <FileCard key={file.id} file={file} />
      ))}
      {lightboxIndex != null && (
        <Lightbox
          images={images}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
});

function ImageGrid({ images, onOpen }: { images: FileDTO[]; onOpen: (index: number) => void }) {
  const single = images.length === 1;
  return (
    <div className={clsx('flex flex-wrap gap-1.5', !single && 'max-w-[480px]')}>
      {images.map((file, i) => {
        const title = fileTitle(file);
        const ratio = file.width && file.height ? file.width / file.height : null;
        return (
          <button
            key={file.id}
            type="button"
            onClick={() => onOpen(i)}
            aria-label={`View image ${title}`}
            title={title}
            className={clsx(
              'focus-ring group/img relative overflow-hidden rounded-lg border border-line bg-inset',
              'transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-pop',
              single ? 'max-w-[min(100%,380px)]' : 'size-[150px]',
            )}
            // Reserving the box from the known size keeps scroll anchoring stable as images load.
            style={
              single && ratio
                ? { aspectRatio: String(ratio), width: Math.min(380, file.width ?? 380), maxHeight: 340 }
                : undefined
            }
          >
            <img
              src={remoteImageSrc(file.thumbUrl ?? file.url) ?? undefined}
              alt={title}
              loading="lazy"
              decoding="async"
              className={clsx('block size-full', single ? 'max-h-[340px] object-contain' : 'object-cover')}
            />
          </button>
        );
      })}
    </div>
  );
}

/**
 * One attachment that isn't shown in the image grid: documents, media, and anything not archived.
 * Attachments are untrusted, so nothing but raster previews and media players render inline;
 * everything else opens with the system app (PLAN §3.6).
 */
export const FileCard = memo(function FileCard({ file }: { file: FileDTO }) {
  const Icon = fileIconFor(file);
  const note = fileStatusNote(file);
  const title = fileTitle(file);
  const permalink = safeHref(file.permalink);
  const mime = file.mimetype ?? '';
  const isMedia = mime.startsWith('video/') || mime.startsWith('audio/');
  // `url` is only set for types that are safe inline (archive://file/…): here, video and audio.
  const media = file.available && file.url && isMedia ? remoteImageSrc(file.url) : null;
  // A saved thumbnail (e.g. a PDF's first page) previews documents without rendering them.
  const preview = !media && file.thumbUrl ? remoteImageSrc(file.thumbUrl) : null;
  const open = useOpenFile();
  const reveal = useRevealFile();
  const retry = useRetryFile();
  const actionError = open.error ?? reveal.error ?? retry.error;
  const meta = fileMeta(file);

  return (
    <div
      className={clsx(
        'flex max-w-[480px] flex-col gap-2 rounded-lg border px-3 py-2.5',
        note ? 'border-dashed border-line-strong bg-transparent' : 'border-line bg-raised',
      )}
      data-file-status={file.status}
    >
      {preview && (
        <button
          type="button"
          onClick={() => file.available && open.mutate(file.id)}
          disabled={!file.available}
          aria-label={`Open ${title}`}
          className="focus-ring overflow-hidden rounded-md border border-line bg-inset enabled:hover:border-line-strong"
        >
          <img
            src={preview}
            alt=""
            loading="lazy"
            decoding="async"
            className="block max-h-[180px] w-full object-contain object-top"
          />
        </button>
      )}
      <div className="flex items-center gap-3">
        <span
          className={clsx(
            'flex size-9 shrink-0 items-center justify-center rounded-md',
            note ? 'bg-inset text-ink-faint' : 'bg-accent-soft text-accent-text',
          )}
        >
          {note ? <EyeOffIcon size={18} /> : <Icon size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className={clsx('truncate text-sm font-medium', note ? 'text-ink-muted' : 'text-ink')} title={title}>
            {title}
          </p>
          <p className="truncate text-xs text-ink-faint">
            {note ? (
              <span>
                <span className={clsx('font-medium', note.retry ? 'text-danger' : 'text-warn')}>{note.label}</span>
                {note.reason && ` · ${note.reason}`}
                {meta && ` · ${meta}`}
              </span>
            ) : (
              meta || 'File'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {file.available && (
            <>
              <Button size="sm" variant="ghost" loading={open.isPending} onClick={() => open.mutate(file.id)}>
                Open
              </Button>
              <IconButton
                label={`Show ${title} in ${fileBrowserName() ?? 'folder'}`}
                title={`Show in ${fileBrowserName() ?? 'folder'}`}
                icon={<FolderIcon size={15} />}
                onClick={() => reveal.mutate(file.id)}
              />
            </>
          )}
          {note?.retry && (
            <Button
              size="sm"
              variant="secondary"
              icon={<SyncIcon size={13} />}
              loading={retry.isPending}
              disabled={retry.isSuccess}
              onClick={() => retry.mutate(file.id)}
            >
              {retry.isSuccess ? 'Retrying…' : 'Retry'}
            </Button>
          )}
          {permalink && (
            <a
              href={permalink}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${title} in Slack`}
              title="Open in Slack"
              className="focus-ring inline-flex size-8 items-center justify-center rounded-md text-ink-muted hover:bg-hover hover:text-ink"
            >
              <ExternalLinkIcon size={15} />
            </a>
          )}
        </div>
      </div>
      {retry.isSuccess && (
        <p role="status" className="text-xs text-ink-muted">
          Downloading again. It appears here once it’s saved.
        </p>
      )}
      {actionError != null && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-danger">
          <AlertIcon size={13} className="shrink-0" />
          {describeError(actionError)}
        </p>
      )}
      {media &&
        (mime.startsWith('video/') ? (
          <video controls preload="metadata" src={media} className="max-h-[320px] w-full rounded-md bg-black" />
        ) : (
          <audio controls preload="metadata" src={media} className="w-full" />
        ))}
    </div>
  );
});
