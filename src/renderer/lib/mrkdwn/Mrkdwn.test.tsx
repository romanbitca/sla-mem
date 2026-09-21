// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEmojiMap } from '../emoji';
import { Emoji, Mrkdwn, MrkdwnProvider, type MrkdwnContext } from './index';

const baseCtx: MrkdwnContext = {
  userLabel: (id) => ({ U1: 'Roman', U2: 'Ana' })[id],
  channelLabel: (id) => ({ C1: 'general' })[id],
  customEmojiUrl: (name) =>
    ({ partyparrot: 'https://emoji.slack-edge.com/T1/partyparrot/abc.gif', yes: 'alias:+1', evil: 'javascript:alert(1)' })[name],
  channelHref: (id) => `/c/${id}`,
};

function renderMd(text: string, ctx: Partial<MrkdwnContext> = {}, props: { inline?: boolean; className?: string } = {}) {
  return render(
    <MrkdwnProvider value={{ ...baseCtx, ...ctx }}>
      <Mrkdwn text={text} {...props} />
    </MrkdwnProvider>,
  );
}

beforeAll(() => loadEmojiMap());
afterEach(cleanup);

describe('<Mrkdwn>', () => {
  it('renders formatting as semantic elements with stable classes', () => {
    const { container } = renderMd('*b* _i_ ~s~ `c`');
    expect(container.querySelector('strong.md-bold')?.textContent).toBe('b');
    expect(container.querySelector('em.md-italic')?.textContent).toBe('i');
    expect(container.querySelector('s.md-strike')?.textContent).toBe('s');
    expect(container.querySelector('code.md-code')?.textContent).toBe('c');
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('DIV');
    expect(root.className).toContain('md-root');
  });

  it('renders pre blocks and quotes as blocks, and line breaks as <br>', () => {
    const { container } = renderMd('a\nb\n```x\n  y```\n&gt; quoted *q*');
    // a<br>b<br><pre>…</pre><blockquote>…: no <br> after a block, which would add a blank line.
    expect(container.querySelectorAll('br')).toHaveLength(2);
    expect(container.querySelector('pre + br')).toBeNull();
    expect(container.querySelector('pre.md-pre')?.textContent).toBe('x\n  y');
    const quote = container.querySelector('blockquote.md-quote');
    expect(quote?.textContent).toBe('quoted q');
    expect(quote?.querySelector('strong')).not.toBeNull();
  });

  it('renders safe external links in a new tab', () => {
    renderMd('<https://example.com/a?x=1&amp;y=2|Example> and https://bare.dev/path.');
    const labelled = screen.getByRole('link', { name: 'Example' });
    expect(labelled.getAttribute('href')).toBe('https://example.com/a?x=1&y=2');
    expect(labelled.getAttribute('target')).toBe('_blank');
    expect(labelled.getAttribute('rel')).toBe('noopener noreferrer');
    expect(labelled.className).toContain('md-link');
    const bare = screen.getByRole('link', { name: 'https://bare.dev/path' });
    expect(bare.getAttribute('href')).toBe('https://bare.dev/path');
  });

  it('never links javascript: or other unsafe URLs', () => {
    const { container } = renderMd('<javascript:alert(1)|click> <data:text/html;base64,xx|data> javascript:void(0)');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toBe('click data javascript:void(0)');
  });

  it('renders markup-looking text as text', () => {
    const { container } = renderMd('&lt;script&gt;alert(1)&lt;/script&gt; <img src=x onerror=alert(1)>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  });

  it('renders user mentions as titled chips', () => {
    const { container } = renderMd('<@U1> <@U9|ghost> <@U8>');
    const chips = container.querySelectorAll('.md-mention-user');
    expect([...chips].map((c) => c.textContent)).toEqual(['@Roman', '@ghost', '@U8']);
    expect(chips[0].getAttribute('title')).toBe('@Roman');
    expect(chips[0].getAttribute('data-user-id')).toBe('U1');
    expect(chips[1].getAttribute('title')).toBe('@ghost (U9)');
    expect(chips[0].classList.contains('md-mention')).toBe(true);
  });

  it('links archived channels via channelHref and navigates client-side when possible', () => {
    const navigate = vi.fn();
    const { container } = renderMd('<#C1> <#C9|elsewhere>', { navigate });
    const link = screen.getByRole('link', { name: '#general' });
    expect(link.getAttribute('href')).toBe('/c/C1');
    expect(link.getAttribute('target')).toBeNull();
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('/c/C1');
    // jsdom can't follow real navigations; stop it after React has seen the event.
    const stopNavigation = (e: Event) => e.preventDefault();
    window.addEventListener('click', stopNavigation);
    fireEvent.click(link, { metaKey: true });
    window.removeEventListener('click', stopNavigation);
    expect(navigate).toHaveBeenCalledTimes(1);
    const unknown = container.querySelector('span.md-mention-channel');
    expect(unknown?.textContent).toBe('#elsewhere');
  });

  it('renders broadcasts, user groups and dates', () => {
    const { container } = renderMd(
      '<!here> <!subteam^S1|@design> <!date^1392734382^{date_num}^https://cal.example|Feb 18th>',
    );
    expect(container.querySelector('.md-mention-broadcast')?.textContent).toBe('@here');
    expect(container.querySelector('.md-mention-usergroup')?.textContent).toBe('@design');
    const time = container.querySelector('time.md-date');
    expect(time?.textContent).toBe('Feb 18th');
    expect(time?.getAttribute('title')).toMatch(/^2014-02-1[89]$/);
    expect(time?.getAttribute('datetime')).toBe('2014-02-18T14:39:42.000Z');
    expect(time?.closest('a')?.getAttribute('href')).toBe('https://cal.example/');
  });

  it('renders Unicode, skin-toned, custom and aliased emoji', () => {
    const { container } = renderMd('hi :smile: :+1::skin-tone-4: :partyparrot: :yes:');
    const glyphs = container.querySelectorAll('span.md-emoji');
    expect([...glyphs].map((g) => g.textContent)).toEqual(['😄', '👍🏽', '👍']);
    expect(glyphs[0].getAttribute('title')).toBe(':smile:');
    expect(glyphs[1].getAttribute('title')).toBe(':+1::skin-tone-4:');
    const img = container.querySelector('img.md-emoji-custom');
    expect(img?.getAttribute('src')).toBe('https://emoji.slack-edge.com/T1/partyparrot/abc.gif');
    expect(img?.getAttribute('alt')).toBe(':partyparrot:');
    expect(container.querySelector('.md-jumbo')).toBeNull();
  });

  it('keeps unknown shortcodes and unsafe custom emoji as plain text', () => {
    const { container } = renderMd('at 10:30:45 :nope: :evil:');
    expect(container.textContent).toBe('at 10:30:45 :nope: :evil:');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.md-emoji')).toBeNull();
  });

  it('renders emoji-only messages jumbo', () => {
    const { container } = renderMd(':tada: :partyparrot:');
    const root = container.firstElementChild as HTMLElement;
    expect(root.classList.contains('md-jumbo')).toBe(true);
    expect((root.querySelector('span.md-emoji') as HTMLElement).style.fontSize).toBe('32px');
    expect((root.querySelector('img.md-emoji') as HTMLElement).style.width).toBe('32px');
  });

  it('does not render jumbo when there is other text or too many emoji', () => {
    expect(renderMd(':tada: yay').container.querySelector('.md-jumbo')).toBeNull();
    cleanup();
    expect(renderMd(':tada: '.repeat(24)).container.querySelector('.md-jumbo')).toBeNull();
  });

  it('highlights search terms case-insensitively in text, links and code', () => {
    const { container } = renderMd('Deploy the API: `api deploy` <https://x.com|deploy docs>', {
      highlight: ['deploy', 'API'],
    });
    const marks = [...container.querySelectorAll('mark.md-highlight')].map((m) => m.textContent);
    expect(marks).toEqual(['Deploy', 'API', 'api', 'deploy', 'deploy']);
  });

  it('supports inline mode for single-line contexts', () => {
    const { container } = renderMd('line one\nline two ```code``` &gt; not a block', {}, { inline: true, className: 'truncate' });
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('SPAN');
    expect(root.className).toContain('truncate');
    expect(container.querySelector('br, pre, blockquote, div')).toBeNull();
    expect(root.textContent).toBe('line one line two code > not a block');
  });

  it('works without a provider', () => {
    const { container } = render(<Mrkdwn text="*hi* <@U1> <#C1|general>" />);
    expect(container.textContent).toBe('hi @U1 #general');
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('<Emoji>', () => {
  it('renders Unicode with a :name: title and optional size', () => {
    const { container } = render(<Emoji name="+1::skin-tone-2" size={20} />);
    const span = container.querySelector('span.md-emoji') as HTMLElement;
    expect(span.textContent).toBe('👍🏻');
    expect(span.getAttribute('title')).toBe(':+1::skin-tone-2:');
    expect(span.style.fontSize).toBe('20px');
  });

  it('renders custom emoji from context', () => {
    const { container } = render(
      <MrkdwnProvider value={baseCtx}>
        <Emoji name=":partyparrot:" />
      </MrkdwnProvider>,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://emoji.slack-edge.com/T1/partyparrot/abc.gif');
  });

  it('falls back to the literal :name:', () => {
    const { container } = render(<Emoji name="nope" />);
    expect(container.querySelector('.md-emoji-missing')?.textContent).toBe(':nope:');
  });
});
