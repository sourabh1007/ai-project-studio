import type { SessionSummarizer } from '../session-summary/session-summary-contract.js';
import type { Route } from './http-contract.js';

export interface SessionSummaryControllerDeps {
  sessionSummaries: SessionSummarizer;
}

/** Routes for generating and reading a single session's AI summary. */
export function createSessionSummaryRoutes(
  deps: SessionSummaryControllerDeps,
): Route[] {
  return [
    {
      method: 'post',
      path: '/features/:featureId/sessions/:sessionId/summary',
      handler: async (req) => ({
        status: 200,
        body: await deps.sessionSummaries.summarize({
          sessionId: req.params.sessionId,
        }),
      }),
    },
    {
      method: 'get',
      path: '/features/:featureId/sessions/:sessionId/summary',
      handler: (req) => {
        const summary = deps.sessionSummaries.get(req.params.sessionId);
        if (!summary) {
          return {
            status: 404,
            body: { error: { kind: 'not_found', message: 'No summary yet' } },
          };
        }
        return { status: 200, body: summary };
      },
    },
  ];
}
