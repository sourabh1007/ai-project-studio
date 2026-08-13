/**
 * A single, typed error model for the whole UI. Any thrown value (an
 * {@link ApiError}, a network `TypeError`, a plain `Error`, or something exotic)
 * is normalized into an {@link AppError} carrying a stable `category`, a
 * human-readable `title`/`message`, a `severity`, and whether it is
 * `retryable`. Components render errors consistently instead of each inventing
 * its own `err instanceof Error ? err.message : String(err)` handling.
 *
 * This module is pure and dependency-light so it is fully unit-testable; the
 * React layer (ErrorState / ErrorBoundary) consumes the result.
 */

export type AppErrorCategory =
  | 'offline'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'rate-limit'
  | 'server'
  | 'client'
  | 'unknown';

export type AppErrorSeverity = 'warning' | 'error';

export interface AppError {
  category: AppErrorCategory;
  /** Short headline suitable for a banner/inline title. */
  title: string;
  /** Fuller, user-facing explanation. */
  message: string;
  severity: AppErrorSeverity;
  /** Whether retrying the same action might reasonably succeed. */
  retryable: boolean;
  /** HTTP status when the source was an API error; otherwise null. */
  status: number | null;
  /** The original technical message, preserved for logs/tooltips. */
  detail: string;
}

interface CategoryTraits {
  title: string;
  severity: AppErrorSeverity;
  retryable: boolean;
  fallbackMessage: string;
}

const TRAITS: Record<AppErrorCategory, CategoryTraits> = {
  offline: {
    title: 'You are offline',
    severity: 'warning',
    retryable: true,
    fallbackMessage:
      'Your device has no network connection. Reconnect and try again.',
  },
  network: {
    title: 'Network error',
    severity: 'error',
    retryable: true,
    fallbackMessage: 'The request could not reach the service. Try again.',
  },
  timeout: {
    title: 'Request timed out',
    severity: 'error',
    retryable: true,
    fallbackMessage: 'The service took too long to respond. Try again.',
  },
  auth: {
    title: 'Sign-in required',
    severity: 'warning',
    retryable: false,
    fallbackMessage: 'Your session has expired. Sign in again to continue.',
  },
  forbidden: {
    title: 'Access denied',
    severity: 'error',
    retryable: false,
    fallbackMessage: 'You do not have permission to perform this action.',
  },
  'not-found': {
    title: 'Not found',
    severity: 'warning',
    retryable: false,
    fallbackMessage: 'The requested item no longer exists.',
  },
  'rate-limit': {
    title: 'Rate limited',
    severity: 'warning',
    retryable: true,
    fallbackMessage: 'Too many requests. Wait a moment and try again.',
  },
  server: {
    title: 'Service error',
    severity: 'error',
    retryable: true,
    fallbackMessage: 'The service hit an unexpected error. Try again shortly.',
  },
  client: {
    title: 'Request rejected',
    severity: 'error',
    retryable: false,
    fallbackMessage: 'The request was invalid.',
  },
  unknown: {
    title: 'Something went wrong',
    severity: 'error',
    retryable: false,
    fallbackMessage: 'An unexpected error occurred.',
  },
};

interface ErrorShape {
  name?: string;
  message?: string;
  status?: number;
}

function readShape(err: unknown): ErrorShape {
  if (typeof err === 'string') {
    return { message: err };
  }
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    return {
      name: typeof record.name === 'string' ? record.name : undefined,
      message:
        typeof record.message === 'string' ? record.message : undefined,
      status: typeof record.status === 'number' ? record.status : undefined,
    };
  }
  return {};
}

function categoryForStatus(status: number): AppErrorCategory {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'unknown';
}

function categoryForNonHttp(shape: ErrorShape): AppErrorCategory {
  const name = shape.name ?? '';
  const message = (shape.message ?? '').toLowerCase();
  if (name === 'AbortError' || message.includes('timeout')) {
    return 'timeout';
  }
  // A rejected fetch surfaces as a TypeError ("Failed to fetch" / "NetworkError").
  if (
    name === 'TypeError' ||
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network request failed')
  ) {
    return 'network';
  }
  return 'unknown';
}

/**
 * Normalize any thrown value into a typed {@link AppError}. Pass
 * `browserOnline: false` to force the `offline` category, which takes
 * precedence over any HTTP/network classification.
 */
export function classifyError(
  err: unknown,
  options: { browserOnline?: boolean } = {},
): AppError {
  const shape = readShape(err);
  const status = shape.status ?? null;

  let category: AppErrorCategory;
  if (options.browserOnline === false) {
    category = 'offline';
  } else if (status !== null) {
    category = categoryForStatus(status);
  } else {
    category = categoryForNonHttp(shape);
  }

  const traits = TRAITS[category];
  const detail = (shape.message ?? '').trim();
  // Prefer a specific server-provided message for HTTP errors; otherwise use the
  // friendly per-category fallback so users never see empty or cryptic text.
  const message =
    status !== null && detail.length > 0 ? detail : traits.fallbackMessage;

  return {
    category,
    title: traits.title,
    message,
    severity: traits.severity,
    retryable: traits.retryable,
    status,
    detail: detail.length > 0 ? detail : traits.fallbackMessage,
  };
}

/** Whether an already-classified category is worth offering a retry for. */
export function isRetryable(category: AppErrorCategory): boolean {
  return TRAITS[category].retryable;
}
