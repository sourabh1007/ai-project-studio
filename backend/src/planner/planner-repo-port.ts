import type { PlannerTask } from './planner-contract.js';

/** Persistence port for the Planner's dated task checklist. */
export interface PlannerRepo {
  create(task: PlannerTask): void;
  get(id: string): PlannerTask | null;
  /** All tasks, newest date first then most recently created. */
  list(): PlannerTask[];
  update(task: PlannerTask): void;
  delete(id: string): void;
  /**
   * Clears the launch link (kind/feature/session/label) on every task that was
   * launched into the given feature, so a deleted workspace feature is
   * reflected back on the Planner and the task can be relaunched.
   */
  clearLaunchByFeature(featureId: string): void;
  /** Clears the launch link on every task that opened the given session. */
  clearLaunchBySession(sessionId: string): void;
}
