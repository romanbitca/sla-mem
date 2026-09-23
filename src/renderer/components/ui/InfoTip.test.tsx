// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InfoTip } from './InfoTip';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderTip() {
  render(
    <div>
      <InfoTip label="How this is worked out">
        <p>Only working hours count.</p>
      </InfoTip>
      <button type="button">Elsewhere</button>
    </div>,
  );
  return screen.getByRole('button', { name: 'How this is worked out' });
}

const shown = () => screen.queryByText('Only working hours count.');

describe('InfoTip', () => {
  it('shows the explanation while the pointer is on it, and a moment after it leaves', () => {
    vi.useFakeTimers();
    const button = renderTip();
    expect(shown()).toBeNull();
    fireEvent.mouseEnter(button);
    expect(shown()).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(shown()!.parentElement!.id);
    fireEvent.mouseLeave(button);
    // Time to move onto the explanation: coming back keeps it.
    act(() => vi.advanceTimersByTime(100));
    fireEvent.mouseEnter(shown()!.parentElement!);
    act(() => vi.advanceTimersByTime(300));
    expect(shown()).toBeTruthy();
    fireEvent.mouseLeave(shown()!.parentElement!);
    act(() => vi.advanceTimersByTime(300));
    expect(shown()).toBeNull();
  });

  it('stays open after a click until a second click, Escape or a click elsewhere', () => {
    vi.useFakeTimers();
    const button = renderTip();
    fireEvent.click(button);
    fireEvent.mouseLeave(button);
    act(() => vi.advanceTimersByTime(300));
    expect(shown()).toBeTruthy();
    fireEvent.click(button);
    expect(shown()).toBeNull();

    fireEvent.click(button);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(shown()).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(shown()).toBeNull();
  });

  it('doesn’t reopen under the pointer right after being closed there', () => {
    const button = renderTip();
    fireEvent.mouseEnter(button);
    fireEvent.click(button); // pinned
    fireEvent.click(button); // closed, pointer still on it
    fireEvent.mouseEnter(button);
    expect(shown()).toBeNull();
    fireEvent.mouseLeave(button);
    fireEvent.mouseEnter(button);
    expect(shown()).toBeTruthy();
  });
});
