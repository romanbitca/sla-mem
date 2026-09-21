// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { api } from '../../lib/api';
import { ErrorBoundary } from './ErrorBoundary';

let broken = true;
function Fragile({ label = 'All good' }: { label?: string }) {
  if (broken) throw new Error('TypeError: cannot read properties of undefined (reading "xoxc")');
  return <p>{label}</p>;
}

beforeEach(() => {
  broken = true;
  // React reports caught errors to the console; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows a plain recovery card instead of a blank screen, without the error details', () => {
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).toContain('Nothing was lost');
    expect(alert.textContent).not.toMatch(/TypeError|undefined|xoxc/);
  });

  it('Try again draws the children again', () => {
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    );
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('All good')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Show logs opens the log folder', () => {
    const showLogs = vi.spyOn(api, 'showLogs').mockResolvedValue({ ok: true });
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show logs' }));
    expect(showLogs).toHaveBeenCalledTimes(1);
  });

  it('starts afresh when the reset key changes (e.g. going to another page)', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/c/C1">
        <Fragile />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    broken = false;
    rerender(
      <ErrorBoundary resetKey="/c/C1">
        <Fragile label="Same page" />
      </ErrorBoundary>,
    );
    // Same key: still showing the card until the reader asks to try again.
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(
      <ErrorBoundary resetKey="/search">
        <Fragile label="Another page" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Another page')).toBeTruthy();
  });
});
