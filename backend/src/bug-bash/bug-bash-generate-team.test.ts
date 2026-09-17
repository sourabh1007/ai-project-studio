import { describe, it, expect } from 'vitest';
import type { Clock } from '../kernel/clock.js';
import type { MetaRunResult } from '../meta/meta-runner.js';
import { bugBashDefaults } from './config.js';
import {
  ANALYST_LEAD_AGENT_ID,
  createBugBashGenerateTeam,
  splitAreas,
} from './bug-bash-generate-team.js';
import type { ParsedArea } from './bug-bash-scenarios.js';
import type { BugBashTeamSink } from './bug-bash-team.js';
import type { BugBashActivity, BugBashAgent } from './bug-bash-contract.js';

function fence(json: string): string {
  return ['```json', json, '```'].join('\n');
}

function stepClock(): Clock {
  let ms = 1_000;
  return {
    now: () => new Date((ms += 10)),
    isoNow: () => new Date((ms += 1)).toISOString(),
  };
}

function makeSink() {
  const activities: Array<Omit<BugBashActivity, 'runId'>> = [];
  const agents: BugBashAgent[] = [];
  const sink: BugBashTeamSink = {
    activity: (a) => activities.push(a),
    agent: (a) => agents.push(a),
  };
  return { sink, activities, agents };
}

const areasResponse = (titles: Array<[string, string]>): string =>
  fence(
    JSON.stringify({
      areas: titles.map(([title, focus]) => ({ title, focus })),
    }),
  );

const scenariosResponse = (titles: string[]): string =>
  fence(
    JSON.stringify({
      scenarios: titles.map((title) => ({ title, steps: ['do it'] })),
    }),
  );

function request(
  sink: BugBashTeamSink,
  signal?: AbortSignal,
): Parameters<
  ReturnType<typeof createBugBashGenerateTeam>['generate']
>[0] {
  return {
    featureId: 'f1',
    cwd: '/repo',
    featureInfo: 'A feature',
    setupInfo: 'setup',
    sink,
    signal,
  };
}

describe('splitAreas', () => {
  const area = (title: string): ParsedArea => ({ title, focus: title });

  it('returns no groups for empty input', () => {
    expect(splitAreas([], 4)).toEqual([]);
  });

  it('round-robins areas into balanced groups', () => {
    const groups = splitAreas(
      [area('a'), area('b'), area('c')],
      2,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].map((a) => a.title)).toEqual(['a', 'c']);
    expect(groups[1].map((a) => a.title)).toEqual(['b']);
  });

  it('clamps the group count to at least one', () => {
    expect(splitAreas([area('a')], 0)).toHaveLength(1);
  });
});

describe('createBugBashGenerateTeam: generate', () => {
  it('decomposes into areas and generates in parallel, de-duplicating', async () => {
    let call = 0;
    const team = createBugBashGenerateTeam({
      clock: stepClock(),
      config: { ...bugBashDefaults, maxAnalysts: 2 },
      ai: {
        runDetailed: async (req): Promise<MetaRunResult> => {
          call += 1;
          req.onActivity?.(`activity ${call}`);
          if (call === 1) {
            return {
              text: areasResponse([
                ['Input', 'malformed input'],
                ['Errors', 'error handling'],
              ]),
              sessionId: 'lead',
              usage: {
                inputTokens: 5,
                outputTokens: 6,
                nanoAiu: null,
                credits: 2,
              },
            };
          }
          // Both analysts propose an overlapping "Shared" scenario.
          return {
            text: scenariosResponse([`Case ${call}`, 'Shared']),
            sessionId: `analyst-${call}`,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              nanoAiu: 1_000_000_000,
              credits: null,
            },
          };
        },
      },
    });
    const { sink, agents } = makeSink();
    const result = await team.generate(request(sink));

    // Lead + two analysts.
    expect(result.agents.map((a) => a.id)).toEqual([
      ANALYST_LEAD_AGENT_ID,
      'analyst-1',
      'analyst-2',
    ]);
    expect(result.agents.every((a) => a.role === 'analyst')).toBe(true);
    // "Shared" is only kept once across the two analysts.
    const titles = result.scenarios.map((s) => s.title);
    expect(titles).toContain('Shared');
    expect(titles.filter((t) => t === 'Shared')).toHaveLength(1);
    expect(titles).toContain('Case 2');
    expect(titles).toContain('Case 3');
    // The lead's metrics were captured from the decompose turn.
    const lead = result.agents.find((a) => a.id === ANALYST_LEAD_AGENT_ID)!;
    expect(lead.credits).toBe(2);
    expect(lead.status).toBe('done');
    // Analyst nano-AIU is converted to AIC.
    const sub = result.agents.find((a) => a.id === 'analyst-1')!;
    expect(sub.credits).toBe(1);
    // Running + done snapshots were streamed for each analyst.
    expect(agents.some((a) => a.id === 'analyst-1' && a.status === 'running')).toBe(
      true,
    );
    expect(agents.some((a) => a.id === 'analyst-1' && a.status === 'done')).toBe(
      true,
    );
  });

  it('falls back to a single whole-feature analyst when decomposition is empty', async () => {
    let call = 0;
    const team = createBugBashGenerateTeam({
      clock: stepClock(),
      config: bugBashDefaults,
      ai: {
        runDetailed: async (): Promise<MetaRunResult> => {
          call += 1;
          if (call === 1) {
            return { text: 'no json here', sessionId: 'lead' };
          }
          return { text: scenariosResponse(['Only']), sessionId: 'a' };
        },
      },
    });
    const { sink, activities } = makeSink();
    const result = await team.generate(request(sink));

    expect(result.agents.map((a) => a.id)).toEqual([
      ANALYST_LEAD_AGENT_ID,
      'analyst-1',
    ]);
    // Single analyst is titled "Analyst" (no index) with singular copy.
    expect(result.agents[1].title).toBe('Analyst');
    expect(
      activities.some((a) => a.line.includes('1 focus area') && a.line.includes('1 analyst')),
    ).toBe(true);
    expect(result.scenarios.map((s) => s.title)).toEqual(['Only']);
  });

  it('propagates an analyst failure and marks it failed', async () => {
    let call = 0;
    const team = createBugBashGenerateTeam({
      clock: stepClock(),
      config: { ...bugBashDefaults, maxAnalysts: 1 },
      ai: {
        runDetailed: async (): Promise<MetaRunResult> => {
          call += 1;
          if (call === 1) {
            return {
              text: areasResponse([['Only', 'the whole thing']]),
              sessionId: 'lead',
            };
          }
          throw new Error('analyst boom');
        },
      },
    });
    const { sink, agents } = makeSink();
    await expect(team.generate(request(sink))).rejects.toThrow('analyst boom');
    expect(agents.some((a) => a.id === 'analyst-1' && a.status === 'failed')).toBe(
      true,
    );
  });
});
