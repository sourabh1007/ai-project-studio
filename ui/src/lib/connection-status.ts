/**
 * Pure logic for deriving the app's connection banner state from two signals:
 * the browser's `navigator.onLine` flag and the outcome of polling the backend
 * `/health` probe. Kept dependency-free so it is fully unit-testable; the React
 * hook/component layer supplies the live inputs.
 */

/** Distinguishable connectivity states, ordered from healthy to worst. */
export type ConnectionState = 'online' | 'backend-down' | 'offline' | 'backend-unavailable';

/** Result of a single `/health` poll attempt. */
export type ProbeOutcome = 'ok' | 'error' | 'unknown';

/** Outcome of one raw `/health` fetch, before hysteresis is applied. */
export type ProbeResult = 'ok' | 'error';

/**
 * Debounced view of the probe: the reported {@link ProbeOutcome} plus the run
 * of consecutive raw failures behind it. Kept separate from the reported
 * outcome so a single blip is remembered without yet alarming the user.
 */
export interface ProbeTracker {
  outcome: ProbeOutcome;
  consecutiveFailures: number;
}

/** Starting tracker: nothing probed yet, so healthy-by-assumption. */
export const INITIAL_PROBE: ProbeTracker = {
  outcome: 'unknown',
  consecutiveFailures: 0,
};

/**
 * How many consecutive failed probes it takes to declare the backend down.
 * The local Studio service briefly stops answering cheap GETs whenever the
 * event loop is saturated by heavy work (parallel metasession fan-out, a large
 * repo scan) or its few localhost sockets are all held by long-lived streams.
 * That is not an outage, so a lone failure must not flash "service
 * unavailable"; only a sustained run of failures should.
 */
export const BACKEND_DOWN_AFTER_FAILURES = 2;

/**
 * Fold one raw probe result into the tracker with hysteresis. A success clears
 * the streak and reports `ok` immediately (recovery should never lag). A
 * failure extends the streak but keeps reporting the previous outcome until the
 * streak reaches {@link BACKEND_DOWN_AFTER_FAILURES}, at which point it flips to
 * `error`. Before the first success an early failure stays `unknown`, so the
 * banner still never flashes on first paint.
 */
export function trackProbe(
  previous: ProbeTracker,
  result: ProbeResult,
): ProbeTracker {
  if (result === 'ok') {
    return { outcome: 'ok', consecutiveFailures: 0 };
  }
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const outcome: ProbeOutcome =
    consecutiveFailures >= BACKEND_DOWN_AFTER_FAILURES
      ? 'error'
      : previous.outcome;
  return { outcome, consecutiveFailures };
}

export interface ConnectionInputs {
  /** The browser's `navigator.onLine` reading. */
  browserOnline: boolean;
  /** Outcome of the most recent backend health probe. */
  lastProbe: ProbeOutcome;
  /**
   * The desktop shell reported that the backend stopped and could not be
   * restarted. Unlike a failed probe this is terminal: nothing will recover on
   * its own, so the user has to restart.
   */
  backendUnavailable?: boolean;
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
  'backend-unavailable': {
    title: 'Studio service stopped',
    detail:
      'The local Studio service stopped and could not be restarted, so nothing will load until the app is restarted.',
  },
};

/**
 * Combine the browser-online flag with the latest probe outcome into a single
 * connection status. Precedence: a shell-reported permanent backend loss wins,
 * because it is terminal and no amount of network explains it away. Otherwise a
 * hard browser-offline signal wins (no point blaming the backend when the
 * machine has no network), and then a failed probe means the local service is
 * down. An `unknown` probe (not yet run) is treated as healthy so the banner
 * never flashes on first paint.
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
  if (inputs.backendUnavailable) {
    return 'backend-unavailable';
  }
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
