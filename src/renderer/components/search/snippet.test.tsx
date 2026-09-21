// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MATCH_END as E, MATCH_START as S, parseSnippet, Snippet, snippetText } from './snippet';

afterEach(cleanup);

describe('parseSnippet', () => {
  it('splits highlight markers into matched parts', () => {
    expect(parseSnippet(`…the ${S}deploy${E} went ${S}fine${E}.`)).toEqual([
      { text: '…the ', match: false },
      { text: 'deploy', match: true },
      { text: ' went ', match: false },
      { text: 'fine', match: true },
      { text: '.', match: false },
    ]);
  });

  it('handles snippets without markers, including filter-only listings', () => {
    expect(parseSnippet('just some text')).toEqual([{ text: 'just some text', match: false }]);
    expect(parseSnippet('')).toEqual([]);
  });

  it('degrades gracefully on unbalanced or doubled markers', () => {
    expect(parseSnippet(`a ${S}open to the end`)).toEqual([
      { text: 'a ', match: false },
      { text: 'open to the end', match: true },
    ]);
    expect(parseSnippet(`stray${E} end ${S}${S}x${E}${E}`)).toEqual([
      { text: 'stray end ', match: false },
      { text: 'x', match: true },
    ]);
    expect(parseSnippet(`${S}${E}`)).toEqual([]);
  });

  it('collapses whitespace and drops other control characters', () => {
    expect(parseSnippet(`  line one\n\n  line\u0000 two\t `)).toEqual([{ text: 'line one line two', match: false }]);
    expect(snippetText(`${S}a${E}\u0007b`)).toBe('ab');
  });
});

describe('<Snippet>', () => {
  it('renders matches as <mark> elements and markup as literal text', () => {
    const { container } = render(<Snippet text={`<b>bold</b> and ${S}<img src=x onerror=alert(1)>${E}`} />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('<b>bold</b> and <img src=x onerror=alert(1)>');
  });
});
