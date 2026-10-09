import type { PlannerTask } from '../planner/planner-contract.js';
import type { PlannerSummaryConfig } from './config.js';
import type {
  PlannerSummaryRequest,
  PlannerSummaryScope,
} from './planner-summary-contract.js';
import { scopeRange } from './planner-summary-range.js';

/** Human noun for each scope, used in the prompt sentence. */
const SCOPE_NOUN: Record<PlannerSummaryScope, string> = {
  day: 'day',
  month: 'month',
  year: 'year',
};

/** Renders a single task line from the configured task template. */
function renderTask(task: PlannerTask, config: PlannerSummaryConfig): string {
  const mark = task.status === 'done' ? config.doneMark : config.openMark;
  return config.taskTemplate
    .replaceAll('{{mark}}', mark)
    .replaceAll('{{date}}', task.date)
    .replaceAll('{{priority}}', task.priority)
    .replaceAll('{{title}}', task.title);
}

/**
 * Builds the full meta-session prompt for a planner summary: fills the scope,
 * range, caller guidance (or a default), and the rendered task list — or the
 * no-tasks placeholder when the scope is empty — into the configured template.
 */
export function buildPlannerSummaryPrompt(
  tasks: readonly PlannerTask[],
  request: PlannerSummaryRequest,
  config: PlannerSummaryConfig,
): string {
  const rendered =
    tasks.length === 0
      ? config.noTasksPlaceholder
      : tasks.map((task) => renderTask(task, config)).join(config.taskSeparator);
  const guidance = request.prompt.trim() || config.defaultGuidance;
  return config.promptTemplate
    .replaceAll('{{scope}}', SCOPE_NOUN[request.scope])
    .replaceAll('{{range}}', scopeRange(request.scope, request.date))
    .replaceAll('{{guidance}}', guidance)
    .replaceAll('{{tasks}}', rendered);
}
