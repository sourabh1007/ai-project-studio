import type { FeatureTask } from './types.js';

export interface TaskProgress {
  done: number;
  total: number;
  /** Completion as an integer percentage (0 when there are no tasks). */
  percent: number;
}

/** Computes checklist completion for a feature's tasks (pure, UI-agnostic). */
export function taskProgress(tasks: readonly FeatureTask[]): TaskProgress {
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === 'done').length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, percent };
}

/** True when a feature has any task-plan skill tagged (checklist is enabled). */
export function hasTaskPlanSkill(
  skills: readonly { kind: string }[],
): boolean {
  return skills.some((skill) => skill.kind === 'task-plan');
}
