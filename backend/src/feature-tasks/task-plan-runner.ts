import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { FeatureTasksConfig } from './config.js';
import type { FeatureTask } from './feature-tasks-contract.js';
import type { FeatureTasksRepo } from './feature-tasks-repo-port.js';
import { buildTaskPlanPrompt } from './task-plan-prompt-builder.js';
import { parseTaskPlan } from './task-plan-parser.js';

export interface TaskPlanRunnerDeps {
  meta: MetaRunner;
  features: FeatureService;
  repo: FeatureTasksRepo;
  ids: IdGenerator;
  clock: Clock;
  config: FeatureTasksConfig;
}

/** Generates and persists a feature's task checklist from an AI plan. */
export interface TaskPlanRunner {
  generate(featureId: string): Promise<FeatureTask[]>;
}

/**
 * Runs the task-plan skill: a headless meta AI session is asked to break a
 * feature into ordered sub-tasks (strict JSON), the response is tolerantly
 * parsed, and the feature's checklist is replaced with the fresh plan. Reuses
 * the shared meta-runner so it shares the summarizer's launcher/extractor flow.
 */
export function createTaskPlanRunner(deps: TaskPlanRunnerDeps): TaskPlanRunner {
  return {
    async generate(featureId) {
      // Throws NotFoundError when the feature does not exist.
      const feature = deps.features.get(featureId);
      const prompt = buildTaskPlanPrompt(feature, deps.config);
      const response = await deps.meta.run({ featureId, prompt });
      const drafts = parseTaskPlan(response, deps.config);

      deps.repo.deleteByFeature(featureId);
      const createdAt = deps.clock.isoNow();
      return drafts.map((draft, index) => {
        const task: FeatureTask = {
          id: deps.ids.next(),
          featureId,
          title: draft.title,
          detail: draft.detail,
          status: 'pending',
          position: index,
          createdAt,
        };
        deps.repo.create(task);
        return task;
      });
    },
  };
}
