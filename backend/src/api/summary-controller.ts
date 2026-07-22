import type { FeatureSummarizer } from '../summarizer/summarizer-contract.js';
import type { SummaryStore } from '../summarizer/summary-store-port.js';
import type { Route } from './http-contract.js';

export interface SummaryControllerDeps {
  summarizer: FeatureSummarizer;
  summaries: SummaryStore;
}

/** Routes for generating and reading a feature's AI summary. */
export function createSummaryRoutes(deps: SummaryControllerDeps): Route[] {
  return [
    {
      method: 'post',
      path: '/features/:featureId/summary',
      handler: async (req) => ({
        status: 200,
        body: await deps.summarizer.summarize({
          featureId: req.params.featureId,
        }),
      }),
    },
    {
      method: 'get',
      path: '/features/:featureId/summary',
      handler: (req) => {
        const summary = deps.summaries.load(req.params.featureId);
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
