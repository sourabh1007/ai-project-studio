/**
 * The Bug Bash scenario-generation "team".
 *
 * Having a single analyst mine an entire feature for edge cases is slow and
 * loses depth on large surfaces. This module generates scenarios as a small
 * team instead: a *lead analyst* first decomposes the feature into disjoint
 * focus areas, then one *analyst sub-agent* per area (each leasing its own
 * metasession, so several run at once) designs scenarios scoped to its area in
 * parallel, and the results are merged and de-duplicated. Every agent reports
 * live activity and metrics (time, tokens, AI credits) so the UI can show the
 * hierarchy and per-agent cost, mirroring the tester team.
 *
 * Everything is port-driven and pure aside from the injected AI/clock, so the
 * 100% coverage gate can exercise every branch (empty decomposition fallback,
 * analyst failure, de-duplication, abort) without a provider.
 */

import type { Clock } from '../kernel/clock.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { BugBashConfig } from './config.js';
import {
  buildDecomposePrompt,
  buildGeneratePrompt,
  WHOLE_FEATURE_FOCUS,
} from './bug-bash-prompt.js';
import { parseAreas, parseScenarios } from './bug-bash-scenarios.js';
import type { ParsedArea, ParsedScenario } from './bug-bash-scenarios.js';
import { agentMetricsOf, type BugBashTeamSink } from './bug-bash-team.js';
import type { BugBashAgent } from './bug-bash-contract.js';

/** The id the lead analyst always uses (root of the generation team). */
export const ANALYST_LEAD_AGENT_ID = 'analyst-lead';

/** Inputs for one generation-team pass. */
export interface BugBashGenerateRequest {
  featureId: string;
  cwd: string;
  featureInfo: string;
  setupInfo: string;
  sink: BugBashTeamSink;
  signal?: AbortSignal;
}

/** The settled generation team, with merged scenarios and per-agent metrics. */
export interface BugBashGenerateResult {
  agents: BugBashAgent[];
  scenarios: ParsedScenario[];
}

/** Dependencies for {@link createBugBashGenerateTeam}. */
export interface BugBashGenerateTeamDeps {
  ai: Pick<MetaRunner, 'runDetailed'>;
  clock: Clock;
  config: BugBashConfig;
}

/** Generates scenarios as a lead-analyst-led team of parallel analysts. */
export interface BugBashGenerateTeam {
  generate(request: BugBashGenerateRequest): Promise<BugBashGenerateResult>;
}

/**
 * Split focus areas into up to `maxAnalysts` disjoint groups, round-robin so
 * the counts stay balanced. Returns one group per analyst; empty input yields
 * no groups.
 */
export function splitAreas(
  areas: ParsedArea[],
  maxAnalysts: number,
): ParsedArea[][] {
  const groupCount = Math.min(Math.max(maxAnalysts, 1), areas.length);
  if (groupCount === 0) {
    return [];
  }
  const groups: ParsedArea[][] = Array.from({ length: groupCount }, () => []);
  areas.forEach((area, index) => {
    groups[index % groupCount].push(area);
  });
  return groups;
}

/** Render a group of areas into a single focus string for one analyst. */
function focusOf(areas: ParsedArea[]): string {
  return areas
    .map((area) => `${area.title}: ${area.focus}`)
    .join('\n')
    .trim();
}

