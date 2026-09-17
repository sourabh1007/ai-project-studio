import { describe, it, expect } from 'vitest';
import type { Clock } from '../kernel/clock.js';
import type { MetaRequest, MetaRunResult } from '../meta/meta-runner.js';
import { bugBashDefaults } from './config.js';
import type { BugBashAgent, BugBashScenario } from './bug-bash-contract.js';
import {
  agentMetricsOf,
  createBugBashTeam,
  LEAD_AGENT_ID,
  splitScenarios,
  type BugBashTeamSink,
} from './bug-bash-team.js';

function fence(json: string): string {
  return ['```json', json, '```'].join('\n');
}

function stepClock(): Clock {
  let ms = 1_000;
  return {
    now: () => new Date((ms += 10)),
    isoNow: () => new Date(ms).toISOString(),
  };
}

function scenario(overrides: Partial<BugBashScenario> = {}): BugBashScenario {
  return {
    id: 'scenario-1',
    title: 'A',
    input: '',
    steps: [],
    expectedOutput: '',
    confirmation: '',
    status: 'pending',
    observations: '',
    ...overrides,
  };
}

interface Recorded {
  agents: BugBashAgent[];
  activities: Array<{ line: string; agentId?: string }>;
}

function recordingSink(): BugBashTeamSink & Recorded {
  const agents: BugBashAgent[] = [];
  const activities: Array<{ line: string; agentId?: string }> = [];
  return {
    agents,
    activities,
    agent(agent) {
      agents.push({ ...agent });
    },
    activity(activity) {
      activities.push({ line: activity.line, agentId: activity.agentId });
    },
  };
}

function makeTeam(handlers: {
  tester?: (req: MetaRequest) => Promise<MetaRunResult> | MetaRunResult;
  report?: () => Promise<MetaRunResult> | MetaRunResult;
  maxTesters?: number;
}) {
  const calls: string[] = [];
  const team = createBugBashTeam({
    clock: stepClock(),
    config: { ...bugBashDefaults, maxTesters: handlers.maxTesters ?? 4 },
    ai: {
      runDetailed: async (req: MetaRequest): Promise<MetaRunResult> => {
        req.onActivity?.(`activity for ${req.label}`);
        calls.push(req.label ?? '');
        const label = req.label ?? '';
        if (label.includes('lead report')) {
          return (handlers.report ?? (() => ({ text: '', sessionId: 'r' })))();
        }
        return (handlers.tester ?? (() => ({ text: '', sessionId: 'w' })))(req);
      },
    },
  });
  return { team, calls };
}

describe('splitScenarios', () => {
  it('returns no groups for an empty input', () => {
    expect(splitScenarios([], 4)).toEqual([]);
  });

  it('round-robins scenarios across up to maxTesters groups', () => {
    const scenarios = [
      scenario({ id: 's1' }),
      scenario({ id: 's2' }),
      scenario({ id: 's3' }),
    ];
    const groups = splitScenarios(scenarios, 2);
    expect(groups.map((g) => g.map((s) => s.id))).toEqual([['s1', 's3'], ['s2']]);
  });

  it('never makes more groups than scenarios', () => {
    expect(splitScenarios([scenario({ id: 's1' })], 4)).toHaveLength(1);
  });
});

