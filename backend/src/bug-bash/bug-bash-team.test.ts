import { describe, it, expect } from 'vitest';
import type { Clock } from '../kernel/clock.js';
import type { MetaRequest, MetaRunResult } from '../meta/meta-runner.js';
import { bugBashDefaults } from './config.js';
import type { BugBashAgent, BugBashScenario } from './bug-bash-contract.js';
import {
  agentMetricsOf,
  chooseTesterCount,
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
    ran: false,
    actualOutput: '',
    blockedReason: null,
    testerId: null,
    diagnostics: '',
    reproScript: '',
    evidenceGaps: [],
    ...overrides,
  };
}

interface Recorded {
  agents: BugBashAgent[];
  activities: Array<{ line: string; agentId?: string }>;
  scenarioProgress: Array<{ id: string; status: string }>;
}

function recordingSink(): BugBashTeamSink & Recorded {
  const agents: BugBashAgent[] = [];
  const activities: Array<{ line: string; agentId?: string }> = [];
  const scenarioProgress: Array<{ id: string; status: string }> = [];
  return {
    agents,
    activities,
    scenarioProgress,
    agent(agent) {
      agents.push({ ...agent });
    },
    activity(activity) {
      activities.push({ line: activity.line, agentId: activity.agentId });
    },
    scenario(progress) {
      scenarioProgress.push(progress);
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
    expect(chooseTesterCount(0, 4)).toBe(0);
  });

  it('scales tester count by scenario volume and round-robins balanced groups', () => {
    const scenarios = [
      scenario({ id: 's1' }),
      scenario({ id: 's2' }),
      scenario({ id: 's3' }),
      scenario({ id: 's4' }),
      scenario({ id: 's5' }),
    ];
    const groups = splitScenarios(scenarios, 8, 2);
    expect(groups.map((g) => g.map((s) => s.id))).toEqual([
      ['s1', 's4'],
      ['s2', 's5'],
      ['s3'],
    ]);
    expect(chooseTesterCount(9, 8, 4)).toBe(3);
  });

  it('clamps tester count to the configured bounds', () => {
    expect(splitScenarios([scenario({ id: 's1' })], 4)).toHaveLength(1);
    expect(chooseTesterCount(20, 2, 4)).toBe(2);
    expect(chooseTesterCount(2, 0, 0)).toBe(1);
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

function request(sink: BugBashTeamSink, scenarios = SCENARIOS) {
  return {
    featureId: 'f1',
    cwd: '/repo',
    featureInfo: 'a feature',
    setupInfo: 'setup',
    scenarios,
    sink,
  };
}

describe('bug-bash team', () => {
  it('runs testers in parallel, merges results, and uses the lead report', async () => {
    const scenarios = [
      scenario({ id: 'scenario-1', title: 'A' }),
      scenario({ id: 'scenario-2', title: 'B' }),
      scenario({ id: 'scenario-3', title: 'C' }),
      scenario({ id: 'scenario-4', title: 'D' }),
      scenario({ id: 'scenario-5', title: 'E' }),
    ];
    const { team, calls } = makeTeam({
      maxTesters: 2,
      tester: (req) => {
        const id =
          scenarios.find((s) => req.prompt.includes(`Scenario ${s.id}:`))?.id ??
          'missing';
        if ((req.label ?? '').includes('Tester 1')) {
          const usage =
            id === 'scenario-3'
              ? undefined
              : id === 'scenario-5'
                ? {
                    inputTokens: 2,
                    outputTokens: 3,
                    nanoAiu: 2_000_000_000,
                    credits: null,
                  }
                : {
                    inputTokens: 10,
                    outputTokens: 5,
                    nanoAiu: null,
                    credits: 1,
                  };
          return {
            text: fence(
              JSON.stringify({
                results: [
                  {
                    id,
                    status: id === 'scenario-3' ? 'fail' : 'pass',
                    observations: id === 'scenario-3' ? 'bug' : 'ok',
                  },
                ],
              }),
            ),
            sessionId: 't1',
            ...(usage ? { usage } : {}),
          };
        }
        return {
          text: fence(
            JSON.stringify({
              results: [
                { id, status: 'pass', observations: 'fine' },
              ],
            }),
          ),
          sessionId: 't2',
        };
      },
      report: () => ({ text: '## Summary\nAll ran.', sessionId: 'r' }),
    });
    const sink = recordingSink();
    const result = await team.run(request(sink, scenarios));

    expect(calls.filter((label) => label.includes('Tester'))).toEqual([
      'Bug bash · Tester 1',
      'Bug bash · Tester 2',
      'Bug bash · Tester 1',
      'Bug bash · Tester 2',
      'Bug bash · Tester 1',
    ]);
    expect(calls.at(-1)).toBe('Bug bash · lead report');
    expect(result.report).toBe('## Summary\nAll ran.');
    expect(result.scenarios.map((s) => [s.id, s.status, s.observations])).toEqual([
      ['scenario-1', 'pass', 'ok'],
      ['scenario-2', 'pass', 'fine'],
      ['scenario-3', 'fail', 'bug'],
      ['scenario-4', 'pass', 'fine'],
      ['scenario-5', 'pass', 'ok'],
    ]);

    const lead = result.agents.find((a) => a.id === LEAD_AGENT_ID)!;
    expect(lead.role).toBe('lead');
    expect(lead.status).toBe('done');
    const testers = result.agents.filter((a) => a.role === 'tester');
    expect(testers.map((t) => t.id)).toEqual(['tester-1', 'tester-2']);
    expect(testers[0].scenarioIds).toEqual([
      'scenario-1',
      'scenario-3',
      'scenario-5',
    ]);
    expect(testers[0].credits).toBe(3);
    expect(testers[0].inputTokens).toBe(12);
    expect(testers[0].outputTokens).toBe(8);
    expect(testers[0].status).toBe('done');
    expect(testers[1].credits).toBeNull();
    expect(sink.scenarioProgress).toEqual([
      { id: 'scenario-1', status: 'running' },
      { id: 'scenario-2', status: 'running' },
      { id: 'scenario-1', status: 'pass' },
      { id: 'scenario-3', status: 'running' },
      { id: 'scenario-2', status: 'pass' },
      { id: 'scenario-4', status: 'running' },
      { id: 'scenario-3', status: 'fail' },
      { id: 'scenario-5', status: 'running' },
      { id: 'scenario-4', status: 'pass' },
      { id: 'scenario-5', status: 'pass' },
    ]);
    // Every tester + lead activity carries its agent id.
    expect(sink.activities.some((a) => a.agentId === 'tester-1')).toBe(true);
    expect(sink.activities.some((a) => a.agentId === LEAD_AGENT_ID)).toBe(true);

    // The evidence auditor runs after the testers, flags verdicts with no
    // corroborating output/logs/repro script, and reports zero AI cost.
    const auditor = result.agents.find((a) => a.id === 'auditor')!;
    expect(auditor.role).toBe('auditor');
    expect(auditor.parentId).toBe(LEAD_AGENT_ID);
    expect(auditor.status).toBe('done');
    expect(auditor.credits).toBe(0);
    expect(auditor.scenarioIds).toEqual([
      'scenario-1',
      'scenario-2',
      'scenario-3',
      'scenario-4',
      'scenario-5',
    ]);
    const s1 = result.scenarios.find((s) => s.id === 'scenario-1')!;
    expect(s1.evidenceGaps).toEqual([
      'actual output',
      'diagnostics/logs',
      'a repro script',
    ]);
    expect(sink.activities.some((a) => a.agentId === 'auditor')).toBe(true);
    expect(
      sink.activities.some(
        (a) => a.agentId === 'auditor' && a.line.includes('missing'),
      ),
    ).toBe(true);
  });

  it('passes the audit and carries repro scripts when every verdict is fully evidenced', async () => {
    const evidenced = (id: string, repro: string) => ({
      id,
      status: 'pass',
      actualOutput: 'it ran',
      diagnostics: 'log line',
      reproScript: repro,
    });
    const { team } = makeTeam({
      maxTesters: 1,
      tester: () => ({
        text: fence(
          JSON.stringify({
            results: [
              evidenced('scenario-1', 'curl x'),
              evidenced('scenario-2', 'curl y'),
              evidenced('scenario-3', 'curl z'),
            ],
          }),
        ),
        sessionId: 't1',
      }),
      report: () => ({ text: '## Summary\nok', sessionId: 'r' }),
    });
    const sink = recordingSink();
    const result = await team.run(request(sink));

    expect(result.scenarios.every((s) => s.evidenceGaps.length === 0)).toBe(true);
    expect(result.scenarios.find((s) => s.id === 'scenario-1')!.reproScript).toBe(
      'curl x',
    );
    expect(
      sink.activities.some(
        (a) => a.agentId === 'auditor' && a.line.includes('backed by'),
      ),
    ).toBe(true);
  });

  it('blocks scenarios no tester reported and falls back to a compiled report', async () => {
    const { team } = makeTeam({
      maxTesters: 1,
      tester: (req) => {
        const results = req.prompt.includes('Scenario scenario-1:')
          ? [{ id: 'scenario-1', status: 'pass', observations: '' }]
          : [];
        return {
          text: fence(JSON.stringify({ results })),
          sessionId: 't1',
        };
      },
      report: () => ({ text: '   ', sessionId: 'r' }),
    });
    const sink = recordingSink();
    const result = await team.run(request(sink));

    const byId = new Map(result.scenarios.map((s) => [s.id, s]));
    expect(byId.get('scenario-1')!.status).toBe('pass');
    expect(byId.get('scenario-1')!.observations).toBe('');
    expect(byId.get('scenario-2')!.status).toBe('blocked');
    expect(byId.get('scenario-2')!.observations).toMatch(/No tester reported/);
    expect(sink.scenarioProgress).toContainEqual({
      id: 'scenario-2',
      status: 'blocked',
    });
    // Empty report text falls back to the deterministic summary.
    expect(result.report).toContain('## Summary');
  });

  it('uses the first parsed result when a one-scenario turn reports the wrong id', async () => {
    const { team } = makeTeam({
      maxTesters: 1,
      tester: () => ({
        text: fence(
          JSON.stringify({
            results: [
              { id: 'wrong-id', status: 'fail', observations: 'wrong id' },
            ],
          }),
        ),
        sessionId: 't1',
      }),
      report: () => ({ text: '## Summary\nDone.', sessionId: 'r' }),
    });
    const sink = recordingSink();
    const result = await team.run({
      ...request(sink, [scenario({ id: 'only', title: 'Only' })]),
    });
    expect(result.scenarios[0].id).toBe('only');
    expect(result.scenarios[0].status).toBe('fail');
    expect(result.scenarios[0].observations).toBe('wrong id');
    expect(sink.scenarioProgress).toEqual([
      { id: 'only', status: 'running' },
      { id: 'only', status: 'fail' },
    ]);
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

  it('marks a tester failed and rejects when a later scenario turn throws', async () => {
    let calls = 0;
    const { team } = makeTeam({
      maxTesters: 1,
      tester: () => {
        calls += 1;
        if (calls === 2) {
          throw new Error('tester boom');
        }
        return {
          text: fence(
            JSON.stringify({
              results: [{ id: 'scenario-1', status: 'pass' }],
            }),
          ),
          sessionId: 't1',
        };
      },
    });
    const sink = recordingSink();
    await expect(team.run(request(sink))).rejects.toThrow('tester boom');
    expect(sink.agents.some((a) => a.status === 'failed')).toBe(true);
    expect(sink.scenarioProgress).toContainEqual({
      id: 'scenario-1',
      status: 'pass',
    });
    expect(sink.scenarioProgress).toContainEqual({
      id: 'scenario-2',
      status: 'running',
    });
  });
});
