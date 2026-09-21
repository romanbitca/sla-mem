import { memo, useState } from 'react';
import clsx from 'clsx';
import type { AttachmentDTO } from '../../../shared/types';
import { Mrkdwn } from '../../lib/mrkdwn';
import { remoteImageSrc } from '../../lib/remoteImage';
import { attachmentColor, safeHref } from '../../lib/safeUrl';
import { BlockKit } from './BlockKit';

/** Link unfurls, bot attachments and shared messages, as quiet cards with a colored rail. */
export const Attachments = memo(function Attachments({ attachments }: { attachments: AttachmentDTO[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {attachments.map((a, i) => (
        <AttachmentCard key={`${a.fromUrl ?? a.titleLink ?? ''}:${i}`} attachment={a} />
      ))}
    </div>
  );
});

function hasBody(a: AttachmentDTO): boolean {
  return Boolean(a.title || a.text || a.authorName || a.serviceName || a.imageUrl || a.fields.length || a.footer);
}

export function AttachmentCard({ attachment: a }: { attachment: AttachmentDTO }) {
  const color = attachmentColor(a.color);
  // Newer apps put Block Kit inside attachments (for the colour rail); those blocks are the
  // content, and the legacy fields are only a fallback (pitfall 16).
  const blocks = a.blocks ?? [];
  if (blocks.length > 0) {
    return (
      <div className="max-w-[560px]">
        {a.pretext && (
          <div className="msg-text mb-1">
            <Mrkdwn text={a.pretext} />
          </div>
        )}
        <div
          className="rounded-r-lg border-l-[3px] bg-inset/60 py-1.5 pr-3 pl-3"
          style={{ borderLeftColor: color ?? 'var(--c-line-strong)' }}
        >
          <BlockKit blocks={blocks} className="text-[14px]" />
        </div>
      </div>
    );
  }

  const titleHref = safeHref(a.titleLink ?? (a.isMsgUnfurl ? null : a.fromUrl));
  const authorHref = safeHref(a.authorLink);
  const bodyText = a.text ?? (hasBody(a) ? null : a.fallback);

  return (
    <div className="max-w-[560px]">
      {a.pretext && (
        <div className="msg-text mb-1">
          <Mrkdwn text={a.pretext} />
        </div>
      )}
      <div
        className={clsx(
          'flex gap-3 rounded-r-lg border-l-[3px] py-1.5 pr-3 pl-3',
          a.isMsgUnfurl ? 'bg-transparent' : 'bg-inset/60',
        )}
        style={{ borderLeftColor: color ?? 'var(--c-line-strong)' }}
      >
        <div className="min-w-0 flex-1">
          {(a.serviceName || a.serviceIcon) && !a.isMsgUnfurl && (
            <div className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-ink-faint">
              <RemoteIcon src={a.serviceIcon} size={14} />
              <span className="truncate">{a.serviceName}</span>
            </div>
          )}
          {a.authorName && (
            <div className="mb-0.5 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
              <RemoteIcon src={a.authorIcon} size={a.isMsgUnfurl ? 18 : 16} rounded />
              {authorHref ? (
                <a href={authorHref} target="_blank" rel="noopener noreferrer" className="truncate hover:underline">
                  {a.authorName}
                </a>
              ) : (
                <span className="truncate">{a.authorName}</span>
              )}
            </div>
          )}
          {a.title && (
            <div className="text-sm font-semibold">
              {titleHref ? (
                <a href={titleHref} target="_blank" rel="noopener noreferrer" className="md-link">
                  {a.title}
                </a>
              ) : (
                <span className="text-ink">{a.title}</span>
              )}
            </div>
          )}
          {bodyText && (
            <div className="msg-text mt-0.5 text-[14px] text-ink">
              <Mrkdwn text={bodyText} />
            </div>
          )}
          {a.fields.length > 0 && (
            <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
              {a.fields.map((f, i) => (
                <div key={`${f.title}:${i}`} className={f.short ? 'col-span-1' : 'col-span-2'}>
                  {f.title && <dt className="text-xs font-semibold text-ink">{f.title}</dt>}
                  <dd className="text-[13px] text-ink-muted">
                    <Mrkdwn text={f.value} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <AttachmentImage src={a.imageUrl} alt={a.title ?? a.fallback ?? ''} />
          {a.footer && (
            <div className="mt-1 text-xs text-ink-faint">
              <Mrkdwn text={a.footer} inline />
            </div>
          )}
        </div>
        <AttachmentThumb src={a.thumbUrl} />
      </div>
    </div>
  );
}

function AttachmentImage({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  const safe = remoteImageSrc(src);
  if (!safe || failed) return null;
  return (
    <img
      src={safe}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="mt-2 block max-h-[300px] max-w-full rounded-md border border-line object-contain"
    />
  );
}

function AttachmentThumb({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  const safe = remoteImageSrc(src);
  if (!safe || failed) return null;
  return (
    <img
      src={safe}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-16 shrink-0 rounded-md object-cover"
    />
  );
}

/** Service/author icons are remote (and may be gone): hide rather than show a broken image. */
function RemoteIcon({ src, size, rounded = false }: { src: string | null; size: number; rounded?: boolean }) {
  const [failed, setFailed] = useState(false);
  const safe = remoteImageSrc(src);
  if (!safe || failed) return null;
  return (
    <img
      src={safe}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={clsx('shrink-0 object-cover', rounded ? 'rounded' : 'rounded-sm')}
    />
  );
}
