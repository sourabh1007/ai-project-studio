import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { FeatureTasksConfig } from './config.js';
import type { AddTaskInput, FeatureTask } from './feature-tasks-contract.js';
import type { FeatureTasksRepo } from './feature-tasks-repo-port.js';
import type { TaskPlanRunner } from './task-plan-runner.js';

export interface FeatureTasksServiceDeps {
  repo: FeatureTasksRepo;
  runner: TaskPlanRunner;
  features: FeatureService;
  ids: IdGenerator;
  clock: Clock;
  config: FeatureTasksConfig;
}

export interface FeatureTasksService {
  listForFeature(featureId: string): FeatureTask[];
  generate(featureId: string): Promise<FeatureTask[]>;
  addTask(input: AddTaskInput): FeatureTask;
  toggle(taskId: string): FeatureTask;
  removeTask(taskId: string): void;
}

/** Application service for a feature's task checklist (the task-plan skill). */
export function createFeatureTasksService(
  deps: FeatureTasksServiceDeps,
): FeatureTasksService {
  const requireTask = (id: string): FeatureTask => {
    const task = deps.repo.get(id);
    if (!task) {
      throw new NotFoundError(`Unknown task: ${id}`);
    }
    return task;
  };

  const validateTitle = (title: string): string => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new ValidationError('Task title must not be empty');
    }
    if (trimmed.length > deps.config.maxTitleLength) {
      throw new ValidationError(
        `Task title exceeds ${deps.config.maxTitleLength} characters`,
      );
    }
    return trimmed;
  };

  return {
    listForFeature(featureId) {
      // Throws NotFoundError when the feature does not exist.
      deps.features.get(featureId);
      return deps.repo.listByFeature(featureId);
    },
    generate(featureId) {
      return deps.runner.generate(featureId);
    },
    addTask(input) {
      deps.features.get(input.featureId);
      const title = validateTitle(input.title);
      const task: FeatureTask = {
        id: deps.ids.next(),
        featureId: input.featureId,
        title,
        detail: input.detail?.trim() ?? '',
        status: 'pending',
        position: deps.repo.maxPosition(input.featureId) + 1,
        createdAt: deps.clock.isoNow(),
      };
      deps.repo.create(task);
      return task;
    },
    toggle(taskId) {
      const task = requireTask(taskId);
      const status = task.status === 'done' ? 'pending' : 'done';
      deps.repo.updateStatus(taskId, status);
      return { ...task, status };
    },
    removeTask(taskId) {
      requireTask(taskId);
      deps.repo.delete(taskId);
    },
  };
}
