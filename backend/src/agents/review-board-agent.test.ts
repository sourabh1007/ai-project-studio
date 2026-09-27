import { describe, it, expect } from 'vitest';
import { createReviewBoardAgent, REVIEW_BOARD_AGENT_ID } from './review-board-agent.js';
import {
  PERSPECTIVE_CONFIG_KEYS,
  REVIEW_PERSPECTIVE_IDS,
} from '../review-board/review-board-perspective-prompts.js';

describe('review-board-agent', () => {
  it('exposes a single-instance manifest with editable review prompts', () => {
    const agent = createReviewBoardAgent({ hasReview: () => true });
    expect(agent.manifest.id).toBe(REVIEW_BOARD_AGENT_ID);
    expect(agent.manifest.allowMultiplePerFeature).toBe(false);
    expect(agent.manifest.usageLabel).toBe('Review board');
    const perspectiveKeys = REVIEW_PERSPECTIVE_IDS.flatMap((id) => [
      PERSPECTIVE_CONFIG_KEYS[id].focus,
      PERSPECTIVE_CONFIG_KEYS[id].issueFormat,
    ]);
    expect(agent.manifest.promptFields.map((f) => f.key)).toEqual([
      'commonReviewGuidance',
      ...perspectiveKeys,
      'problemStatementPromptTemplate',
      'fileExplanationPromptTemplate',
      'graphChatPromptTemplate',
    ]);
    expect(
      agent.manifest.promptFields.every(
        (f) => f.namespace === 'reviewBoard' || f.namespace === 'prReview',
      ),
    ).toBe(true);
  });

  it('is attachable only when the feature has a PR review', () => {
    const withReview = createReviewBoardAgent({ hasReview: () => true });
    expect(withReview.checkPrerequisite('f1')).toEqual({ met: true });

    const withoutReview = createReviewBoardAgent({ hasReview: () => false });
    const result = withoutReview.checkPrerequisite('f1');
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/pull-request review/);
  });

  it('passes the feature id through to the review predicate', () => {
    const seen: string[] = [];
    const agent = createReviewBoardAgent({
      hasReview: (featureId) => {
        seen.push(featureId);
        return true;
      },
    });
    agent.checkPrerequisite('feature-42');
    expect(seen).toEqual(['feature-42']);
  });
});
