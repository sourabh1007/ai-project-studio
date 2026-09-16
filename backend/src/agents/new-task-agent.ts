import type { AgentDefinition } from './agent-contract.js';

/** Dependencies for the New Task agent definition. */
export interface NewTaskAgentDeps {
  /**
   * True when the feature has a repository the agent can plan and implement a
   * change in. Wired in `main.ts` to the feature's repo lookup, so the
   * prerequisite stays a pure predicate here.
   */
  hasRepo(featureId: string): boolean;
  /**
   * True when the feature is already a PR feature (it has a pull-request
   * review). New Task starts from a plain feature and *produces* the PR, so it
   * must not be offered where a PR already exists — the Review Board is the
   * agent for those. Wired to the non-throwing PR-review lookup.
   */
  hasReview(featureId: string): boolean;
}

/** Stable id for the built-in New Task agent. */
export const NEW_TASK_AGENT_ID = 'new-task';

/**
 * The New Task agent: attach it to a feature to solve a problem in its
 * repository end to end. It captures a problem statement + context, plans the
 * change for the user to review, and — on approval — implements it, opens a
 * pull request, and converts the task into a Review-Board-eligible "PR task".
 * Multiple can be attached to one feature, each solving a distinct problem.
 */
export function createNewTaskAgent(deps: NewTaskAgentDeps): AgentDefinition {
  return {
    manifest: {
      id: NEW_TASK_AGENT_ID,
      title: 'New Task',
      description:
        'Solves a problem in the feature’s repository: it plans the change for ' +
        'you to review, then implements it and opens a pull request you can ' +
        'send to the Review Board.',
      icon: 'new-task',
      allowMultiplePerFeature: true,
      prerequisiteLabel: 'a linked repository',
      usageLabel: 'New task',
      promptFields: [
        {
          namespace: 'newTask',
          key: 'planPromptTemplate',
          label: 'Change planning',
          description:
            'Turns the problem statement and context into a concrete, reviewable ' +
            'implementation plan grounded in the repository’s code.',
          placeholders: ['problem', 'context'],
        },
        {
          namespace: 'newTask',
          key: 'implementPromptTemplate',
          label: 'Change implementation',
          description:
            'Implements the approved plan by editing the repository worktree, ' +
            'ready to be committed and opened as a pull request.',
          placeholders: ['problem', 'context', 'plan'],
        },
      ],
    },
    checkPrerequisite(featureId) {
      if (!deps.hasRepo(featureId)) {
        return {
          met: false,
          reason:
            'New Task needs a repository to work in. Link this feature to a ' +
            'repository first.',
        };
      }
      if (deps.hasReview(featureId)) {
        return {
          met: false,
          reason:
            'This feature is already a PR task. New Task creates a new pull ' +
            'request from a plain feature — use the Review Board to review an ' +
            'existing pull request.',
        };
      }
      return { met: true };
    },
  };
}
