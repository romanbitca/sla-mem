import { Component, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { AlertIcon } from '../icons';
import { Button } from './Button';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Changing this clears a caught error (e.g. the route: going elsewhere is a fresh start). */
  resetKey?: unknown;
  className?: string;
}

interface ErrorBoundaryState {
  crashed: boolean;
  resetKey: unknown;
}

/**
 * Catches a crash while drawing part of the window, so the rest keeps working and the reader
 * sees what PLAN §8.5 promises instead of a blank window: "Something went wrong. Nothing was
 * lost." with Try again and Show logs. React reports the error itself to the console; the
 * details never reach the screen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { crashed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { crashed: true };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { crashed: false, resetKey: props.resetKey };
  }

  private readonly retry = () => this.setState({ crashed: false });

  override render() {
    if (!this.state.crashed) return this.props.children;
    return (
      <div
        role="alert"
        className={
          this.props.className ?? 'flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center'
        }
      >
        <span className="flex size-10 items-center justify-center rounded-xl bg-inset text-danger">
          <AlertIcon size={20} />
        </span>
        <h2 className="text-[15px] font-semibold text-ink">Something went wrong</h2>
        <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
          Nothing was lost. Try again, and if it keeps happening, the logs help find out why.
        </p>
        <div className="mt-1 flex gap-2">
          <Button variant="primary" onClick={this.retry}>
            Try again
          </Button>
          <Button onClick={() => void api.showLogs().catch(() => undefined)}>Show logs</Button>
        </div>
      </div>
    );
  }
}