/** Case-insensitive title used to de-duplicate scenarios across analysts. */
function dedupeKey(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Render the "prompt sent" activity as one multi-line entry so the live log
 * opens with what the agent was asked before its streamed events arrive.
 */
function promptActivity(prompt: string): string {
  return `📝 Prompt sent to the agent:\n${prompt.trim()}`;
}

export function createBugBashGenerateTeam(
  deps: BugBashGenerateTeamDeps,
): BugBashGenerateTeam {
  const nowMs = (): number => deps.clock.now().getTime();

  return {
    async generate(request): Promise<BugBashGenerateResult> {
      const { sink, signal } = request;

      // The lead analyst is the root agent; its metrics come from the
      // decomposition turn.
      const leadStart = nowMs();
      const lead: BugBashAgent = {
        id: ANALYST_LEAD_AGENT_ID,
        parentId: null,
        role: 'analyst',
        title: 'Lead analyst',
        scenarioIds: [],
        status: 'running',
        startedAt: leadStart,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        credits: null,
      };
      const emitLead = (): void => sink.agent({ ...lead });
      emitLead();

      const leadActivity = (line: string): void =>
        sink.activity({
          phase: 'generating',
          line,
          agentId: ANALYST_LEAD_AGENT_ID,
        });

      leadActivity(
        '🧭 Decomposing the feature into focus areas for the analyst team…',
      );
      const decomposePrompt = buildDecomposePrompt(
        deps.config.decomposePromptTemplate,
        {
          featureInfo: request.featureInfo,
          setupInfo: request.setupInfo,
          maxAreas: deps.config.maxAnalysts,
        },
      );
      leadActivity(promptActivity(decomposePrompt));
      const decomposition = await deps.ai.runDetailed({
        featureId: request.featureId,
        prompt: decomposePrompt,
        cwd: request.cwd,
        scope: 'internal',
        model: 'auto',
        label: 'Bug bash · Lead analyst',
        timeoutMs: deps.config.generateTimeoutMs,
        signal,
        onActivity: leadActivity,
      });
      const leadMetrics = agentMetricsOf(decomposition);
      lead.inputTokens = leadMetrics.inputTokens;
      lead.outputTokens = leadMetrics.outputTokens;
      lead.credits = leadMetrics.credits;

      // Fall back to a single whole-feature analyst when the lead did not
      // return any usable areas, so generation always proceeds.
      const parsedAreas = parseAreas(decomposition.text);
      const areas: ParsedArea[] =
        parsedAreas.length > 0
          ? parsedAreas
          : [{ title: 'Whole feature', focus: WHOLE_FEATURE_FOCUS }];
      const groups = splitAreas(areas, deps.config.maxAnalysts);
      leadActivity(
        `🧑‍🔬 Assigning ${areas.length} focus area${
          areas.length === 1 ? '' : 's'
        } across ${groups.length} analyst${groups.length === 1 ? '' : 's'}…`,
      );

      const analysts: BugBashAgent[] = groups.map((_group, index) => ({
        id: `analyst-${index + 1}`,
        parentId: ANALYST_LEAD_AGENT_ID,
        role: 'analyst',
        title: groups.length === 1 ? 'Analyst' : `Analyst ${index + 1}`,
        scenarioIds: [],
        status: 'pending',
        startedAt: null,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        credits: null,
      }));
      for (const analyst of analysts) {
        sink.agent({ ...analyst });
      }

      const collected: ParsedScenario[][] = await Promise.all(
        analysts.map(async (analyst, index) => {
          const group = groups[index];
          analyst.status = 'running';
          analyst.startedAt = nowMs();
          sink.agent({ ...analyst });
          const started = analyst.startedAt;
          const prompt = buildGeneratePrompt(deps.config.generatePromptTemplate, {
            featureInfo: request.featureInfo,
            setupInfo: request.setupInfo,
            focus: focusOf(group),
          });
          sink.activity({
            phase: 'generating',
            line: promptActivity(prompt),
            agentId: analyst.id,
          });
          try {
            const result = await deps.ai.runDetailed({
              featureId: request.featureId,
              prompt,
              cwd: request.cwd,
              scope: 'internal',
              model: 'auto',
              label: `Bug bash · ${analyst.title}`,
              timeoutMs: deps.config.generateTimeoutMs,
              signal,
              onActivity: (line) =>
                sink.activity({
                  phase: 'generating',
                  line,
                  agentId: analyst.id,
                }),
            });
            const scenarios = parseScenarios(result.text);
            const metrics = agentMetricsOf(result);
            analyst.status = 'done';
            analyst.durationMs = nowMs() - started;
            analyst.inputTokens = metrics.inputTokens;
            analyst.outputTokens = metrics.outputTokens;
            analyst.credits = metrics.credits;
            sink.agent({ ...analyst });
            return scenarios;
          } catch (error) {
            analyst.status = 'failed';
            analyst.durationMs = nowMs() - started;
            sink.agent({ ...analyst });
            throw error;
          }
        }),
      );

      // Merge every analyst's scenarios, de-duplicating by title so two analysts
      // proposing the same case do not double-count.
      const seen = new Set<string>();
      const scenarios: ParsedScenario[] = [];
      for (const list of collected) {
        for (const scenario of list) {
          const key = dedupeKey(scenario.title);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          scenarios.push(scenario);
        }
      }

      lead.durationMs = nowMs() - leadStart;
      lead.status = 'done';
      emitLead();

      return { agents: [lead, ...analysts], scenarios };
    },
  };
}
