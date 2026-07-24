import type { Session } from './types.js';

export type SessionDotClass =
  | 'dot-running'
  | 'dot-failed'
  | 'dot-completed'
  | 'dot-idle';

/** Maps a session status to its status-dot CSS modifier class (pure). */
export function sessionDotClass(status: Session['status']): SessionDotClass {
  switch (status) {
    case 'running':
      return 'dot-running';
    case 'failed':
      return 'dot-failed';
    case 'completed':
      return 'dot-completed';
    default:
      return 'dot-idle';
  }
}
