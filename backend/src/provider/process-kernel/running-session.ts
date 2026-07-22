import type { ProcessHandle } from './process-spawner.js';
import type { RunningSession } from '../provider-contract.js';

/**
 * Adapts a low-level ProcessHandle into a provider-agnostic RunningSession,
 * translating stdout/stderr/exit into unified SessionEvents. Shared by all
 * CLI-based adapters.
 */
export function toRunningSession(
  sessionId: string,
  handle: ProcessHandle,
): RunningSession {
  return {
    sessionId,
    onEvent(handler) {
      handle.onStdoutLine((line) => handler({ type: 'stdout', line }));
      handle.onStderrLine((line) => handler({ type: 'stderr', line }));
      handle.onExit((code) => handler({ type: 'exit', code }));
    },
    kill: () => handle.kill(),
    done: handle.done,
  };
}
