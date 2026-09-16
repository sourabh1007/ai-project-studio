/**
 * Application service backing the New Task agent.
 *
 * The service is thin orchestration over injected ports: it persists the run,
 * drives the AI planner and implementer, isolates the change in a dedicated git
 * worktree, opens a pull request, and converts the task into a Review-Board-
 * eligible "PR task". All I/O lives behind ports so the 100% coverage gate can
 * exercise every branch without a provider, git, or GitHub.
 */

import type { Clock } from '../kernel/clock.js';
import type { EventBus } from '../kernel/event-bus.js';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import { MetaAbortError, type MetaRunner } from '../meta/meta-runner.js';
import type { NewTaskConfig } from './config.js';
import { buildPlanPrompt } from './new-task-prompt.js';
import { agentMetricsOf, type NewTaskTeam } from './new-task-team.js';
import type {
  NewTaskAgent,
  NewTaskEventMap,
  NewTaskGitPort,
  NewTaskImplementSink,
  NewTaskInputs,
  NewTaskPrPort,
  NewTaskReviewPort,
  NewTaskRun,
  NewTaskRunRepo,
  NewTaskService,
  NewTaskWorkspaceResolver,
} from './new-task-contract.js';

/** Dependencies for {@link createNewTaskService}. */
export interface NewTaskServiceDeps {
  repo: NewTaskRunRepo;
  workspace: NewTaskWorkspaceResolver;
  git: NewTaskGitPort;
  pr: NewTaskPrPort;
  reviews: NewTaskReviewPort;
  config: NewTaskConfig;
  clock: Clock;
  /** The reusable "run an AI prompt" primitive. */
  ai: Pick<MetaRunner, 'runDetailed'>;
  /** The manager-led team that implements an approved plan in parallel. */
  team: NewTaskTeam;
  /** Publishes live progress so the UI can stream it over the bus too. */
  bus: Pick<EventBus<NewTaskEventMap>, 'emit'>;
}

/** Read the message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render the exact prompt handed to the metasession as a single, multi-line
 * activity entry so the live log opens with "here is what the agent was asked
 * to do" before the streamed reasoning/tool events arrive. The UI log renders
 * each entry with `white-space: pre-wrap`, so the embedded newlines are kept.
 */
function promptActivity(prompt: string): string {
  return `📝 Prompt sent to the agent:\n${prompt.trim()}`;
}

/** Derive a concise PR title from the problem statement. */
export function deriveTitle(problem: string): string {
  const firstLine =
    problem
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'New task';
  const max = 72;
  return firstLine.length <= max
    ? firstLine
    : `${firstLine.slice(0, max - 1)}…`;
}

/**
 * Azure DevOps rejects a pull-request description longer than 4000 characters,
 * so keep the composed body comfortably under that ceiling. The plan can run to
 * many thousands of characters, so it is truncated to whatever budget the fixed
 * sections leave; the full plan always lives on the branch.
 */
export const PR_BODY_MAX = 3900;

const PLAN_TRUNCATION_NOTE =
  '\n\n… _(plan truncated to fit the pull-request description limit; the full plan is on the branch.)_';

/**
 * Compose the PR body from just the problem and the approved plan (the
 * solution) — nothing else. The plan is presented as the "Solution" and
 * truncated to whatever budget the fixed sections leave; the full plan always
 * lives on the branch.
 */
export function derivePrBody(run: NewTaskRun): string {
  const prefix = ['## Problem', run.problem.trim(), '', '## Solution', ''].join(
    '\n',
  );
  const plan = (run.plan ?? '').trim();
  const budget = PR_BODY_MAX - prefix.length;
  const planText =
    plan.length <= budget
      ? plan
      : `${plan.slice(0, Math.max(0, budget - PLAN_TRUNCATION_NOTE.length))}${PLAN_TRUNCATION_NOTE}`;
  const body = `${prefix}${planText}`;
  return body.length <= PR_BODY_MAX ? body : `${body.slice(0, PR_BODY_MAX - 1)}…`;
}

