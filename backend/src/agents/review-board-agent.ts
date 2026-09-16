import type { AgentDefinition } from './agent-contract.js';

/** Dependencies for the Review Board agent definition. */
export interface ReviewBoardAgentDeps {
  /**
   * True when the feature has a PR review the board can analyse. Wired in
   * `main.ts` to the non-throwing PR-review lookup, so the prerequisite is a
   * pure predicate here.
   */
  hasReview(featureId: string): boolean;
}

/** Stable id for the built-in Review Board agent. */
export const REVIEW_BOARD_AGENT_ID = 'review-board';

/**
 * The Review Board expressed as the first agent on the platform. Behaviour is
 * unchanged — it still analyses a feature's existing PR review — but it is now
 * an attachable, detachable agent gated on that review existing.
 */
export function createReviewBoardAgent(
  deps: ReviewBoardAgentDeps,
): AgentDefinition {
  return {
    manifest: {
      id: REVIEW_BOARD_AGENT_ID,
      title: 'Review Board',
      description:
        'Reviews a change from multiple engineering perspectives, deriving ' +
        'everything from the pull request’s diff and change graph.',
      icon: 'review-board',
      allowMultiplePerFeature: false,
      prerequisiteLabel: 'a pull-request review',
      usageLabel: 'Review board',
      promptFields: [
        {
          namespace: 'reviewBoard',
          key: 'perspectivePromptTemplate',
          label: 'Perspective lens review',
          description:
            'Runs a pull request through one generic lens (Architecture, Code ' +
            'Quality, Performance, Security, …) and returns evidence-backed ' +
            'findings.',
          placeholders: [
            'lensName',
            'lensPurpose',
            'prNumber',
            'prTitle',
            'baseBranch',
            'filesChanged',
            'description',
            'modelDigest',
            'changedFiles',
          ],
        },
        {
          namespace: 'reviewBoard',
          key: 'problemSolutionPromptTemplate',
          label: 'Problem ↔ Solution verdict',
          description:
            'The dedicated Problem ↔ Solution lens — a general, plain-English ' +
            'judgement of whether the change actually solves its stated problem.',
          placeholders: [
            'prNumber',
            'prTitle',
            'filesChanged',
            'description',
            'distilledProblem',
            'solutionDigest',
          ],
        },
        {
          namespace: 'prReview',
          key: 'problemStatementPromptTemplate',
          label: 'Problem statement extraction',
          description:
            'Distils a self-contained problem statement strictly from the PR ' +
            'description.',
          placeholders: [
            'untrusted',
            'pullHeader',
            'description',
            'problemHeading',
            'insufficientMarker',
          ],
        },
        {
          namespace: 'prReview',
          key: 'fileExplanationPromptTemplate',
          label: 'Per-file explanation',
          description:
            'Explains what a changed file does and what the PR changed in it.',
          placeholders: [
            'untrusted',
            'path',
            'changeKind',
            'problemStatement',
            'diff',
            'methodsShape',
            'methodsGuidance',
          ],
        },
        {
          namespace: 'prReview',
          key: 'graphChatPromptTemplate',
          label: 'Change-graph chat',
          description:
            'Answers a question about a change-graph category using a bounded ' +
            'graph summary and prior conversation.',
        },
      ],
    },
    checkPrerequisite(featureId) {
      if (deps.hasReview(featureId)) {
        return { met: true };
      }
      return {
        met: false,
        reason:
          'The Review Board needs a pull-request review on this feature. ' +
          'Import or open a PR for it first.',
      };
    },
  };
}
