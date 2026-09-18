/**
 * Application service backing the Bug Bash agent.
 *
 * The service is thin orchestration over injected ports: it persists the run,
 * drives the analyst that generates edge-case scenarios (grounded in the feature
 * description + the repository's code), and — once the user accepts them — runs
 * the tester team and compiles the report. Unlike New Task it never edits code
 * or opens a pull request; it only reads the repository. All I/O lives behind
 * ports so the 100% coverage gate can exercise every branch without a provider.
 */

import type { Clock } from '../kernel/clock.js';
import type { EventBus } from '../kernel/event-bus.js';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import { MetaAbortError, type MetaRunner } from '../meta/meta-runner.js';
import type { BugBashConfig } from './config.js';
import { parseScenarios } from './bug-bash-scenarios.js';
import {
  buildRefinePrompt,
  parseRefineResponse,
} from '../refine-chat/refine-chat.js';
import type { BugBashTeam } from './bug-bash-team.js';
import type { BugBashGenerateTeam } from './bug-bash-generate-team.js';
import type {
  BugBashEventMap,
  BugBashInputs,
  BugBashRun,
  BugBashRunRepo,
  BugBashRunSink,
  BugBashScenario,
  BugBashService,
  BugBashWorkspaceResolver,
} from './bug-bash-contract.js';

/**
 * The pristine per-scenario result fields, applied when a scenario is created
 * or its stale results are cleared so every scenario starts un-run with no
 * observations, actual output, blocked reason, tester, or diagnostics.
 */
const CLEARED_SCENARIO_RESULT = {
  status: 'pending',
  observations: '',
  ran: false,
  actualOutput: '',
  blockedReason: null,
  testerId: null,
  diagnostics: '',
} satisfies Pick<
  BugBashScenario,
  | 'status'
  | 'observations'
  | 'ran'
  | 'actualOutput'
  | 'blockedReason'
  | 'testerId'
  | 'diagnostics'
>;

/** Dependencies for {@link createBugBashService}. */
export interface BugBashServiceDeps {
  repo: BugBashRunRepo;
  workspace: BugBashWorkspaceResolver;
  config: BugBashConfig;
  clock: Clock;
  /** The reusable "run an AI prompt" primitive, used by the refine chat. */
  ai: Pick<MetaRunner, 'runDetailed'>;
  /** The lead-analyst-led team that generates scenarios in parallel. */
  generateTeam: BugBashGenerateTeam;
  /** The lead-led team that runs accepted scenarios in parallel. */
  team: BugBashTeam;
  /** Publishes live progress so the UI can stream it over the bus too. */
  bus: Pick<EventBus<BugBashEventMap>, 'emit'>;
}