export function createNewTaskService(
  deps: NewTaskServiceDeps,
): NewTaskService {
  function touch(run: NewTaskRun, patch: Partial<NewTaskRun>): NewTaskRun {
    const next: NewTaskRun = {
      ...run,
      ...patch,
      updatedAt: deps.clock.isoNow(),
    };
    deps.repo.update(next);
    return next;
  }

  function emit(
    run: NewTaskRun,
    phase: NewTaskEventMap['new-task.activity']['phase'],
    line: string,
    agentId?: string,
  ): void {
    deps.bus.emit('new-task.activity', { runId: run.id, phase, line, agentId });
  }

  /** Build the single-agent "Planner" snapshot from a planning turn's result. */
  function plannerAgent(
    result: { usage?: Parameters<typeof agentMetricsOf>[0]['usage'] },
    durationMs: number,
  ): NewTaskAgent {
    const metrics = agentMetricsOf(result as Parameters<typeof agentMetricsOf>[0]);
    return {
      id: 'planner',
      parentId: null,
      role: 'planner',
      title: 'Planner',
      files: [],
      status: 'done',
      startedAt: null,
      durationMs,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      credits: metrics.credits,
    };
  }

  function requireRun(attachmentId: string): NewTaskRun {
    const run = deps.repo.get(attachmentId);
    if (!run) {
      throw new NotFoundError(`No New Task run for attachment: ${attachmentId}`);
    }
    return run;
  }

  return {
    get(attachmentId) {
      return deps.repo.get(attachmentId);
    },

    reset(attachmentId) {
      const run = deps.repo.get(attachmentId);
      if (!run) {
        return null;
      }
      if (run.status === 'pr-created') {
        // A shipped task has an open PR; there is nothing to cancel or reset.
        return run;
      }
      return touch(run, { status: 'draft', plan: null, error: null });
    },

    async fileDiff(attachmentId, path) {
      const run = requireRun(attachmentId);
      const cleanPath = path.trim();
      if (cleanPath.length === 0) {
        throw new ValidationError('A file path is required.');
      }
      if (!run.branch) {
        throw new ValidationError(
          'This task has no branch yet, so there is no diff to show.',
        );
      }
      const workspace = deps.workspace.resolve(run.featureId);
      const worktreePath = deps.git.worktreePathFor(
        workspace.repoLocalPath,
        run.id,
      );
      return deps.git.fileDiff({
        worktreePath,
        baseBranch: workspace.baseBranch,
        path: cleanPath,
      });
    },

    saveInputs(attachmentId, featureId, inputs: NewTaskInputs) {
      const problem = inputs.problem.trim();
      if (problem.length === 0) {
        throw new ValidationError('A problem statement is required.');
      }
      const context = inputs.context.trim();
      const existing = deps.repo.get(attachmentId);
      if (existing && existing.status === 'pr-created') {
        throw new ValidationError(
          'This task already has an open pull request; start a new task to solve another problem.',
        );
      }
      const now = deps.clock.isoNow();
      if (existing) {
        // Re-editing resets the plan and any prior failure back to a draft.
        return touch(existing, {
          featureId,
          problem,
          context,
          plan: null,
          status: 'draft',
          error: null,
        });
      }
      const run: NewTaskRun = {
        id: attachmentId,
        featureId,
        problem,
        context,
        plan: null,
        status: 'draft',
        branch: null,
        prNumber: null,
        prUrl: null,
        reviewFeatureId: null,
        error: null,
        agents: [],
        createdAt: now,
        updatedAt: now,
      };
      deps.repo.create(run);
      return run;
    },

    async plan(attachmentId, signal, sink, options) {
      let run = requireRun(attachmentId);
      if (run.status === 'pr-created') {
        throw new ValidationError(
          'This task already has an open pull request.',
        );
      }
      const workspace = deps.workspace.resolve(run.featureId);
      const baseBranch = options?.baseBranch?.trim() || workspace.baseBranch;
      run = touch(run, { status: 'planning', error: null });
      try {
        const planPrompt = buildPlanPrompt(deps.config.planPromptTemplate, {
          problem: run.problem,
          context: run.context,
          suggestion: options?.suggestion,
        });
        // Open the live log with the exact prompt and a worktree-prep notice
        // *before* the (potentially slow) git fetch/worktree add, so the panel
        // is never blank while git prepares the isolated checkout.
        sink?.activity({ phase: 'planning', line: promptActivity(planPrompt) });
        sink?.activity({
          phase: 'planning',
          line: `🌱 Preparing an isolated worktree from ${baseBranch}…`,
        });
        const worktree = await deps.git.prepareWorktree({
          repoLocalPath: workspace.repoLocalPath,
          baseBranch,
          runId: run.id,
          name: run.problem,
          previousBranch: run.branch ?? undefined,
        });
        run = touch(run, { branch: worktree.branch });
        sink?.activity({
          phase: 'planning',
          line: `🌿 Working on branch ${worktree.branch}.`,
        });
        const plannerStartedMs = deps.clock.now().getTime();
        const result = await deps.ai.runDetailed({
          featureId: run.featureId,
          prompt: planPrompt,
          cwd: worktree.worktreePath,
          scope: 'internal',
          // Pin the auto model so the warm-route policy keeps this turn eligible
          // for a warm metasession regardless of the user's configured meta
          // model. Warm sessions run the provider's default model anyway, and
          // pinning a specific model here would cold-spawn a process per turn
          // (leaving the warm pool idle), which is exactly the stall this path
          // must avoid.
          model: 'auto',
          label: 'New task',
          timeoutMs: deps.config.planTimeoutMs,
          signal,
          onActivity: (line) => {
            emit(run, 'planning', line, 'planner');
            sink?.activity({ phase: 'planning', line, agentId: 'planner' });
          },
        });
        const planner = plannerAgent(
          result,
          deps.clock.now().getTime() - plannerStartedMs,
        );
        sink?.agent?.(planner);
        const planned = touch(run, {
          plan: result.text.trim(),
          status: 'planned',
          agents: [planner],
        });
        sink?.done(planned);
        return planned;
      } catch (error) {
        if (signal?.aborted) {
          // The user cancelled: the cancel endpoint resets the run to a clean
          // draft, so don't clobber that with a failure state here.
          sink?.failed('Planning was cancelled.');
          return run;
        }
        const message = errorMessage(error);
        const failed = touch(run, { status: 'failed', error: message });
        if (sink) {
          sink.failed(message);
          return failed;
        }
        throw error;
      }
    },

    async implement(
      attachmentId,
      sink: NewTaskImplementSink,
      signal,
    ) {
      let run = requireRun(attachmentId);
      if (run.status === 'pr-created') {
        sink.failed('This task already has an open pull request.');
        return;
      }
      if (
        (run.status !== 'planned' &&
          run.status !== 'implementing' &&
          run.status !== 'failed') ||
        !run.plan ||
        !run.branch
      ) {
        sink.failed('Approve a plan before implementing.');
        return;
      }
      const workspace = deps.workspace.resolve(run.featureId);
      const branch = run.branch;
      const plan = run.plan;
      const worktreePath = deps.git.worktreePathFor(
        workspace.repoLocalPath,
        run.id,
      );
      run = touch(run, { status: 'implementing', error: null });
      try {
        sink.activity({
          phase: 'implementing',
          line: '👥 Assembling a team of agents to implement the plan…',
        });
        const team = await deps.team.implement({
          featureId: run.featureId,
          worktreePath,
          problem: run.problem,
          context: run.context,
          plan,
          signal,
          sink: {
            activity: (activity) => {
              sink.activity(activity);
              emit(run, activity.phase, activity.line, activity.agentId);
            },
            agent: (agent) => sink.agent?.(agent),
          },
        });
        // Keep the planner snapshot(s) from the planning pass so the summary can
        // still show planning time/credits alongside the implementation team.
        const planners = run.agents.filter((agent) => agent.role === 'planner');
        run = touch(run, { agents: [...planners, ...team.agents] });
        const committed = await deps.git.commitAll({
          worktreePath,
          message: deriveTitle(run.problem),
        });
        // A prior attempt may have committed (and even pushed) the branch before
        // failing at the pull-request step; on a re-run the worktree is clean, so
        // fall back to whatever the branch already changed against its base rather
        // than reporting "no changes".
        const shipped = committed.committed
          ? committed.files
          : await deps.git.changedFilesAgainst({
              worktreePath,
              baseBranch: workspace.baseBranch,
            });
        if (!committed.committed && shipped.length === 0) {
          throw new ValidationError(
            'The implementation made no file changes, so there is nothing to open a pull request for.',
          );
        }
        sink.activity({ phase: 'creating-pr', line: 'Pushing the branch…' });
        await deps.git.pushBranch({ worktreePath, branch });
        sink.activity({ phase: 'creating-pr', line: 'Opening the pull request…' });
        const pull = await deps.pr.create({
          repoId: workspace.repoId,
          worktreePath,
          branch,
          baseBranch: workspace.baseBranch,
          title: deriveTitle(run.problem),
          body: derivePrBody(run),
        });
        const reviewFeatureId = await deps.reviews.makeEligible({
          repoId: workspace.repoId,
          prNumber: pull.number,
          featureId: run.featureId,
        });
        run = touch(run, {
          status: 'pr-created',
          prNumber: pull.number,
          prUrl: pull.url,
          reviewFeatureId,
        });
        emit(run, 'done', `Opened pull request #${pull.number}.`);
        sink.activity({
          phase: 'done',
          line: `Opened pull request #${pull.number}.`,
        });
        sink.done(run, shipped);
      } catch (error) {
        if (signal?.aborted) {
          // The user cancelled: the cancel endpoint resets the run to a clean
          // draft, so don't clobber that with a failure state here.
          sink.failed('Implementation was cancelled.');
          return;
        }
        const message =
          error instanceof MetaAbortError
            ? 'The implementation was cancelled.'
            : errorMessage(error);
        touch(run, { status: 'failed', error: message });
        sink.failed(message);
      }
    },
  };
}
