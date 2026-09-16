import { describe, it, expect } from 'vitest';
import type { Clock } from '../kernel/clock.js';
import type { MetaRequest, MetaRunResult } from '../meta/meta-runner.js';
import { newTaskDefaults } from './config.js';
import type { NewTaskAgent } from './new-task-contract.js';
import {
  agentMetricsOf,
  createNewTaskTeam,
  extractJsonObject,
  MANAGER_AGENT_ID,
  parseDecomposition,
  type NewTaskTeamSink,
} from './new-task-team.js';

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

interface Recorded {
  agents: NewTaskAgent[];
  activities: Array<{ line: string; agentId?: string }>;
}

function recordingSink(): NewTaskTeamSink & Recorded {
  const agents: NewTaskAgent[] = [];
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

/** Build a team whose AI dispatches by request label. */
function makeTeam(handlers: {
  decompose: () => Promise<MetaRunResult> | MetaRunResult;
  worker?: (req: MetaRequest) => Promise<MetaRunResult> | MetaRunResult;
  review?: () => Promise<MetaRunResult> | MetaRunResult;
  maxWorkers?: number;
}) {
  const calls: string[] = [];
  const team = createNewTaskTeam({
    clock: stepClock(),
    config: { ...newTaskDefaults, maxWorkers: handlers.maxWorkers ?? 4 },
    ai: {
      runDetailed: async (req: MetaRequest): Promise<MetaRunResult> => {
        req.onActivity?.(`activity for ${req.label}`);
        calls.push(req.label ?? '');
        const label = req.label ?? '';
        if (label.includes('manager review')) {
          return (handlers.review ?? (() => ({ text: '', sessionId: 'r' })))();
        }
        if (label.includes('manager')) {
          return handlers.decompose();
        }
        return (handlers.worker ?? (() => ({ text: '', sessionId: 'w' })))(req);
      },
    },
  });
  return { team, calls };
}

const REQUEST = {
  featureId: 'f1',
  worktreePath: '/wt',
  problem: 'P',
  context: 'C',
  plan: 'PLAN',
};

describe('extractJsonObject', () => {
  it('prefers a fenced json block', () => {
    expect(extractJsonObject(fence('{"a":1}'))).toBe('{"a":1}');
  });

  it('falls back to the first..last brace span in prose', () => {
    expect(extractJsonObject('noise {"a":1} tail')).toBe('{"a":1}');
  });

  it('returns null when there is no object span', () => {
    expect(extractJsonObject('no braces here')).toBeNull();
    expect(extractJsonObject('} out of order {')).toBeNull();
  });
});

describe('parseDecomposition', () => {
  it('falls back to a single whole-plan slice when no json is present', () => {
    expect(parseDecomposition('nothing', 4)).toEqual([
      { title: 'Full implementation', description: '', files: [], role: 'developer' },
    ]);
  });

  it('falls back when the json fails schema validation', () => {
    expect(parseDecomposition(fence('{"workers":"nope"}'), 4)).toEqual([
      { title: 'Full implementation', description: '', files: [], role: 'developer' },
    ]);
  });

  it('falls back when there are no file-bearing slices', () => {
    expect(parseDecomposition(fence('{"workers":[]}'), 4)).toEqual([
      { title: 'Full implementation', description: '', files: [], role: 'developer' },
    ]);
  });

  it('keeps disjoint slices, dedupes files, and carries specialization', () => {
    const slices = parseDecomposition(
      fence(
        JSON.stringify({
          workers: [
            { title: 'A', description: 'da', files: ['a.ts', ' b.ts '] },
            { title: 'B', role: 'tester', files: ['b.ts', 'c.ts'] },
          ],
        }),
      ),
      4,
    );
    expect(slices).toEqual([
      { title: 'A', description: 'da', files: ['a.ts', 'b.ts'], role: 'developer' },
      { title: 'B', description: '', files: ['c.ts'], role: 'tester' },
    ]);
  });

  it('drops a slice left with no files after dedupe', () => {
    const slices = parseDecomposition(
      fence(
        JSON.stringify({
          workers: [
            { title: 'A', files: ['a.ts'] },
            { title: 'NoFiles' },
            { title: 'B', files: ['a.ts', ' '] },
          ],
        }),
      ),
      4,
    );
    expect(slices).toEqual([
      { title: 'A', description: '', files: ['a.ts'], role: 'developer' },
    ]);
  });

  it('clamps the slice count to maxWorkers and labels blank titles', () => {
    const slices = parseDecomposition(
      fence(
        JSON.stringify({
          workers: [
            { title: '', files: ['a.ts'] },
            { title: 'B', files: ['b.ts'] },
          ],
        }),
      ),
      1,
    );
    expect(slices).toEqual([
      { title: 'Slice 1', description: '', files: ['a.ts'], role: 'developer' },
    ]);
  });
});

describe('agentMetricsOf', () => {
  it('returns all null when there is no usage', () => {
    expect(agentMetricsOf({ text: '', sessionId: 's' })).toEqual({
      inputTokens: null,
      outputTokens: null,
      credits: null,
    });
  });

  it('prefers explicit credits', () => {
    expect(
      agentMetricsOf({
        text: '',
        sessionId: 's',
        usage: { inputTokens: 1, outputTokens: 2, nanoAiu: 5e9, credits: 7 },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, credits: 7 });
  });

  it('derives credits from nano-AIU when no explicit credits', () => {
    expect(
      agentMetricsOf({
        text: '',
        sessionId: 's',
        usage: { inputTokens: 1, outputTokens: 2, nanoAiu: 3e9, credits: null },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, credits: 3 });
  });

  it('leaves credits null when neither credits nor nano-AIU are present', () => {
    expect(
      agentMetricsOf({
        text: '',
        sessionId: 's',
        usage: { inputTokens: 4, outputTokens: 5, nanoAiu: null, credits: null },
      }),
    ).toEqual({ inputTokens: 4, outputTokens: 5, credits: null });
  });
});

describe('createNewTaskTeam.implement', () => {
  it('runs a manager and one worker per slice, accumulating manager metrics', async () => {
    const { team, calls } = makeTeam({
      decompose: () => ({
        text: fence(
          JSON.stringify({
            workers: [
              { title: 'A', files: ['a.ts'] },
              { title: 'B', files: ['b.ts'] },
            ],
          }),
        ),
        sessionId: 'm',
        usage: { inputTokens: 10, outputTokens: 1, nanoAiu: null, credits: 2 },
      }),
      worker: (req) => ({
        text: `done ${req.label}`,
        sessionId: 'w',
        usage: { inputTokens: 5, outputTokens: 5, nanoAiu: null, credits: 1 },
      }),
      review: () => ({
        text: 'reviewed',
        sessionId: 'r',
        usage: { inputTokens: 3, outputTokens: 3, nanoAiu: null, credits: 4 },
      }),
    });
    const sink = recordingSink();
    const result = await team.implement({ ...REQUEST, sink });

    // Manager + two sub-agents.
    expect(result.agents.map((a) => a.id)).toEqual([
      MANAGER_AGENT_ID,
      'sub-1',
      'sub-2',
    ]);
    const manager = result.agents[0];
    expect(manager.role).toBe('manager');
    expect(manager.status).toBe('done');
    // Metrics accumulate across decompose + review (both numeric → a+b).
    expect(manager.inputTokens).toBe(13);
    expect(manager.credits).toBe(6);
    expect(manager.durationMs).toBeGreaterThan(0);

    const [w1, w2] = [result.agents[1], result.agents[2]];
    expect(w1.parentId).toBe(MANAGER_AGENT_ID);
    expect(w1.role).toBe('developer');
    expect(w1.startedAt).not.toBeNull();
    expect(w1.files).toEqual(['a.ts']);
    expect(w2.files).toEqual(['b.ts']);
    expect(w1.status).toBe('done');
    expect(w1.durationMs).toBeGreaterThan(0);

    // Both sub-agent labels and both manager passes were dispatched.
    expect(calls.filter((c) => c.includes('review'))).toHaveLength(1);
    // Per-agent activity was streamed.
    expect(
      sink.activities.some((a) => a.agentId === 'sub-1'),
    ).toBe(true);
    expect(
      sink.activities.some((a) => a.agentId === MANAGER_AGENT_ID),
    ).toBe(true);
  });

  it('adds review metrics when the decompose turn reported none (null + b)', async () => {
    const { team } = makeTeam({
      decompose: () => ({
        text: fence(JSON.stringify({ workers: [{ title: 'A', files: ['a.ts'] }] })),
        sessionId: 'm',
      }),
      worker: () => ({ text: 'ok', sessionId: 'w' }),
      review: () => ({
        text: 'reviewed',
        sessionId: 'r',
        usage: { inputTokens: 9, outputTokens: 8, nanoAiu: null, credits: 5 },
      }),
    });
    const sink = recordingSink();
    const result = await team.implement({ ...REQUEST, sink });
    expect(result.agents[0].inputTokens).toBe(9);
    expect(result.agents[0].credits).toBe(5);
  });

  it('keeps decompose metrics when the review turn reports none (a + null)', async () => {
    const { team } = makeTeam({
      decompose: () => ({
        text: fence(JSON.stringify({ workers: [{ title: 'A', files: ['a.ts'] }] })),
        sessionId: 'm',
        usage: { inputTokens: 6, outputTokens: 2, nanoAiu: null, credits: 3 },
      }),
      worker: () => ({ text: 'ok', sessionId: 'w' }),
      review: () => ({ text: 'reviewed', sessionId: 'r' }),
    });
    const sink = recordingSink();
    const result = await team.implement({ ...REQUEST, sink });
    expect(result.agents[0].inputTokens).toBe(6);
    expect(result.agents[0].credits).toBe(3);
  });

  it('runs a single fallback slice when the plan cannot be decomposed', async () => {
    const { team } = makeTeam({
      decompose: () => ({ text: 'no json', sessionId: 'm' }),
      worker: () => ({ text: 'ok', sessionId: 'w' }),
    });
    const sink = recordingSink();
    const result = await team.implement({ ...REQUEST, sink });
    expect(result.agents).toHaveLength(2);
    expect(result.agents[1].title).toContain('Full implementation');
    expect(
      sink.activities.some((a) => a.line.includes('1 slice')),
    ).toBe(true);
  });

  it('marks a worker failed and rethrows when its turn throws', async () => {
    const { team } = makeTeam({
      decompose: () => ({
        text: fence(JSON.stringify({ workers: [{ title: 'A', files: ['a.ts'] }] })),
        sessionId: 'm',
      }),
      worker: () => {
        throw new Error('worker exploded');
      },
    });
    const sink = recordingSink();
    await expect(team.implement({ ...REQUEST, sink })).rejects.toThrow(
      'worker exploded',
    );
    const failed = sink.agents.filter((a) => a.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('sub-1');
    expect(failed[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
