import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ResultLink } from '../search/SearchResults';
import { parseAnswer, type Block, type Inline, type ListItem } from './parseAnswer';

/** Where a citation goes, and what its tooltip says ("Ana in #eng, 14 Mar"). */
export interface CitationTarget {
  link: ResultLink;
  title: string;
}

export type CitationResolver = (ref: number) => CitationTarget | null;

/**
 * An answer as the reader sees it: the little Markdown Claude writes, with each citation a small
 * numbered link to the message it rests on. Text that is still arriving renders as it stands.
 */
export const AnswerText = memo(function AnswerText({ text, citation }: { text: string; citation: CitationResolver }) {
  const blocks = useMemo(() => parseAnswer(text), [text]);
  return (
    <div className="flex flex-col gap-2.5 text-[14.5px] leading-relaxed text-ink [overflow-wrap:anywhere]">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} citation={citation} />
      ))}
    </div>
  );
});

function BlockView({ block, citation }: { block: Block; citation: CitationResolver }) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p>
          {block.lines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && <br />}
              <InlineView nodes={line} citation={citation} />
            </Fragment>
          ))}
        </p>
      );
    case 'heading':
      return (
        <p className="font-semibold">
          <InlineView nodes={block.content} citation={citation} />
        </p>
      );
    case 'list':
      return <ListView ordered={block.ordered} start={block.start} items={block.items} citation={citation} />;
    case 'code':
      return <pre className="md-pre">{block.text}</pre>;
  }
}

function ListView({
  ordered,
  start,
  items,
  citation,
}: {
  ordered: boolean;
  start: number;
  items: ListItem[];
  citation: CitationResolver;
}) {
  const children = items.map((item, i) => (
    <li key={i} className="pl-0.5">
      <InlineView nodes={item.content} citation={citation} />
      {item.children.length > 0 && <ListView ordered={false} start={1} items={item.children} citation={citation} />}
    </li>
  ));
  return ordered ? (
    <ol start={start} className="flex list-decimal flex-col gap-1 pl-5 marker:text-ink-faint">
      {children}
    </ol>
  ) : (
    <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-ink-faint">{children}</ul>
  );
}

function InlineView({ nodes, citation }: { nodes: Inline[]; citation: CitationResolver }): ReactNode {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return <Fragment key={i}>{node.text}</Fragment>;
      case 'bold':
        return (
          <strong key={i} className="font-semibold">
            <InlineView nodes={node.children} citation={citation} />
          </strong>
        );
      case 'italic':
        return (
          <em key={i}>
            <InlineView nodes={node.children} citation={citation} />
          </em>
        );
      case 'code':
        return (
          <code key={i} className="md-code">
            {node.text}
          </code>
        );
      case 'cite':
        return (
          <span key={i} className="ml-0.5 inline-flex gap-0.5 align-baseline">
            {node.refs.map((ref) => (
              <Citation key={ref} ref_={ref} target={citation(ref)} />
            ))}
          </span>
        );
    }
  });
}

function Citation({ ref_, target }: { ref_: number; target: CitationTarget | null }) {
  if (!target) return <span className="text-ink-faint tabular-nums">[{ref_}]</span>;
  return (
    <Link
      to={target.link.to}
      state={target.link.state}
      replace={target.link.replace}
      title={target.title}
      aria-label={`Source ${ref_}: ${target.title}`}
      data-citation={ref_}
      className="focus-ring inline-flex h-[17px] min-w-[17px] -translate-y-px items-center justify-center rounded-[5px] bg-accent-soft px-1 text-[10.5px] leading-none font-semibold text-accent-text tabular-nums transition-colors duration-150 hover:bg-accent hover:text-accent-ink"
    >
      {ref_}
    </Link>
  );
}
