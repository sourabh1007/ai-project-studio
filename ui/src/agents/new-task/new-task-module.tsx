import { lazy } from 'react';
import type {
  AgentUiModule,
  AgentUiProps,
} from '../../agent-host/agent-ui-contract.js';

/**
 * The New Task agent: capture a problem + context, plan the change, and — on
 * user approval — implement it, open a pull request, and convert the task into
 * a Review-Board-eligible "PR task". Everything it renders is derived from the
 * run persisted per attachment, so multiple New Task instances can coexist on
 * one feature.
 */
export const newTaskModule: AgentUiModule = {
  id: 'new-task',
  title: 'New Task',
  icon: 'new-task',
  allowMultiplePerFeature: true,
  component: lazy(() =>
    import('../../features/new-task-page/new-task-page.js').then((m) => ({
      default: ({ ctx }: AgentUiProps) => (
        <m.NewTaskPage feature={ctx.feature} attachmentId={ctx.attachmentId} />
      ),
    })),
  ),
};
