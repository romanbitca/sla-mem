// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { InfoButton } from './InfoButton';

afterEach(cleanup);

function renderButton() {
  render(
    <InfoButton title="How this is worked out">
      <p>Only working hours count.</p>
    </InfoButton>,
  );
  return screen.getByRole('button', { name: 'How this is worked out' });
}

describe('InfoButton', () => {
  it('opens the explanation in a dialog over a greyed page, and the × closes it', () => {
    const button = renderButton();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'How this is worked out' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(within(dialog).getByText('Only working hours count.')).toBeTruthy();
    // The backdrop behind it.
    expect(dialog.parentElement?.className).toContain('bg-scrim');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('closes on Escape and on a click outside it', () => {
    const button = renderButton();
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);
    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByRole('dialog')).toBeNull();

    // A click inside keeps it open.
    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByText('Only working hours count.'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
