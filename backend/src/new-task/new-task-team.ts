/**
 * The New Task implementation "team".
 *
 * A single agent implementing a whole plan serially is slow on large changes.
 * This module runs the implementation as a small team instead: a *lead agent*
 * (the "manager") decomposes the approved plan into file-disjoint slices, one
 * specialized *sub-agent* per slice (a `developer` or `tester`) implements its
 * files in parallel (each leasing its own metasession, so several run at once),
 * and the lead agent then reviews the combined result and builds only the
 * affected projects. Every agent reports live activity and metrics (time,
 * tokens, AI credits) so the UI can show the hierarchy and per-agent cost.
 *
 * Everything is port-driven and pure aside from the injected AI/clock, so the
 * 100% coverage gate can exercise every branch (parse fallbacks, sub-agent
 * failure, abort) without a provider.
 */

import { z } from 'zod';
import type { Clock } from '../kernel/clock.js';
import type { MetaRunResult, MetaRunner } from '../meta/meta-runner.js';
import type { NewTaskConfig } from './config.js';
import {
  buildDecomposePrompt,
  buildReviewPrompt,
  buildWorkerPrompt,
} from './new-task-prompt.js';
import type {
  NewTaskActivity,
  NewTaskAgent,
} from './new-task-contract.js';

/** The id the manager agent always uses. */
export const MANAGER_AGENT_ID = 'manager';

/** Sink the team streams its per-agent activity and metrics to. */
export interface NewTaskTeamSink {
  activity(activity: Omit<NewTaskActivity, 'runId'>): void;
  agent(agent: NewTaskAgent): void;
}

/** Inputs for one implementation team run. */
export interface NewTaskTeamRequest {
  featureId: string;
  worktreePath: string;
  problem: string;
  context: string;
  plan: string;
  sink: NewTaskTeamSink;
  signal?: AbortSignal;
}

/** The settled team, with each agent's final metrics. */
export interface NewTaskTeamResult {
  agents: NewTaskAgent[];
}

/** Dependencies for {@link createNewTaskTeam}. */
export interface NewTaskTeamDeps {
  ai: Pick<MetaRunner, 'runDetailed'>;
  clock: Clock;
  config: NewTaskConfig;
}

/** Runs an approved plan as a manager-led team of parallel workers. */
export interface NewTaskTeam {
  implement(request: NewTaskTeamRequest): Promise<NewTaskTeamResult>;
}

/** One decomposed slice of work the manager assigns to a sub-agent. */
interface WorkSlice {
  title: string;
  description: string;
  files: string[];
  /** The sub-agent specialization best suited to the slice. */
  role: 'developer' | 'tester';
}

const decompositionSchema = z.object({
  workers: z.array(
    z.object({
      title: z.string(),
      description: z.string().optional(),
      files: z.array(z.string()).optional(),
      role: z.enum(['developer', 'tester']).optional(),
    }),
  ),
});

/**
 * Pull the first JSON object out of a model response, tolerating a ```json
 * fence and surrounding prose. Returns null when no object-shaped span exists.
 */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  return candidate.slice(start, end + 1);
}

/**
 * Parse the manager's decomposition into file-disjoint slices, clamped to
 * `maxWorkers`. Files claimed by an earlier slice are dropped from later ones so
 * no two workers ever own the same file. Slices left with no files after that
 * dedupe are discarded. Falls back to a single whole-plan slice when the
 * response can't be parsed or yields no file-bearing slices.
 */
export function parseDecomposition(
  text: string,
  maxWorkers: number,
): WorkSlice[] {
  const fallback: WorkSlice[] = [
    {
      title: 'Full implementation',
      description: '',
      files: [],
      role: 'developer',
    },
  ];
  const json = extractJsonObject(text);
  if (!json) {
    return fallback;
  }
  let parsed: z.infer<typeof decompositionSchema>;
  try {
    parsed = decompositionSchema.parse(JSON.parse(json));
  } catch {
    return fallback;
  }
  const claimed = new Set<string>();
  const slices: WorkSlice[] = [];
  for (const raw of parsed.workers.slice(0, maxWorkers)) {
    const files: string[] = [];
    for (const file of raw.files ?? []) {
      const path = file.trim();
      if (path.length > 0 && !claimed.has(path)) {
        claimed.add(path);
        files.push(path);
      }
    }
    if (files.length === 0) {
      continue;
    }
    slices.push({
      title: raw.title.trim() || `Slice ${slices.length + 1}`,
      description: (raw.description ?? '').trim(),
      files,
      role: raw.role ?? 'developer',
    });
  }
  return slices.length > 0 ? slices : fallback;
}

/**
 * Derive the metrics fields from a metasession result. AI credits come straight
 * from the provider when present, otherwise from nano-AIU (1e9 nano-AIU = 1
 * AIC); warm sessions report neither, leaving credits null.
 */
export function agentMetricsOf(result: MetaRunResult): {
  inputTokens: number | null;
  outputTokens: number | null;
  credits: number | null;
} {
  const usage = result.usage ?? null;
  const credits =
    usage?.credits ??
    (usage && usage.nanoAiu != null ? usage.nanoAiu / 1_000_000_000 : null);
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    credits,
  };
}

