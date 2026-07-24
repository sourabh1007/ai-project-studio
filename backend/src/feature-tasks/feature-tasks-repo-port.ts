import type { FeatureTask, FeatureTaskStatus } from './feature-tasks-contract.js';

/** Persistence port for a feature's task checklist. */
export interface FeatureTasksRepo {
  create(task: FeatureTask): void;
  get(id: string): FeatureTask | null;
  listByFeature(featureId: string): FeatureTask[];
  updateStatus(id: string, status: FeatureTaskStatus): void;
  delete(id: string): void;
  deleteByFeature(featureId: string): void;
  /** Highest position currently used by the feature, or -1 when empty. */
  maxPosition(featureId: string): number;
}
