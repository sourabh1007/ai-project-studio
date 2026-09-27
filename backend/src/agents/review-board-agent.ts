import type { AgentDefinition, AgentPromptField } from './agent-contract.js';
import {
  COMMON_PROMPT_PLACEHOLDERS,
  PERSPECTIVE_CONFIG_KEYS,
  PERSPECTIVE_LABELS,
  REVIEW_PERSPECTIVE_IDS,
} from '../review-board/review-board-perspective-prompts.js';

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
  const perspectiveFields: AgentPromptField[] = REVIEW_PERSPECTIVE_IDS.flatMap(
    (id) => {
      const keys = PERSPECTIVE_CONFIG_KEYS[id];
      const label = PERSPECTIVE_LABELS[id];
      const isProblemSolution = id === 'problem-solution';
      const focusPlaceholders = isProblemSolution
        ? [...COMMON_PROMPT_PLACEHOLDERS, 'distilledProblem', 'solutionDigest']
        : [...COMMON_PROMPT_PLACEHOLDERS];
      return [
        {
          namespace: 'reviewBoard',
          key: keys.focus,
          label: 'Focus',
          description: `What the ${label} lens digs into, tied to the change.`,
          placeholders: focusPlaceholders,
          group: 'Review perspectives',
          subgroup: label,
        },
        {
          namespace: 'reviewBoard',
          key: keys.issueFormat,
          label: 'Issue format',
          description: `How the ${label} lens' rationale and findings should read.`,
          group: 'Review perspectives',
          subgroup: label,
        },
      ];
    },
  );
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
          key: 'commonReviewGuidance',
          label: 'Common review guidance',
          description:
            'Shared opening every perspective prompt uses — how to review ' +
            '(concise, evidence-tied, single-lens) and which languages/config ' +
            'formats to expect.',
          placeholders: [...COMMON_PROMPT_PLACEHOLDERS],
          group: 'Foundation',
        },
        ...perspectiveFields,
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
          group: 'PR analysis',
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
          group: 'PR analysis',
        },
        {
          namespace: 'prReview',
          key: 'graphChatPromptTemplate',
          label: 'Change-graph chat',
          description:
            'Answers a question about a change-graph category using a bounded ' +
            'graph summary and prior conversation.',
          group: 'PR analysis',
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
