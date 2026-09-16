import { describe, it, expect } from 'vitest';
import { createNewTaskAgent, NEW_TASK_AGENT_ID } from './new-task-agent.js';

describe('new-task-agent', () => {
  it('describes the agent manifest', () => {
    const agent = createNewTaskAgent({ hasRepo: () => true, hasReview: () => false });
    expect(agent.manifest.id).toBe(NEW_TASK_AGENT_ID);
    expect(agent.manifest.id).toBe('new-task');
    expect(agent.manifest.icon).toBe('new-task');
    expect(agent.manifest.allowMultiplePerFeature).toBe(true);
    expect(agent.manifest.usageLabel).toBe('New task');
    expect(agent.manifest.promptFields.map((f) => f.key)).toEqual([
      'planPromptTemplate',
      'implementPromptTemplate',
    ]);
    expect(
      agent.manifest.promptFields.every((f) => f.namespace === 'newTask'),
    ).toBe(true);
  });

  it('is attachable on a plain feature with a repository and no PR review', () => {
    const agent = createNewTaskAgent({ hasRepo: () => true, hasReview: () => false });
    expect(agent.checkPrerequisite('f1')).toEqual({ met: true });
  });

  it('blocks with a reason when the feature has no repository', () => {
    const agent = createNewTaskAgent({ hasRepo: () => false, hasReview: () => false });
    const result = agent.checkPrerequisite('f1');
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/repository/i);
  });

  it('blocks when the feature is already a PR task (has a review)', () => {
    const agent = createNewTaskAgent({ hasRepo: () => true, hasReview: () => true });
    const result = agent.checkPrerequisite('f1');
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/already a PR task/i);
  });
});
