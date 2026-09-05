/** Mirrors the backend `HealPhase`. */
export type SelfHealPhase =
  | 'idle'
  | 'checking'
  | 'healing'
  | 'done'
  | 'error';

/** Mirrors the backend `HealEvent` streamed over SSE. */
export type SelfHealEvent =
  | { kind: 'phase'; phase: SelfHealPhase }
  | { kind: 'log'; line: string }
  | { kind: 'done'; healed: boolean; message: string }
  | { kind: 'error'; message: string };

/** Accumulated UI state for a self-heal run. */
export interface SelfHealState {
  phase: SelfHealPhase;
  healed: boolean;
  message: string;
  logs: string[];
}

export const INITIAL_SELF_HEAL_STATE: SelfHealState = {
  phase: 'idle',
  healed: false,
  message: '',
  logs: [],
};

/** Fold a streamed event into the running state. Pure. */
export function reduceSelfHeal(
  state: SelfHealState,
  event: SelfHealEvent,
): SelfHealState {
  switch (event.kind) {
    case 'phase':
      return { ...state, phase: event.phase };
    case 'log':
      return { ...state, logs: [...state.logs, event.line] };
    case 'done':
      return {
        ...state,
        phase: 'done',
        healed: event.healed,
        message: event.message,
      };
    case 'error':
      return {
        ...state,
        phase: 'error',
        healed: false,
        message: event.message,
      };
    default:
      return state;
  }
}

/** Presentation derived from the state: a status for the badge + a headline. */
export interface SelfHealUi {
  /** Status token understood by {@link classifyStatus}/StatusBadge. */
  status: string;
  /** Short human headline for the current phase. */
  headline: string;
  /** Whether a run is in progress (drives disabled/spinner UI). */
  busy: boolean;
}

export function deriveSelfHealUi(state: SelfHealState): SelfHealUi {
  switch (state.phase) {
    case 'checking':
      return { status: 'running', headline: 'Checking…', busy: true };
    case 'healing':
      return { status: 'running', headline: 'Fixing…', busy: true };
    case 'done':
      return state.healed
        ? {
            status: 'success',
            headline: state.message || 'Fixed',
            busy: false,
          }
        : {
            status: 'failed',
            headline: state.message || 'Could not fix automatically',
            busy: false,
          };
    case 'error':
      return {
        status: 'failed',
        headline: state.message || 'Something went wrong',
        busy: false,
      };
    case 'idle':
    default:
      return { status: 'pending', headline: 'Ready to fix', busy: false };
  }
}

/**
 * Heuristic: does an error message describe the GitHub CLI being missing (a
 * self-healable problem) rather than an actual IDE bug?
 */
export function isGhMissingError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    (text.includes('gh') || text.includes('github cli')) &&
    (text.includes('not found') || text.includes('path'))
  );
}
