// @vitest-environment jsdom
// Separate file so the emoji map starts out unloaded (module state is per test file).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Mrkdwn, isEmojiMapLoaded, mrkdwnToPlainText } from './index';

afterEach(cleanup);

describe('lazy emoji map', () => {
  it('renders shortcodes as text first, then swaps in glyphs once the map arrives', async () => {
    const wasLoaded = isEmojiMapLoaded();
    const { container } = render(<Mrkdwn text="ship it :rocket:" />);
    if (!wasLoaded) expect(container.textContent).toBe('ship it :rocket:');
    expect(await screen.findByText('🚀')).toBeTruthy();
    expect(container.querySelector('span.md-emoji')?.getAttribute('title')).toBe(':rocket:');
    expect(mrkdwnToPlainText(':rocket:')).toBe('🚀');
  });
});
