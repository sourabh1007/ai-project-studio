import type { Session } from '../session/session-contract.js';
import type { ContextConfig } from './config.js';
import type { ContextMerger } from './context-merge-runner.js';

export interface ContextMergeAutoDeps {
  merger: ContextMerger;
  config: Pick<ContextConfig, 'autoMergeEnabled'>;
  logger: { error: (message: string, data?: unknown) => void };
}

export interface ContextMergeAutoTrigger {
  /** Handler for the `session.ended` event. */
  onSessionEnded(session: Session): void;
}

/**
 * Auto-merges a completed *dev* session's learnings into its feature-scope
 * shared context. Standalone and unit-testable so `main.ts` only wires the
 * handler. Guards mirror the summary trigger: never merge `meta` sessions
 * (which would recurse, since merging launches a meta session) nor `internal`
 * sessions, and honour the `autoMergeEnabled` feature flag.
 */
export function createContextMergeAutoTrigger(
  deps: ContextMergeAutoDeps,
): ContextMergeAutoTrigger {
  return {
    onSessionEnded(session) {
      if (!deps.config.autoMergeEnabled) {
        return;
      }
      if (session.kind !== 'dev' || session.scope === 'internal') {
        return;
      }
      void deps.merger.merge({ sessionId: session.id }).catch((error) => {
        deps.logger.error('Auto context merge failed', error);
      });
    },
  };
}
