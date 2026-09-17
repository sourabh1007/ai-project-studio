/**
 * The Bug Bash tester "team".
 *
 * Running every accepted scenario serially is slow. This module runs a run as a
 * small team instead: a *lead agent* splits the accepted scenarios into disjoint
 * groups, one *tester sub-agent* per group executes its scenarios in parallel
 * (each leasing its own metasession, so several run at once), and the lead then
 * reviews the collected results and compiles the final markdown report. Every
 * agent reports live activity and metrics (time, tokens, AI credits) so the UI
 * can show the hierarchy and per-agent cost.
 *
 * Everything is port-driven and pure aside from the injected AI/clock, so the
 * 100% coverage gate can exercise every branch (empty groups, tester failure,
 * empty report fallback, abort) without a provider.
 */

import type { Clock } from '../kernel/clock.js';
import type { MetaRunResult, MetaRunner } from '../meta/meta-runner.js';
import type { BugBashConfig } from './config.js';
import {
  buildReportPrompt,
  buildTesterPrompt,
  summarizeResults,
} from './bug-bash-prompt.js';
import { parseResults } from './bug-bash-scenarios.js';
import type {
  BugBashActivity,
  BugBashAgent,
  BugBashScenario,
} from './bug-bash-contract.js';

/** The id the lead agent always uses. */
export const LEAD_AGENT_ID = 'lead';

/** Sink the team streams its per-agent activity and metrics to. */
export interface BugBashTeamSink {
  activity(activity: Omit<BugBashActivity, 'runId'>): void;
  agent(agent: BugBashAgent): void;
}

/** Inputs for one tester-team run. */
export interface BugBashTeamRequest {
  featureId: string;
  cwd: string;
  featureInfo: string;
  setupInfo: string;
  scenarios: BugBashScenario[];
  sink: BugBashTeamSink;
  signal?: AbortSignal;
}

/** The settled team, with per-scenario results and the compiled report. */
export interface BugBashTeamResult {
  agents: BugBashAgent[];
  scenarios: BugBashScenario[];
  report: string;
}

/** Dependencies for {@link createBugBashTeam}. */
export interface BugBashTeamDeps {
  ai: Pick<MetaRunner, 'runDetailed'>;
  clock: Clock;
  config: BugBashConfig;
}

/** Runs accepted scenarios as a lead-led team of parallel testers. */
export interface BugBashTeam {
  run(request: BugBashTeamRequest): Promise<BugBashTeamResult>;
}

/**
 * Split scenarios into up to `maxTesters` disjoint groups, round-robin so the
 * counts stay balanced. Returns one group per tester; empty input yields no
 * groups.
 */
export function splitScenarios(
  scenarios: BugBashScenario[],
  maxTesters: number,
): BugBashScenario[][] {
  const groupCount = Math.min(Math.max(maxTesters, 1), scenarios.length);
  if (groupCount === 0) {
    return [];
  }
  const groups: BugBashScenario[][] = Array.from(
    { length: groupCount },
    () => [],
  );
  scenarios.forEach((scenario, index) => {
    groups[index % groupCount].push(scenario);
  });
  return groups;
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

export function createBugBashTeam(deps: BugBashTeamDeps): BugBashTeam {
  const nowMs = (): number => deps.clock.now().getTime();

  return {
    async run(request): Promise<BugBashTeamResult> {
      const { sink, signal } = request;

      // The lead is the root agent; its metrics come from the report turn.
      const lead: BugBashAgent = {
        id: LEAD_AGENT_ID,
        parentId: null,
        role: 'lead',
        title: 'Lead agent',
        scenarioIds: [],
        status: 'running',
        startedAt: nowMs(),
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        credits: null,
      };
      const emitLead = (): void => sink.agent({ ...lead });
      emitLead();

      const leadActivity = (line: string): void =>
        sink.activity({ phase: 'running', line, agentId: LEAD_AGENT_ID });

      const groups = splitScenarios(request.scenarios, deps.config.maxTesters);
      leadActivity(
        `👥 Assigning ${request.scenarios.length} scenario${
          request.scenarios.length === 1 ? '' : 's'
        } across ${groups.length} tester${groups.length === 1 ? '' : 's'}…`,
      );

      // Build the tester sub-agents and run them in parallel.
      const testers: BugBashAgent[] = groups.map((group, index) => ({
        id: `tester-${index + 1}`,
        parentId: LEAD_AGENT_ID,
        role: 'tester',
        title: `Tester ${index + 1}`,
        scenarioIds: group.map((scenario) => scenario.id),
        status: 'pending',
        startedAt: null,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        credits: null,
      }));
      for (const tester of testers) {
        sink.agent({ ...tester });
      }

      const resultById = new Map<
        string,
        { status: BugBashScenario['status']; observations: string }
      >();

      await Promise.all(
        testers.map(async (tester, index) => {
          const group = groups[index];
          tester.status = 'running';
          tester.startedAt = nowMs();
          sink.agent({ ...tester });
          const started = tester.startedAt;
          try {
            const result = await deps.ai.runDetailed({
              featureId: request.featureId,
              prompt: buildTesterPrompt(deps.config.testerPromptTemplate, {
                featureInfo: request.featureInfo,
                setupInfo: request.setupInfo,
                scenarios: group,
              }),
              cwd: request.cwd,
              scope: 'internal',
              model: 'auto',
              label: `Bug bash · ${tester.title}`,
              timeoutMs: deps.config.runTimeoutMs,
              signal,
              onActivity: (line) =>
                sink.activity({ phase: 'running', line, agentId: tester.id }),
            });
            for (const parsed of parseResults(result.text)) {
              resultById.set(parsed.id, {
                status: parsed.status,
                observations: parsed.observations,
              });
            }
            const metrics = agentMetricsOf(result);
            tester.status = 'done';
            tester.durationMs = nowMs() - started;
            tester.inputTokens = metrics.inputTokens;
            tester.outputTokens = metrics.outputTokens;
            tester.credits = metrics.credits;
            sink.agent({ ...tester });
          } catch (error) {
            tester.status = 'failed';
            tester.durationMs = nowMs() - started;
            sink.agent({ ...tester });
            throw error;
          }
        }),
      );

      // Merge each tester's findings back onto the scenarios; a scenario no
      // tester reported on is left blocked.
      const scenarios: BugBashScenario[] = request.scenarios.map((scenario) => {
        const found = resultById.get(scenario.id);
        return {
          ...scenario,
          status: found?.status ?? 'blocked',
          observations: found
            ? found.observations
            : 'No tester reported a result for this scenario.',
        };
      });

      // The lead reviews the collected results and compiles the report.
      leadActivity('📋 Reviewing the results and compiling the report…');
      const reportStart = nowMs();
      const review = await deps.ai.runDetailed({
        featureId: request.featureId,
        prompt: buildReportPrompt(deps.config.reportPromptTemplate, {
          featureInfo: request.featureInfo,
          scenarios,
        }),
        cwd: request.cwd,
        scope: 'internal',
        model: 'auto',
        label: 'Bug bash · lead report',
        timeoutMs: deps.config.runTimeoutMs,
        signal,
        onActivity: leadActivity,
      });
      const metrics = agentMetricsOf(review);
      lead.inputTokens = metrics.inputTokens;
      lead.outputTokens = metrics.outputTokens;
      lead.credits = metrics.credits;
      lead.durationMs = nowMs() - reportStart;
      lead.status = 'done';
      emitLead();

      const report = review.text.trim() || summarizeResults(scenarios);
      return { agents: [lead, ...testers], scenarios, report };
    },
  };
}
