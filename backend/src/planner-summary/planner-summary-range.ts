import type { PlannerTask } from '../planner/planner-contract.js';
import type { PlannerSummaryScope } from './planner-summary-contract.js';

/**
 * The portion of an anchor `YYYY-MM-DD` date that identifies the scope: the
 * full day, the `YYYY-MM` month, or the `YYYY` year. Used both to filter tasks
 * and as the human-readable range label.
 */
export function scopeRange(scope: PlannerSummaryScope, date: string): string {
  if (scope === 'year') {
    return date.slice(0, 4);
  }
  if (scope === 'month') {
    return date.slice(0, 7);
  }
  return date.slice(0, 10);
}

/**
 * Selects the tasks whose calendar day falls within `scope` around `date`,
 * sorted by date then creation order so the rendered list reads chronologically.
 */
export function tasksInScope(
  tasks: readonly PlannerTask[],
  scope: PlannerSummaryScope,
  date: string,
): PlannerTask[] {
  const prefix = scopeRange(scope, date);
  return tasks
    .filter((task) => task.date.startsWith(prefix))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt),
    );
}
