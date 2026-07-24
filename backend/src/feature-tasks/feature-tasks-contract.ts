/** Contracts for feature tasks — the checklist produced by the task-plan skill. */

export type FeatureTaskStatus = 'pending' | 'done';

export interface FeatureTask {
  id: string;
  featureId: string;
  title: string;
  detail: string;
  status: FeatureTaskStatus;
  /** Zero-based ordering within the feature's checklist. */
  position: number;
  createdAt: string;
}

/** A parsed, not-yet-persisted task from an AI-generated plan. */
export interface TaskDraft {
  title: string;
  detail: string;
}

export interface AddTaskInput {
  featureId: string;
  title: string;
  detail?: string;
}
