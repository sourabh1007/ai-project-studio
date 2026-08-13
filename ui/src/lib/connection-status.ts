/**
 * Pure logic for deriving the app's connection banner state from two signals:
 * the browser's `navigator.onLine` flag and the outcome of polling the backend
 * `/health` probe. Kept dependency-free so it is fully unit-testable; the React
 * hook/component layer supplies the live inputs.
 */

/** Distinguishable connectivity states, ordered from healthy to worst. */
export type ConnectionState = 'online' | 'backend-down' | 'offline';

/** Result of a single `/health` poll attempt. */
export type ProbeOutcome = 'ok' | 'error' | 'unknown';

export interface ConnectionInputs {
  /** The browser's `navigator.onLine` reading. */
  browserOnline: boolean;
  /** Outcome of the most recent backend health probe. */
  lastProbe: ProbeOutcome;
}

export interface ConnectionStatus {
  state: ConnectionState;
  /** True only when everything is healthy; the banner hides in this case. */
  healthy: boolean;
  title: string;
  detail: string;
}

const COPY: Record<ConnectionState, { title: string; detail: string }> = {
  online: {
    title: 'Connected',
    detail: 'All services are reachable.',
  },
  offline: {
    title: 'You are offline',
    detail:
      'Network is unavailable. Local views keep working; cloud actions are paused until you reconnect.',
  },
  'backend-down': {
    title: 'Studio service unavailable',
    detail:
      'The local Studio service is not responding. Recent data stays visible; actions are paused while it recovers.',
  },
};

/**
 * Combine the browser-online flag with the latest probe outcome into a single
 * connection status. Precedence: a hard browser-offline signal wins (no point
 * blaming the backend when the machine has no network); otherwise a failed
 * probe means the local service is down. An `unknown` probe (not yet run) is
 * treated as healthy so the banner never flashes on first paint.
 */
export function deriveConnectionStatus(
  inputs: ConnectionInputs,
): ConnectionStatus {
  const state = resolveState(inputs);
  const copy = COPY[state];
  return {
    state,
    healthy: state === 'online',
    title: copy.title,
    detail: copy.detail,
  };
}

function resolveState(inputs: ConnectionInputs): ConnectionState {
  if (!inputs.browserOnline) {
    return 'offline';
  }
  if (inputs.lastProbe === 'error') {
    return 'backend-down';
  }
  return 'online';
}

/**
 * Whether a state change is worth announcing to assistive tech / logging.
 * Transitions into or out of a degraded state matter; steady-state repeats do
 * not.
 */
export function connectionChanged(
  previous: ConnectionState,
  next: ConnectionState,
): boolean {
  return previous !== next;
}
