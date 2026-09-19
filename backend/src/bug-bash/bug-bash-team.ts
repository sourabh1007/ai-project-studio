/**
 * The Bug Bash tester "team".
 *
 * Running every accepted scenario serially is slow. This module runs a run as a
 * scalable team instead: a *lead agent* splits the accepted scenarios into
 * disjoint groups, one *tester sub-agent* per group runs its scenarios one by
 * one while testers run in parallel with each other (each leasing its own
 * metasession, so several run at once), and the lead then reviews the collected
 * results and compiles the final markdown report. Every agent reports live
 * activity and metrics (time, tokens, AI credits) so the UI can show the
 * hierarchy and per-agent cost.
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
import { auditScenarioEvidence, parseResults } from './bug-bash-scenarios.js';
import type {
  BugBashActivity,
  BugBashAgent,
  BugBashScenario,
  BugBashScenarioProgress,
} from './bug-bash-contract.js';

/** The id the lead agent always uses. */
export const LEAD_AGENT_ID = 'lead';

/** The id the evidence auditor always uses. */
export const AUDITOR_AGENT_ID = 'auditor';

/** Target batch size for scaling tester sub-agents to the workload. */
export const SCENARIOS_PER_TESTER = 4;

/** Sink the team streams its per-agent activity and metrics to. */
export interface BugBashTeamSink {
  activity(activity: Omit<BugBashActivity, 'runId'>): void;
  agent(agent: BugBashAgent): void;
  scenario(progress: BugBashScenarioProgress): void;
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
 * Choose a tester count that scales with scenario volume without exceeding the
 * configured cap.
 */
export function chooseTesterCount(
  scenarioCount: number,
  maxTesters: number,
  perTester: number = SCENARIOS_PER_TESTER,
): number {
  if (scenarioCount <= 0) {
    return 0;
  }
  const safeMax = Math.max(maxTesters, 1);
  const safePerTester = Math.max(perTester, 1);
  return Math.min(Math.ceil(scenarioCount / safePerTester), safeMax);
}

/**
 * Split scenarios into scaled, disjoint groups, round-robin so the counts stay
 * balanced. Returns one group per tester; empty input yields no groups.
 */
export function splitScenarios(
  scenarios: BugBashScenario[],
  maxTesters: number,
  perTester: number = SCENARIOS_PER_TESTER,
): BugBashScenario[][] {
  const groupCount = chooseTesterCount(scenarios.length, maxTesters, perTester);
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

function addKnown(
  current: number | null,
  next: number | null,
): number | null {
  if (next == null) {
    return current;
  }
  return (current ?? 0) + next;
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
        {
          status: BugBashScenario['status'];
          observations: string;
          ran: boolean;
          actualOutput: string;
          blockedReason: BugBashScenario['blockedReason'];
          diagnostics: string;
          reproScript: string;
          testerId: string;
        }
      >();
      // Which tester a scenario was assigned to, so an unreported scenario can
      // still record who should have run it.
      const assignedTesterById = new Map<string, string>();
      testers.forEach((tester) => {
        for (const scenarioId of tester.scenarioIds) {
          assignedTesterById.set(scenarioId, tester.id);
        }
      });

      await Promise.all(
        testers.map(async (tester, index) => {
          const group = groups[index];
          tester.status = 'running';
          tester.startedAt = nowMs();
          sink.agent({ ...tester });
          const started = tester.startedAt;
          try {
            for (const scenario of group) {
              sink.scenario({ id: scenario.id, status: 'running' });
              const result = await deps.ai.runDetailed({
                featureId: request.featureId,
                prompt: buildTesterPrompt(deps.config.testerPromptTemplate, {
                  featureInfo: request.featureInfo,
                  setupInfo: request.setupInfo,
                  scenarios: [scenario],
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
              const parsed = parseResults(result.text);
              const found =
                parsed.find((entry) => entry.id === scenario.id) ?? parsed[0];
              const terminal = found?.status ?? 'blocked';
              if (found) {
                resultById.set(scenario.id, {
                  status: found.status,
                  observations: found.observations,
                  ran: found.ran,
                  actualOutput: found.actualOutput,
                  blockedReason: found.blockedReason,
                  diagnostics: found.diagnostics,
                  reproScript: found.reproScript,
                  testerId: tester.id,
                });
              }
              sink.scenario({ id: scenario.id, status: terminal });
              const metrics = agentMetricsOf(result);
              tester.inputTokens = addKnown(tester.inputTokens, metrics.inputTokens);
              tester.outputTokens = addKnown(
                tester.outputTokens,
                metrics.outputTokens,
              );
              tester.credits = addKnown(tester.credits, metrics.credits);
              tester.durationMs = nowMs() - started;
              sink.agent({ ...tester });
            }
            tester.status = 'done';
            tester.durationMs = nowMs() - started;
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
      const merged: BugBashScenario[] = request.scenarios.map((scenario) => {
        const found = resultById.get(scenario.id);
        if (found) {
          return {
            ...scenario,
            status: found.status,
            observations: found.observations,
            ran: found.ran,
            actualOutput: found.actualOutput,
            blockedReason: found.blockedReason,
            testerId: found.testerId,
            diagnostics: found.diagnostics,
            reproScript: found.reproScript,
            evidenceGaps: [],
          };
        }
        return {
          ...scenario,
          status: 'blocked',
          observations: 'No tester reported a result for this scenario.',
          ran: false,
          actualOutput: '',
          blockedReason: 'other',
          // Every scenario is assigned to exactly one tester, so this lookup
          // always resolves — attribute the blocked result to that tester.
          testerId: assignedTesterById.get(scenario.id)!,
          diagnostics: '',
          reproScript: '',
          evidenceGaps: [],
        };
      });

      // The evidence auditor (a developer/tech-PM role) deterministically checks
      // that every pass/fail verdict is backed by the artefacts a developer
      // needs to trust and replay it — actual output, diagnostics/logs, and a
      // repro script — and stamps the gaps onto each scenario so a green result
      // cannot hide missing proof. This runs no AI turn, so it reports zero cost.
      const auditStartedAt = nowMs();
      const auditor: BugBashAgent = {
        id: AUDITOR_AGENT_ID,
        parentId: LEAD_AGENT_ID,
        role: 'auditor',
        title: 'Evidence auditor',
        scenarioIds: merged.map((scenario) => scenario.id),
        status: 'running',
        startedAt: auditStartedAt,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        credits: null,
      };
      sink.agent({ ...auditor });
      const auditActivity = (line: string): void =>
        sink.activity({ phase: 'running', line, agentId: AUDITOR_AGENT_ID });
      auditActivity(
        `🔍 Auditing evidence for ${merged.length} scenario` +
          `${merged.length === 1 ? '' : 's'} — checking actual output, ` +
          'diagnostics/logs, and a repro script back every verdict…',
      );
      const scenarios: BugBashScenario[] = merged.map((scenario) => ({
        ...scenario,
        evidenceGaps: auditScenarioEvidence(scenario),
      }));
      const flagged = scenarios.filter((s) => s.evidenceGaps.length > 0);
      for (const scenario of flagged) {
        auditActivity(
          `⚠️ ${scenario.id} “${scenario.title}” marked ${scenario.status} ` +
            `but missing ${scenario.evidenceGaps.join(', ')}.`,
        );
      }
      auditActivity(
        flagged.length === 0
          ? '✅ Every pass/fail verdict is backed by output, logs, and a repro script.'
          : `⚠️ ${flagged.length} of ${scenarios.length} verdict` +
              `${scenarios.length === 1 ? '' : 's'} are missing evidence.`,
      );
      auditor.status = 'done';
      auditor.durationMs = nowMs() - auditStartedAt;
      auditor.inputTokens = 0;
      auditor.outputTokens = 0;
      auditor.credits = 0;
      sink.agent({ ...auditor });

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
      return { agents: [lead, ...testers, auditor], scenarios, report };
    },
  };
}
