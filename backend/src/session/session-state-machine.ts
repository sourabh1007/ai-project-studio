import { ValidationError } from '../kernel/error-types.js';
import type { SessionStatus } from './session-contract.js';

/** Allowed status transitions for a session. */
const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  created: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

const TERMINAL: readonly SessionStatus[] = ['completed', 'failed', 'cancelled'];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL.includes(status);
}

export function canTransition(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Asserts a transition is legal, throwing ValidationError otherwise. */
export function assertTransition(
  from: SessionStatus,
  to: SessionStatus,
): void {
  if (!canTransition(from, to)) {
    throw new ValidationError(
      `Illegal session transition: ${from} -> ${to}`,
    );
  }
}
