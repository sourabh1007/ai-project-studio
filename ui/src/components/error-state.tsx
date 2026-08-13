import { classifyError, type AppError } from '../lib/error-model.js';

interface ErrorStateProps {
  /** A raw thrown value or an already-classified AppError. */
  error: unknown;
  /** Optional retry handler; a button is shown only when the error is retryable. */
  onRetry?: () => void;
  /** Override the browser-online signal (defaults to `navigator.onLine`). */
  browserOnline?: boolean;
  /** Extra classes for layout in different contexts. */
  className?: string;
}

function isAppError(value: unknown): value is AppError {
  return (
    !!value &&
    typeof value === 'object' &&
    'category' in value &&
    'title' in value &&
    'severity' in value
  );
}

/**
 * A consistent inline error presentation used across feature panels. It maps any
 * thrown value to the shared {@link classifyError} model so every error reads
 * with a clear title, friendly message, and a retry affordance when the failure
 * is actually transient.
 */
export function ErrorState({
  error,
  onRetry,
  browserOnline,
  className,
}: ErrorStateProps) {
  const online =
    browserOnline ??
    (typeof navigator === 'undefined' ? true : navigator.onLine);
  const model = isAppError(error)
    ? error
    : classifyError(error, { browserOnline: online });

  return (
    <div
      className={`error-state error-state--${model.severity} ${className ?? ''}`.trim()}
      role="alert"
    >
      <div className="error-state-body">
        <span className="error-state-title">{model.title}</span>
        <span className="error-state-message">{model.message}</span>
      </div>
      {model.retryable && onRetry ? (
        <button
          type="button"
          className="error-state-retry"
          onClick={onRetry}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
