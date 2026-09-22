import { memo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import type { BlockDTO } from '../../../shared/types';
import {
  elementLabel,
  isBlock,
  isObj,
  listMarker,
  objects,
  plainTextNodes,
  richBlockNodes,
  richList,
  richPreformatted,
  richQuote,
  str,
  textObject,
  type Loose,
} from '../../lib/blockkit';
import { Mrkdwn, MrkdwnNodes } from '../../lib/mrkdwn';
import { remoteImageSrc } from '../../lib/remoteImage';
import { linkTitle, safeHref } from '../../lib/safeUrl';
import { FileIcon, FilmIcon } from '../icons';

/**
 * Slack Block Kit layouts (app and bot messages; PLAN §7). Shown instead of the message's
 * `text`, which for these messages is only the notification fallback (pitfall 15). Everything is
 * built from React nodes; interactive elements are drawn but inert: the archive can't act on
 * Slack's behalf. Unknown block types show their text when they have one, otherwise nothing.
 */
export const BlockKit = memo(function BlockKit({ blocks, className }: { blocks: BlockDTO[]; className?: string }) {
  const valid = blocks.filter(isBlock);
  if (valid.length === 0) return null;
  return (
    <div className={clsx('bk-root msg-text flex flex-col gap-1.5 text-ink', className)}>
      {valid.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
});

function Block({ block }: { block: BlockDTO }) {
  switch (block.type) {
    case 'rich_text':
      return <RichTextBlock block={block} />;
    case 'header':
      return <HeaderBlock block={block} />;
    case 'section':
      return <SectionBlock block={block} />;
    case 'context':
      return <ContextBlock block={block} />;
    case 'divider':
      return <hr className="my-1 border-line" />;
    case 'image':
      return <ImageBlock block={block} />;
    case 'actions':
      return <ActionsBlock block={block} />;
    case 'video':
      return <VideoBlock block={block} />;
    case 'file':
      return <FileBlock block={block} />;
    default:
      return <FallbackBlock block={block} />;
  }
}

/** A Block Kit text object: mrkdwn is parsed, plain text is literal (with emoji). */
export function TextObjectView({ value, inline, className }: { value: unknown; inline?: boolean; className?: string }) {
  const t = textObject(value);
  if (!t) return null;
  if (t.kind === 'mrkdwn') return <Mrkdwn text={t.text} inline={inline} className={className} />;
  return <MrkdwnNodes nodes={plainTextNodes(t.text, t.emoji)} inline={inline} className={className} />;
}

function HeaderBlock({ block }: { block: Loose }) {
  return <TextObjectView value={block.text} className="text-[16px] leading-snug font-bold text-ink" />;
}

function SectionBlock({ block }: { block: Loose }) {
  const fields = objects(block.fields).filter((f) => textObject(f) != null);
  const accessory = isObj(block.accessory) ? block.accessory : null;
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <TextObjectView value={block.text} />
        {fields.length > 0 && (
          <div className={clsx('grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2', textObject(block.text) && 'mt-2')}>
            {fields.map((field, i) => (
              <TextObjectView key={i} value={field} className="min-w-0" />
            ))}
          </div>
        )}
      </div>
      {accessory && <Accessory element={accessory} />}
    </div>
  );
}

function Accessory({ element }: { element: Loose }) {
  if (element.type === 'image') {
    return (
      <RemoteImage
        src={str(element.image_url)}
        alt={str(element.alt_text)}
        className="size-18 shrink-0 rounded-md object-cover"
      />
    );
  }
  if (element.type === 'button') return <InertButton element={element} />;
  const label = elementLabel(element);
  return label ? <InertControl label={label} /> : null;
}

function ContextBlock({ block }: { block: Loose }) {
  const elements = objects(block.elements);
  if (elements.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-snug text-ink-muted">
      {elements.map((el, i) =>
        el.type === 'image' ? (
          <RemoteImage
            key={i}
            src={str(el.image_url)}
            alt={str(el.alt_text)}
            className="size-4 rounded-sm object-cover"
          />
        ) : (
          <TextObjectView key={i} value={el} inline />
        ),
      )}
    </div>
  );
}

function ImageBlock({ block }: { block: Loose }) {
  const title = textObject(block.title);
  const src = str(block.image_url) || (isObj(block.slack_file) ? str(block.slack_file.url) : '');
  return (
    <figure className="flex flex-col gap-1">
      {title && (
        <figcaption className="text-[13px] font-semibold text-ink">
          <TextObjectView value={block.title} inline />
        </figcaption>
      )}
      <RemoteImage
        src={src}
        alt={str(block.alt_text) || title?.text || ''}
        className="block max-h-[300px] max-w-full self-start rounded-md border border-line object-contain"
      />
    </figure>
  );
}

function ActionsBlock({ block }: { block: Loose }) {
  const elements = objects(block.elements);
  if (elements.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {elements.map((el, i) => {
        if (el.type === 'button') return <InertButton key={i} element={el} />;
        const label = elementLabel(el);
        return label ? <InertControl key={i} label={label} /> : null;
      })}
    </div>
  );
}

const INERT_TITLE = 'Buttons from Slack apps don’t work in the archive';

const BUTTON_STYLE: Record<string, string> = {
  primary: 'border-success/40 text-success',
  danger: 'border-danger/40 text-danger',
};

/** App buttons can't be pressed here; link buttons may still open their web page. */
function InertButton({ element }: { element: Loose }) {
  const label = elementLabel(element);
  if (!label) return null;
  const href = safeHref(str(element.url));
  const classes = clsx(
    'inline-flex h-7 max-w-full items-center rounded-md border bg-raised px-2.5 text-[13px] font-medium',
    BUTTON_STYLE[str(element.style)] ?? 'border-line text-ink-muted',
  );
  if (href) {
    return (
      <a
        href={href}
        title={linkTitle(label, href)}
        target="_blank"
        rel="noopener noreferrer"
        className={clsx(classes, 'focus-ring hover:bg-hover')}
      >
        <span className="truncate">{label}</span>
      </a>
    );
  }
  return (
    <span className={clsx(classes, 'cursor-default opacity-80')} title={INERT_TITLE}>
      <span className="truncate">{label}</span>
    </span>
  );
}

function InertControl({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-7 max-w-full cursor-default items-center rounded-md border border-dashed border-line px-2.5 text-[13px] text-ink-muted"
      title={INERT_TITLE}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

function VideoBlock({ block }: { block: Loose }) {
  const title = textObject(block.title);
  const href = safeHref(str(block.title_url)) ?? safeHref(str(block.video_url));
  const provider = [str(block.provider_name), str(block.author_name)].filter(Boolean).join(' · ');
  return (
    <div className="flex max-w-[480px] gap-3 rounded-lg border border-line bg-raised p-2.5">
      <RemoteImage
        src={str(block.thumbnail_url)}
        alt={str(block.alt_text)}
        className="h-18 w-32 shrink-0 rounded-md bg-inset object-cover"
        fallback={
          <span className="flex h-18 w-32 shrink-0 items-center justify-center rounded-md bg-inset text-ink-faint">
            <FilmIcon size={22} />
          </span>
        }
      />
      <div className="min-w-0 flex-1">
        {title && (
          <p className="text-sm font-semibold">
            {href ? (
              <a
                href={href}
                title={linkTitle(title.text, href)}
                target="_blank"
                rel="noopener noreferrer"
                className="md-link"
              >
                {title.text}
              </a>
            ) : (
              <span className="text-ink">{title.text}</span>
            )}
          </p>
        )}
        {provider && <p className="text-xs text-ink-faint">{provider}</p>}
        <TextObjectView value={block.description} className="mt-1 line-clamp-3 text-[13px] text-ink-muted" />
      </div>
    </div>
  );
}

function FileBlock({ block }: { block: Loose }) {
  const file = isObj(block.file) ? block.file : {};
  const name = str(file.title) || str(file.name) || 'A file shared from another app';
  return (
    <div className="flex max-w-[480px] items-center gap-3 rounded-lg border border-line bg-raised px-3 py-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-inset text-ink-faint">
        <FileIcon size={18} />
      </span>
      <p className="min-w-0 truncate text-sm font-medium text-ink">{name}</p>
    </div>
  );
}

/** Blocks this app doesn't know: their text, when they carry any (e.g. Slack's `markdown`). */
function FallbackBlock({ block }: { block: Loose }) {
  if (typeof block.text === 'string' && block.text.trim()) {
    return <MrkdwnNodes nodes={plainTextNodes(block.text, false)} />;
  }
  return <TextObjectView value={block.text} />;
}

// ---------------------------------------------------------------------------------------------
// rich_text

function RichTextBlock({ block }: { block: Loose }) {
  const elements = objects(block.elements);
  if (elements.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {elements.map((el, i) => (
        <RichElement key={i} element={el} />
      ))}
    </div>
  );
}

function RichElement({ element }: { element: Loose }) {
  switch (element.type) {
    case 'rich_text_section': {
      const nodes = richBlockNodes(element.elements);
      return nodes.length ? <MrkdwnNodes nodes={nodes} /> : null;
    }
    case 'rich_text_quote':
      return <MrkdwnNodes nodes={[richQuote(element.elements)]} />;
    case 'rich_text_preformatted':
      return <MrkdwnNodes nodes={[richPreformatted(element.elements)]} />;
    case 'rich_text_list':
      return <RichListView element={element} />;
    default:
      return null;
  }
}

function RichListView({ element }: { element: Loose }) {
  const list = richList(element);
  if (list.items.length === 0) return null;
  const Tag = list.ordered ? 'ol' : 'ul';
  return (
    <Tag
      start={list.ordered && list.start > 1 ? list.start : undefined}
      className="flex flex-col gap-0.5 pl-6"
      style={{ listStyleType: listMarker(list), marginLeft: `${list.indent * 1.5}em` }}
    >
      {list.items.map((nodes, i) => (
        <li key={i} className="pl-0.5">
          <MrkdwnNodes nodes={nodes} />
        </li>
      ))}
    </Tag>
  );
}

// ---------------------------------------------------------------------------------------------

/** Remote images come through Slack's hosts or proxy only, and vanish when they fail to load. */
function RemoteImage({
  src,
  alt,
  className,
  fallback = null,
}: {
  src: string;
  alt: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const safe = remoteImageSrc(src);
  if (!safe || failed) return <>{fallback}</>;
  return (
    <img
      src={safe}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