describe('agentMetricsOf', () => {
  it('prefers the provider credits', () => {
    expect(
      agentMetricsOf({
        text: '',
        sessionId: 's',
        usage: { inputTokens: 1, outputTokens: 2, nanoAiu: 5e9, credits: 3 },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, credits: 3 });
  });

  it('derives credits from nano-AIU when credits are absent', () => {
    expect(
      agentMetricsOf({
        text: '',
        sessionId: 's',
        usage: { inputTokens: 1, outputTokens: 2, nanoAiu: 5e9, credits: null },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, credits: 5 });
  });

  it('yields nulls when there is no usage', () => {
    expect(agentMetricsOf({ text: '', sessionId: 's' })).toEqual({
      inputTokens: null,
      outputTokens: null,
      credits: null,
    });
  });
});

const SCENARIOS = [
  scenario({ id: 'scenario-1', title: 'A' }),
  scenario({ id: 'scenario-2', title: 'B' }),
  scenario({ id: 'scenario-3', title: 'C' }),
];

function request(sink: BugBashTeamSink) {
  return {
    featureId: 'f1',
    cwd: '/repo',
    featureInfo: 'a feature',
    setupInfo: 'setup',
    scenarios: SCENARIOS,
    sink,
  };
}

describe('bug-bash team', () => {
  it('runs testers in parallel, merges results, and uses the lead report', async () => {
    const { team, calls } = makeTeam({
      maxTesters: 2,
      tester: (req) => {
        if ((req.label ?? '').includes('Tester 1')) {
          return {
            text: fence(
              JSON.stringify({
                results: [
                  { id: 'scenario-1', status: 'pass', observations: 'ok' },
                  { id: 'scenario-3', status: 'fail', observations: 'bug' },
                ],
              }),
            ),
            sessionId: 't1',
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              nanoAiu: null,
              credits: 1,
            },
          };
        }
        return {
          text: fence(
            JSON.stringify({
              results: [
                { id: 'scenario-2', status: 'pass', observations: 'fine' },
              ],
            }),
          ),
          sessionId: 't2',
        };
      },
      report: () => ({ text: '## Summary\nAll ran.', sessionId: 'r' }),
    });
    const sink = recordingSink();
    const result = await team.run(request(sink));

    expect(calls).toEqual([
      'Bug bash · Tester 1',
      'Bug bash · Tester 2',
      'Bug bash · lead report',
    ]);
    expect(result.report).toBe('## Summary\nAll ran.');
    expect(result.scenarios.map((s) => [s.id, s.status, s.observations])).toEqual([
      ['scenario-1', 'pass', 'ok'],
      ['scenario-2', 'pass', 'fine'],
      ['scenario-3', 'fail', 'bug'],
    ]);

    const lead = result.agents.find((a) => a.id === LEAD_AGENT_ID)!;
    expect(lead.role).toBe('lead');
    expect(lead.status).toBe('done');
    const testers = result.agents.filter((a) => a.role === 'tester');
    expect(testers.map((t) => t.id)).toEqual(['tester-1', 'tester-2']);
    expect(testers[0].scenarioIds).toEqual(['scenario-1', 'scenario-3']);
    expect(testers[0].credits).toBe(1);
    expect(testers[0].status).toBe('done');
    // Every tester + lead activity carries its agent id.
    expect(sink.activities.some((a) => a.agentId === 'tester-1')).toBe(true);
    expect(sink.activities.some((a) => a.agentId === LEAD_AGENT_ID)).toBe(true);
  });

  it('blocks scenarios no tester reported and falls back to a compiled report', async () => {
    const { team } = makeTeam({
      maxTesters: 1,
      tester: () => ({
        text: fence(
          JSON.stringify({
            results: [
              { id: 'scenario-1', status: 'pass', observations: '' },
            ],
          }),
        ),
        sessionId: 't1',
      }),
      report: () => ({ text: '   ', sessionId: 'r' }),
    });
    const sink = recordingSink();
    const result = await team.run(request(sink));

    const byId = new Map(result.scenarios.map((s) => [s.id, s]));
    expect(byId.get('scenario-1')!.status).toBe('pass');
    expect(byId.get('scenario-1')!.observations).toBe('');
    expect(byId.get('scenario-2')!.status).toBe('blocked');
    expect(byId.get('scenario-2')!.observations).toMatch(/No tester reported/);
    // Empty report text falls back to the deterministic summary.
    expect(result.report).toContain('## Summary');
  });

  it('handles a single scenario with singular activity copy', async () => {
    const { team } = makeTeam({
      maxTesters: 4,
      tester: () => ({
        text: fence(
          JSON.stringify({
            results: [{ id: 'only', status: 'pass', observations: 'good' }],
          }),
        ),
        sessionId: 't1',
      }),
      report: () => ({ text: '## Summary\nDone.', sessionId: 'r' }),
    });
    const sink = recordingSink();
    const result = await team.run({
      featureId: 'f1',
      cwd: '/repo',
      featureInfo: 'a feature',
      setupInfo: 'setup',
      scenarios: [scenario({ id: 'only', title: 'Only' })],
      sink,
    });
    expect(result.scenarios).toHaveLength(1);
    expect(sink.activities.some((a) => a.line.includes('1 scenario '))).toBe(true);
    expect(sink.activities.some((a) => a.line.includes('1 tester'))).toBe(true);
  });

  it('marks a tester failed and rejects when its turn throws', async () => {
    const { team } = makeTeam({
      maxTesters: 1,
      tester: () => {
        throw new Error('tester boom');
      },
    });
    const sink = recordingSink();
    await expect(team.run(request(sink))).rejects.toThrow('tester boom');
    expect(sink.agents.some((a) => a.status === 'failed')).toBe(true);
  });
});
