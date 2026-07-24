import type { Session } from '../session/session-contract.js';
import type { SessionSummarizer } from './session-summary-contract.js';

export interface SessionSummaryAutoDeps {
  summarizer: SessionSummarizer;
  logger: { error: (message: string, data?: unknown) => void };
}

export interface SessionSummaryAutoTrigger {
  /** Handler for the `session.ended` event. */
  onSessionEnded(session: Session): void;
}

/**
 * Auto-generates a concise AI summary when a *dev* session ends. Kept as a
 * standalone, unit-testable unit so `main.ts` only has to wire the handler onto
 * the event bus. Guards ensure we never summarize `meta` sessions (which would
 * recurse, since summarization itself launches a meta session) and never
 * regenerate a summary that already exists.
 */
export function createSessionSummaryAutoTrigger(
  deps: SessionSummaryAutoDeps,
): SessionSummaryAutoTrigger {
  return {
    onSessionEnded(session) {
      if (session.kind !== 'dev') {
        return;
      }
      if (deps.summarizer.get(session.id) !== null) {
        return;
      }
      void deps.summarizer.summarize({ sessionId: session.id }).catch((error) => {
        deps.logger.error('Auto session summary failed', error);
      });
    },
  };
}
