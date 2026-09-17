import type { AgentDefinition } from './agent-contract.js';

/** Dependencies for the Bug Bash agent definition. */
export interface BugBashAgentDeps {
  /**
   * True when the feature has a repository the agent can read to design and run
   * scenarios. Wired in `main.ts` to the feature's repo lookup, so the
   * prerequisite stays a pure predicate here.
   */
  hasRepo(featureId: string): boolean;
}

/** Stable id for the built-in Bug Bash agent. */
export const BUG_BASH_AGENT_ID = 'bug-bash';

/**
 * The Bug Bash agent: attach it to a feature to stress-test one of its
 * behaviours. It takes a feature description plus setup instructions, generates
 * edge-case scenarios grounded in the repository's code for the user to review,
 * and — on acceptance — runs them across a team of parallel tester sub-agents
 * and compiles a report. Multiple can be attached to one feature.
 */
export function createBugBashAgent(deps: BugBashAgentDeps): AgentDefinition {
  return {
    manifest: {
      id: BUG_BASH_AGENT_ID,
      title: 'Bug Bash',
      description:
        'Stress-tests a feature: it generates edge-case scenarios grounded in ' +
        'the repository’s code for you to review, then runs them across a team ' +
        'of tester agents and reports what breaks.',
      icon: 'bug-bash',
      allowMultiplePerFeature: true,
      prerequisiteLabel: 'a linked repository',
      usageLabel: 'Bug bash',
      promptFields: [
        {
          namespace: 'bugBash',
          key: 'generatePromptTemplate',
          label: 'Scenario generation',
          description:
            'Mines the feature description, setup information and repository ' +
            'code for edge-case test scenarios most likely to break the feature.',
          placeholders: ['featureInfo', 'setupInfo'],
        },
        {
          namespace: 'bugBash',
          key: 'testerPromptTemplate',
          label: 'Scenario execution',
          description:
            'Runs one group of accepted scenarios against the feature and ' +
            'reports pass / fail / blocked with observations.',
          placeholders: ['featureInfo', 'setupInfo', 'scenarios'],
        },
        {
          namespace: 'bugBash',
          key: 'reportPromptTemplate',
          label: 'Report',
          description:
            'Reviews the collected scenario results and compiles the final ' +
            'markdown bug-bash report.',
          placeholders: ['featureInfo', 'results'],
        },
      ],
    },
    checkPrerequisite(featureId) {
      if (!deps.hasRepo(featureId)) {
        return {
          met: false,
          reason:
            'Bug Bash needs a repository to read and exercise. Link this ' +
            'feature to a repository first.',
        };
      }
      return { met: true };
    },
  };
}
