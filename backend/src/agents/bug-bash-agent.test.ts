import { describe, it, expect } from 'vitest';
import { createBugBashAgent, BUG_BASH_AGENT_ID } from './bug-bash-agent.js';

describe('bug-bash-agent', () => {
  it('describes the agent manifest', () => {
    const agent = createBugBashAgent({ hasRepo: () => true });
    expect(agent.manifest.id).toBe(BUG_BASH_AGENT_ID);
    expect(agent.manifest.id).toBe('bug-bash');
    expect(agent.manifest.icon).toBe('bug-bash');
    expect(agent.manifest.allowMultiplePerFeature).toBe(true);
    expect(agent.manifest.usageLabel).toBe('Bug bash');
    expect(agent.manifest.promptFields.map((f) => f.key)).toEqual([
      'generatePromptTemplate',
      'testerPromptTemplate',
      'reportPromptTemplate',
    ]);
    expect(
      agent.manifest.promptFields.every((f) => f.namespace === 'bugBash'),
    ).toBe(true);
  });

  it('is attachable on a feature with a repository', () => {
    const agent = createBugBashAgent({ hasRepo: () => true });
    expect(agent.checkPrerequisite('f1')).toEqual({ met: true });
  });

  it('blocks with a reason when the feature has no repository', () => {
    const agent = createBugBashAgent({ hasRepo: () => false });
    const result = agent.checkPrerequisite('f1');
    expect(result.met).toBe(false);
    expect(result.reason).toMatch(/repository/i);
  });
});
