import { describe, expect, it } from 'vitest';
import { citedRefs, parseAnswer, parseInline } from './parseAnswer';

describe('parsing answers', () => {
  it('reads citations, grouping neighbours', () => {
    expect(parseInline('Ana asked [3], then Bob [4][7] and [5, 6].')).toEqual([
      { kind: 'text', text: 'Ana asked ' },
      { kind: 'cite', refs: [3] },
      { kind: 'text', text: ', then Bob ' },
      { kind: 'cite', refs: [4, 7] },
      { kind: 'text', text: ' and ' },
      { kind: 'cite', refs: [5, 6] },
      { kind: 'text', text: '.' },
    ]);
    expect(parseInline('see [2], [9]')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'cite', refs: [2, 9] },
    ]);
  });

  it('reads bold, italic and code, and leaves snake_case and lone stars alone', () => {
    expect(parseInline('**Yes**, *really* `npm test` in run_e2e_suite 2 * 3')).toEqual([
      { kind: 'bold', children: [{ kind: 'text', text: 'Yes' }] },
      { kind: 'text', text: ', ' },
      { kind: 'italic', children: [{ kind: 'text', text: 'really' }] },
      { kind: 'text', text: ' ' },
      { kind: 'code', text: 'npm test' },
      { kind: 'text', text: ' in run_e2e_suite 2 * 3' },
    ]);
    // Nothing inside code is markup, and a link shows as its text only.
    expect(parseInline('`[1] **x**` [Slack](https://x.slack.com)')).toEqual([
      { kind: 'code', text: '[1] **x**' },
      { kind: 'text', text: ' Slack' },
    ]);
  });

  it('reads paragraphs, lists (nested too), headings and code blocks', () => {
    const blocks = parseAnswer(
      [
        '## Summary',
        'First line',
        'second line',
        '',
        '- one [1]',
        '  - nested',
        '- two',
        '',
        '3. third',
        '4. fourth',
        '```',
        'npm run e2e',
        '```',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'code']);
    expect(blocks[1]).toMatchObject({ lines: [[{ text: 'First line' }], [{ text: 'second line' }]] });
    expect(blocks[2]).toMatchObject({
      ordered: false,
      items: [{ content: [{ text: 'one ' }, { refs: [1] }], children: [{ content: [{ text: 'nested' }] }] }, {}],
    });
    expect(blocks[3]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[4]).toEqual({ kind: 'code', text: 'npm run e2e' });
  });

  it('shows half-written markup as plain text while an answer streams in', () => {
    expect(parseInline('It was **Ana')).toEqual([{ kind: 'text', text: 'It was **Ana' }]);
    expect(parseInline('see [1')).toEqual([{ kind: 'text', text: 'see [1' }]);
  });

  it('lists the numbers an answer cites, once each, in order', () => {
    expect(citedRefs('A [3] and [1].\n\n- **B [3][2]**\n  - c [4]')).toEqual([3, 1, 2, 4]);
    expect(citedRefs('Nothing found.')).toEqual([]);
  });
});
