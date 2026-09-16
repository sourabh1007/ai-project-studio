import { lazy } from 'react';
import type {
  AgentUiModule,
  AgentUiProps,
} from '../../agent-host/agent-ui-contract.js';

/**
 * The Review Board expressed as the first frontend agent. It reuses the
 * existing `ReviewBoardPage`, which derives everything it renders from the
 * attached feature's PR review, so the migration is behaviour-preserving.
 */
export const reviewBoardModule: AgentUiModule = {
  id: 'review-board',
  title: 'Review Board',
  icon: 'review-board',
  allowMultiplePerFeature: false,
  component: lazy(() =>
    import('../../features/review-board-page/review-board-page.js').then(
      (m) => ({
        default: ({ ctx }: AgentUiProps) => (
          <m.ReviewBoardPage featureId={ctx.feature.id} />
        ),
      }),
    ),
  ),
};
