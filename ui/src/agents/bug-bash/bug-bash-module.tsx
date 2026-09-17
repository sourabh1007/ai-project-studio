import { lazy } from 'react';
import type {
  AgentUiModule,
  AgentUiProps,
} from '../../agent-host/agent-ui-contract.js';

/**
 * The Bug Bash agent: capture a feature's information + setup, generate
 * edge-case test scenarios grounded in the description and repository code,
 * let the user review/accept them, then run them across a team of parallel
 * tester sub-agents and compile a report. It only reads the repo — no git
 * worktree, no edits, no pull request. Everything it renders is derived from
 * the run persisted per attachment, so multiple Bug Bash instances can coexist
 * on one feature.
 */
export const bugBashModule: AgentUiModule = {
  id: 'bug-bash',
  title: 'Bug Bash',
  icon: 'bug-bash',
  allowMultiplePerFeature: true,
  component: lazy(() =>
    import('../../features/bug-bash-page/bug-bash-page.js').then((m) => ({
      default: ({ ctx }: AgentUiProps) => (
        <m.BugBashPage feature={ctx.feature} attachmentId={ctx.attachmentId} />
      ),
    })),
  ),
};