/** Add two nullable metric values, treating null as "unknown, contributes 0". */
function addMetric(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

export function createNewTaskTeam(deps: NewTaskTeamDeps): NewTaskTeam {
  const nowMs = (): number => deps.clock.now().getTime();

  return {
    async implement(request): Promise<NewTaskTeamResult> {
      const { sink, signal } = request;

      // The manager is the root agent; its metrics accumulate across the
      // decompose turn and the later review turn.
      const manager: NewTaskAgent = {
        id: MANAGER_AGENT_ID,
        parentId: null,
        role: 'manager',
        title: 'Lead agent',
        files: [],
        status: 'running',
        startedAt: nowMs(),
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        credits: null,
      };
      let managerElapsed = 0;
      const emitManager = (): void => sink.agent({ ...manager });
      emitManager();

      const managerActivity = (line: string): void =>
        sink.activity({
          phase: 'implementing',
          line,
          agentId: MANAGER_AGENT_ID,
        });

      // 1. Decompose the plan into file-disjoint slices.
      managerActivity('🧭 Planning how to split the work across the team…');
      const decomposeStart = nowMs();
      const decompose = await deps.ai.runDetailed({
        featureId: request.featureId,
        prompt: buildDecomposePrompt(deps.config.decomposePromptTemplate, {
          problem: request.problem,
          context: request.context,
          plan: request.plan,
          maxWorkers: deps.config.maxWorkers,
        }),
        cwd: request.worktreePath,
        scope: 'internal',
        model: 'auto',
        label: 'New task · manager',
        timeoutMs: deps.config.implementTimeoutMs,
        signal,
        onActivity: managerActivity,
      });
      managerElapsed += nowMs() - decomposeStart;
      const decomposeMetrics = agentMetricsOf(decompose);
      manager.inputTokens = decomposeMetrics.inputTokens;
      manager.outputTokens = decomposeMetrics.outputTokens;
      manager.credits = decomposeMetrics.credits;
      manager.durationMs = managerElapsed;
      emitManager();

      const slices = parseDecomposition(decompose.text, deps.config.maxWorkers);
      managerActivity(
        `👥 Split the work into ${slices.length} ${
          slices.length === 1 ? 'slice' : 'parallel slices'
        }.`,
      );

      // 2. Build the sub-agents and run them in parallel.
      const workers: NewTaskAgent[] = slices.map((slice, index) => ({
        id: `sub-${index + 1}`,
        parentId: MANAGER_AGENT_ID,
        role: slice.role,
        title: slice.title,
        files: slice.files,
        status: 'pending',
        startedAt: null,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        credits: null,
      }));
      for (const worker of workers) {
        sink.agent({ ...worker });
      }

      await Promise.all(
        workers.map(async (worker, index) => {
          const slice = slices[index];
          worker.status = 'running';
          worker.startedAt = nowMs();
          sink.agent({ ...worker });
          const started = worker.startedAt;
          try {
            const result = await deps.ai.runDetailed({
              featureId: request.featureId,
              prompt: buildWorkerPrompt(deps.config.workerPromptTemplate, {
                problem: request.problem,
                context: request.context,
                plan: request.plan,
                title: slice.title,
                description: slice.description,
                files: slice.files,
                role: slice.role,
              }),
              cwd: request.worktreePath,
              scope: 'internal',
              model: 'auto',
              label: `New task · ${worker.title}`,
              timeoutMs: deps.config.implementTimeoutMs,
              signal,
              onActivity: (line) =>
                sink.activity({
                  phase: 'implementing',
                  line,
                  agentId: worker.id,
                }),
            });
            const metrics = agentMetricsOf(result);
            worker.status = 'done';
            worker.durationMs = nowMs() - started;
            worker.inputTokens = metrics.inputTokens;
            worker.outputTokens = metrics.outputTokens;
            worker.credits = metrics.credits;
            sink.agent({ ...worker });
          } catch (error) {
            worker.status = 'failed';
            worker.durationMs = nowMs() - started;
            sink.agent({ ...worker });
            throw error;
          }
        }),
      );

      // 3. Manager reviews the combined change and builds only affected projects.
      managerActivity(
        '🔎 Reviewing the combined changes and building the affected projects…',
      );
      const reviewStart = nowMs();
      const review = await deps.ai.runDetailed({
        featureId: request.featureId,
        prompt: buildReviewPrompt(deps.config.reviewPromptTemplate, {
          problem: request.problem,
          context: request.context,
          plan: request.plan,
        }),
        cwd: request.worktreePath,
        scope: 'internal',
        model: 'auto',
        label: 'New task · manager review',
        timeoutMs: deps.config.implementTimeoutMs,
        signal,
        onActivity: managerActivity,
      });
      managerElapsed += nowMs() - reviewStart;
      const reviewMetrics = agentMetricsOf(review);
      manager.inputTokens = addMetric(
        manager.inputTokens,
        reviewMetrics.inputTokens,
      );
      manager.outputTokens = addMetric(
        manager.outputTokens,
        reviewMetrics.outputTokens,
      );
      manager.credits = addMetric(manager.credits, reviewMetrics.credits);
      manager.durationMs = managerElapsed;
      manager.status = 'done';
      emitManager();

      return { agents: [manager, ...workers] };
    },
  };
}
