import type { Clock } from '../kernel/clock.js';
import type { Feature } from '../feature/feature-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { PlannerService } from '../planner/planner-service.js';
import type { PlannerSummaryConfig } from './config.js';
import type {
  PlannerSummarizer,
  PlannerSummaryResult,
} from './planner-summary-contract.js';
import { buildPlannerSummaryPrompt } from './planner-summary-prompt.js';
import { finalizeSummary } from './planner-summary-response.js';
import { scopeRange, tasksInScope } from './planner-summary-range.js';

export interface PlannerSummaryRunnerDeps {
  planner: Pick<PlannerService, 'list'>;
  features: Pick<FeatureService, 'list' | 'create'>;
  /**
   * Shared headless-AI primitive. Routing through it (rather than the raw
   * session launcher) is what makes summaries fast: it leases a warm pooled
   * metasession and finishes the instant the provider emits its terminal
   * `result` event instead of waiting out a full cold CLI process exit.
   */
  meta: Pick<MetaRunner, 'run'>;
  clock: Clock;
  config: PlannerSummaryConfig;
}

/**
 * Runs an AI summary of the planner tasks in a requested scope (day/month/year)
 * via the shared MetaRunner. The run is attributed to a persistent internal
 * host feature so its credit usage is visible in Usage, and declares its prompt
 * tool-free (`noTools` + `toolsOptional`) so the warm ACP pool can serve it
 * quickly. The core stays provider-agnostic: provider/model come from the
 * user's meta settings inside the MetaRunner.
 */
export function createPlannerSummaryRunner(
  deps: PlannerSummaryRunnerDeps,
): PlannerSummarizer {
  /** Finds the reusable internal host feature, creating it once if absent. */
  const hostFeature = (): Feature => {
    const existing = deps.features
      .list()
      .find(
        (feature) =>
          (feature.repoId ?? null) === null &&
          feature.name === deps.config.hostFeatureName,
      );
    return (
      existing ??
      deps.features.create({
        name: deps.config.hostFeatureName,
        description: deps.config.hostFeatureDescription,
        repoId: null,
      })
    );
  };

  return {
    async summarize(request): Promise<PlannerSummaryResult> {
      request.signal?.throwIfAborted();
      const tasks = tasksInScope(
        deps.planner.list(),
        request.scope,
        request.date,
      );
      const prompt = buildPlannerSummaryPrompt(tasks, request, deps.config);
      const host = hostFeature();

      const text = await deps.meta.run({
        featureId: host.id,
        scope: 'internal',
        prompt,
        noTools: true,
        toolsOptional: true,
        purpose: 'planner-summary',
        label: 'Planner summary',
        signal: request.signal,
      });

      const summary = finalizeSummary(text, deps.config);
      return {
        scope: request.scope,
        date: request.date,
        range: scopeRange(request.scope, request.date),
        content:
          summary.length > 0 ? summary : deps.config.emptySummaryPlaceholder,
        taskCount: tasks.length,
        createdAt: deps.clock.isoNow(),
      };
    },
  };
}