/** Read the message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBugBashService(
  deps: BugBashServiceDeps,
): BugBashService {
  function touch(run: BugBashRun, patch: Partial<BugBashRun>): BugBashRun {
    const next: BugBashRun = {
      ...run,
      ...patch,
      updatedAt: deps.clock.isoNow(),
    };
    deps.repo.update(next);
    return next;
  }

  function emit(
    run: BugBashRun,
    phase: BugBashEventMap['bug-bash.activity']['phase'],
    line: string,
    agentId?: string,
  ): void {
    deps.bus.emit('bug-bash.activity', { runId: run.id, phase, line, agentId });
  }

  function requireRun(attachmentId: string): BugBashRun {
    const run = deps.repo.get(attachmentId);
    if (!run) {
      throw new NotFoundError(`No Bug Bash run for attachment: ${attachmentId}`);
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
      // Keep any generated scenarios so a cancelled run can re-run without
      // regenerating, but clear their stale results and the report/error.
      const scenarios: BugBashScenario[] = run.scenarios.map((scenario) => ({
        ...scenario,
        ...CLEARED_SCENARIO_RESULT,
      }));
      return touch(run, {
        status: scenarios.length > 0 ? 'generated' : 'draft',
        scenarios,
        report: null,
        error: null,
        agents: [],
      });
    },

    saveInputs(attachmentId, featureId, inputs: BugBashInputs) {
      const featureInfo = inputs.featureInfo.trim();
      if (featureInfo.length === 0) {
        throw new ValidationError('Feature information is required.');
      }
      const setupInfo = inputs.setupInfo.trim();
      const now = deps.clock.isoNow();
      const existing = deps.repo.get(attachmentId);
      if (existing) {
        // Re-editing discards prior scenarios/report and returns to a draft.
        return touch(existing, {
          featureId,
          featureInfo,
          setupInfo,
          scenarios: [],
          report: null,
          status: 'draft',
          error: null,
          agents: [],
        });
      }
      const run: BugBashRun = {
        id: attachmentId,
        featureId,
        featureInfo,
        setupInfo,
        scenarios: [],
        report: null,
        status: 'draft',
        error: null,
        agents: [],
        createdAt: now,
        updatedAt: now,
      };
      deps.repo.create(run);
      return run;
    },

    async generate(attachmentId, signal, sink) {
      let run = requireRun(attachmentId);
      const workspace = deps.workspace.resolve(run.featureId);
      run = touch(run, { status: 'generating', error: null });
      try {
        sink?.activity({
          phase: 'generating',
          line: '🔎 Assembling an analyst team to design edge-case scenarios…',
        });
        const team = await deps.generateTeam.generate({
          featureId: run.featureId,
          cwd: workspace.repoLocalPath,
          featureInfo: run.featureInfo,
          setupInfo: run.setupInfo,
          signal,
          sink: {
            activity: (activity) => {
              sink?.activity(activity);
              emit(run, activity.phase, activity.line, activity.agentId);
            },
            agent: (agent) => sink?.agent?.(agent),
          },
        });
        const scenarios: BugBashScenario[] = team.scenarios.map(
          (parsed, index) => ({
            id: `scenario-${index + 1}`,
            title: parsed.title,
            input: parsed.input,
            steps: parsed.steps,
            expectedOutput: parsed.expectedOutput,
            confirmation: parsed.confirmation,
            ...CLEARED_SCENARIO_RESULT,
          }),
        );
        sink?.activity({
          phase: 'generating',
          line: `🧪 Generated ${scenarios.length} scenario${
            scenarios.length === 1 ? '' : 's'
          }.`,
        });
        const generated = touch(run, {
          scenarios,
          status: 'generated',
          agents: team.agents,
        });
        sink?.done(generated);
        return generated;
      } catch (error) {
        if (signal?.aborted) {
          sink?.failed('Scenario generation was cancelled.');
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

    async refine(attachmentId, history, message, signal) {
      const run = requireRun(attachmentId);
      const text = message.trim();
      if (text.length === 0) {
        throw new ValidationError('A message is required.');
      }
      const workspace = deps.workspace.resolve(run.featureId);
      const artifact = JSON.stringify(
        {
          scenarios: run.scenarios.map((scenario) => ({
            title: scenario.title,
            input: scenario.input,
            steps: scenario.steps,
            expectedOutput: scenario.expectedOutput,
            confirmation: scenario.confirmation,
          })),
        },
        null,
        2,
      );
      const prompt = buildRefinePrompt(deps.config.refinePromptTemplate, {
        artifactLabel: 'bug bash test scenarios',
        featureContext: `Feature information:\n${run.featureInfo}\n\nSetup information:\n${run.setupInfo}`,
        artifact,
        revisedHint:
          'When you change the scenarios, set "revised" to an object shaped ' +
          '{"scenarios":[{"title":"","input":"","steps":["",""],' +
          '"expectedOutput":"","confirmation":""}]} containing the COMPLETE new ' +
          'list of scenarios (not a diff). Otherwise set "revised" to null.',
        messages: history,
        message: text,
      });
      const result = await deps.ai.runDetailed({
        featureId: run.featureId,
        prompt,
        cwd: workspace.repoLocalPath,
        scope: 'internal',
        model: 'auto',
        label: 'Bug bash · Refine',
        timeoutMs: deps.config.generateTimeoutMs,
        signal,
      });
      const parsed = parseRefineResponse(result.text);
      let next = run;
      if (parsed.revised && typeof parsed.revised === 'object') {
        const revised = parseScenarios(JSON.stringify(parsed.revised));
        if (revised.length > 0) {
          const scenarios: BugBashScenario[] = revised.map((scenario, index) => ({
            id: `scenario-${index + 1}`,
            title: scenario.title,
            input: scenario.input,
            steps: scenario.steps,
            expectedOutput: scenario.expectedOutput,
            confirmation: scenario.confirmation,
            ...CLEARED_SCENARIO_RESULT,
          }));
          next = touch(run, { scenarios, status: 'generated', report: null });
        }
      }
      return { reply: parsed.reply, run: next };
    },

    async run(attachmentId, sink: BugBashRunSink, signal) {
      let run = requireRun(attachmentId);
      if (
        (run.status !== 'generated' &&
          run.status !== 'running' &&
          run.status !== 'reported' &&
          run.status !== 'failed') ||
        run.scenarios.length === 0
      ) {
        sink.failed('Generate and accept scenarios before running the bug bash.');
        return;
      }
      const workspace = deps.workspace.resolve(run.featureId);
      run = touch(run, { status: 'running', error: null });
      try {
        sink.activity({
          phase: 'running',
          line: '👥 Assembling a team of testers to run the scenarios…',
        });
        const team = await deps.team.run({
          featureId: run.featureId,
          cwd: workspace.repoLocalPath,
          featureInfo: run.featureInfo,
          setupInfo: run.setupInfo,
          scenarios: run.scenarios,
          signal,
          sink: {
            activity: (activity) => {
              sink.activity(activity);
              emit(run, activity.phase, activity.line, activity.agentId);
            },
            agent: (agent) => sink.agent?.(agent),
          },
        });
        // Keep the analyst snapshot(s) from generation so the summary can still
        // show generation time/credits alongside the tester team.
        const analysts = run.agents.filter((agent) => agent.role === 'analyst');
        run = touch(run, {
          scenarios: team.scenarios,
          report: team.report,
          agents: [...analysts, ...team.agents],
          status: 'reported',
        });
        emit(run, 'done', 'Bug bash complete.');
        sink.activity({ phase: 'done', line: 'Bug bash complete.' });
        sink.done(run);
      } catch (error) {
        if (signal?.aborted) {
          sink.failed('The bug bash was cancelled.');
          return;
        }
        const message =
          error instanceof MetaAbortError
            ? 'The bug bash was cancelled.'
            : errorMessage(error);
        touch(run, { status: 'failed', error: message });
        sink.failed(message);
      }
    },
  };
}
