import type { PlannerTask } from './planner-contract.js';

/** Persistence port for the Planner's dated task checklist. */
export interface PlannerRepo {
  create(task: PlannerTask): void;
  get(id: string): PlannerTask | null;
  /** All tasks, newest date first then most recently created. */
  list(): PlannerTask[];
  update(task: PlannerTask): void;
  delete(id: string): void;
}
