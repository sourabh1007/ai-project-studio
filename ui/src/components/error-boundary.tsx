import { Component, type ErrorInfo, type ReactNode } from 'react';
import { classifyError } from '../lib/error-model.js';
import { recordFailure } from '../lib/failure-log.js';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback; receives the caught error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Human label used in the default fallback (e.g. "PR Review"). */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in its subtree and shows a fallback instead of
 * letting the error unmount the whole React tree (which would blank the app).
 * A single misbehaving panel can fail in isolation while the rest of the IDE —
 * including the explorer/tree in the left panel — keeps working.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the error for debugging; it is otherwise swallowed by the boundary.
    console.error('[ErrorBoundary] caught render error', error, info);
    // Remember it locally so it appears in the Diagnostics & recovery surface.
    recordFailure(this.props.label ? `Render: ${this.props.label}` : 'Render', error);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(error, this.reset);
      }
      const model = classifyError(error);
      return (
        <div className="error-boundary" role="alert">
          <h3>
            {model.title}
            {this.props.label ? ` in ${this.props.label}` : ''}
          </h3>
          <p className="error-boundary-message">{error.message}</p>
          <button type="button" className="error-boundary-retry" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
