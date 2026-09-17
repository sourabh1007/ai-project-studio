import { describe, it, expect } from 'vitest';
import type { Clock } from '../kernel/clock.js';
import { MetaAbortError, type MetaRunResult } from '../meta/meta-runner.js';
import { bugBashDefaults } from './config.js';
import { createBugBashService } from './bug-bash-service.js';
import type { BugBashTeam, BugBashTeamResult } from './bug-bash-team.js';
import type {
  BugBashActivity,
  BugBashAgent,
  BugBashEventMap,
  BugBashRun,
  BugBashRunRepo,
  BugBashRunSink,
  BugBashScenario,
} from './bug-bash-contract.js';

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

function makeRepo(seed: BugBashRun[] = []): BugBashRunRepo & {
  map: Map<string, BugBashRun>;
} {
  const map = new Map<string, BugBashRun>();
  for (const run of seed) map.set(run.id, run);
  return {
    map,
    get: (id) => map.get(id) ?? null,
    create: (run) => void map.set(run.id, { ...run }),
    update: (run) => void map.set(run.id, { ...run }),
    delete: (id) => void map.delete(id),
    deleteByFeature: () => {},
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

const ANALYST: BugBashAgent = {
  id: 'analyst',
  parentId: null,
  role: 'analyst',
  title: 'Scenario analyst',
  scenarioIds: [],
  status: 'done',
  startedAt: null,
  durationMs: 5,
  inputTokens: 1,
  outputTokens: 1,
  credits: 1,
};

function makeSink() {
  const events = {
    activities: [] as Array<Omit<BugBashActivity, 'runId'>>,
    agents: [] as BugBashAgent[],
    done: [] as BugBashRun[],
    failed: [] as string[],
  };
  const sink: BugBashRunSink = {
    activity: (a) => events.activities.push(a),
    agent: (a) => events.agents.push(a),
    done: (r) => events.done.push(r),
    failed: (e) => events.failed.push(e),
  };
  return { sink, events };
}

interface Deps {
  repo?: BugBashRunRepo & { map: Map<string, BugBashRun> };
  runDetailed?: (req: {
    onActivity?: (line: string) => void;
    signal?: AbortSignal;
  }) => Promise<MetaRunResult>;
  team?: BugBashTeam;
}

function makeService(deps: Deps = {}) {
  const repo = deps.repo ?? makeRepo();
  const emitted: Array<{ phase: string; line: string; agentId?: string }> = [];
  const team: BugBashTeam =
    deps.team ??
    ({ run: async (): Promise<BugBashTeamResult> => ({ agents: [], scenarios: [], report: 'R' }) } as BugBashTeam);
  const service = createBugBashService({
    repo,
    workspace: { resolve: () => ({ repoId: 'r1', repoLocalPath: '/repo' }) },
    config: bugBashDefaults,
    clock: stepClock(),
    ai: {
      runDetailed:
        deps.runDetailed ??
        (async () => ({ text: fence('{"scenarios":[]}'), sessionId: 's' })),
    },
    team,
    bus: {
      emit: (type: keyof BugBashEventMap, payload: BugBashActivity) =>
        emitted.push({
          phase: payload.phase,
          line: payload.line,
          agentId: payload.agentId,
        }),
    },
  });
  return { service, repo, emitted };
}

describe('bug-bash-service: saveInputs', () => {
  it('rejects a blank feature info', () => {
    const { service } = makeService();
    expect(() =>
      service.saveInputs('a1', 'f1', { featureInfo: '  ', setupInfo: 'x' }),
    ).toThrow('Feature information is required.');
  });

  it('creates a fresh draft run', () => {
    const { service, repo } = makeService();
    const run = service.saveInputs('a1', 'f1', {
      featureInfo: '  a feature ',
      setupInfo: '  docs ',
    });
    expect(run.status).toBe('draft');
    expect(run.featureInfo).toBe('a feature');
    expect(run.setupInfo).toBe('docs');
    expect(repo.map.get('a1')).toBeDefined();
  });

  it('resets an existing run back to a draft, dropping scenarios/report', () => {
    const { service } = makeService(
      seeded({ status: 'reported', scenarios: [scenario()], report: 'old' }),
    );
    const run = service.saveInputs('a1', 'f1', {
      featureInfo: 'new',
      setupInfo: '',
    });
    expect(run.status).toBe('draft');
    expect(run.scenarios).toEqual([]);
    expect(run.report).toBeNull();
  });
});

describe('bug-bash-service: get + reset', () => {
  it('gets a run', () => {
    const { service } = makeService(seeded({}));
    expect(service.get('a1')!.id).toBe('a1');
  });

  it('resets a missing run to null', () => {
    const { service } = makeService();
    expect(service.reset('missing')).toBeNull();
  });

  it('resets a run with scenarios back to generated, clearing results', () => {
    const { service } = makeService(
      seeded({
        status: 'failed',
        scenarios: [scenario({ status: 'fail', observations: 'bug' })],
        report: 'r',
        error: 'boom',
        agents: [ANALYST],
      }),
    );
    const run = service.reset('a1')!;
    expect(run.status).toBe('generated');
    expect(run.scenarios[0].status).toBe('pending');
    expect(run.scenarios[0].observations).toBe('');
    expect(run.report).toBeNull();
    expect(run.error).toBeNull();
    expect(run.agents).toEqual([]);
  });

  it('resets a run without scenarios back to draft', () => {
    const { service } = makeService(seeded({ status: 'failed' }));
    expect(service.reset('a1')!.status).toBe('draft');
  });
});

describe('bug-bash-service: generate', () => {
  it('rejects when no run exists', async () => {
    const { service } = makeService();
    await expect(service.generate('missing')).rejects.toThrow(
      /No Bug Bash run/,
    );
  });

  it('generates scenarios and streams the analyst to the sink', async () => {
    const { service, repo, emitted } = makeService({
      ...seeded({ status: 'draft' }),
      runDetailed: async (req) => {
        req.onActivity?.('reading code');
        return {
          text: fence(
            JSON.stringify({
              scenarios: [
                { title: 'Empty', input: 'x', steps: ['a'], expectedOutput: 'err' },
              ],
            }),
          ),
          sessionId: 'g',
          usage: { inputTokens: 2, outputTokens: 3, nanoAiu: null, credits: 1 },
        };
      },
    });
    const { sink, events } = makeSink();
    const run = await service.generate('a1', undefined, sink);

    expect(run.status).toBe('generated');
    expect(run.scenarios).toHaveLength(1);
    expect(run.scenarios[0].id).toBe('scenario-1');
    expect(run.scenarios[0].title).toBe('Empty');
    expect(run.agents.map((a) => a.role)).toEqual(['analyst']);
    expect(run.agents[0].credits).toBe(1);
    // Running then done snapshots were emitted.
    expect(events.agents.map((a) => a.status)).toEqual(['running', 'done']);
    expect(events.done).toHaveLength(1);
    // The streamed activity line reached the bus and the sink.
    expect(emitted.some((e) => e.line === 'reading code')).toBe(true);
    expect(repo.map.get('a1')!.status).toBe('generated');
  });

  it('works without a sink', async () => {
    const { service } = makeService(seeded({ status: 'draft' }));
    const run = await service.generate('a1');
    expect(run.status).toBe('generated');
  });

  it('uses plural copy and streams multiple scenarios to the sink', async () => {
    const { service } = makeService({
      ...seeded({ status: 'draft' }),
      runDetailed: async () => ({
        text: fence(
          JSON.stringify({
            scenarios: [
              { title: 'One', steps: ['a'] },
              { title: 'Two', steps: ['b'] },
            ],
          }),
        ),
        sessionId: 'g',
      }),
    });
    const { sink, events } = makeSink();
    const run = await service.generate('a1', undefined, sink);
    expect(run.scenarios).toHaveLength(2);
    expect(events.activities.some((a) => a.line.includes('2 scenarios'))).toBe(
      true,
    );
  });

  it('reports a non-Error throw via String coercion', async () => {
    const { service } = makeService({
      ...seeded({ status: 'draft' }),
      runDetailed: async () => {
        throw 'stringboom';
      },
    });
    const { sink, events } = makeSink();
    await service.generate('a1', undefined, sink);
    expect(events.failed).toEqual(['stringboom']);
  });

  it('reports cancellation when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service } = makeService({
      ...seeded({ status: 'draft' }),
      runDetailed: async () => {
        throw new Error('interrupted');
      },
    });
    const { sink, events } = makeSink();
    const run = await service.generate('a1', controller.signal, sink);
    expect(events.failed).toEqual(['Scenario generation was cancelled.']);
    expect(run.status).toBe('generating');
  });

  it('reports a failure through the sink', async () => {
    const { service, repo } = makeService({
      ...seeded({ status: 'draft' }),
      runDetailed: async () => {
        throw new Error('boom');
      },
    });
    const { sink, events } = makeSink();
    const run = await service.generate('a1', undefined, sink);
    expect(events.failed).toEqual(['boom']);
    expect(run.status).toBe('failed');
    expect(repo.map.get('a1')!.error).toBe('boom');
  });

  it('throws a failure when no sink is supplied', async () => {
    const { service, repo } = makeService({
      ...seeded({ status: 'draft' }),
      runDetailed: async () => {
        throw new Error('boom');
      },
    });
    await expect(service.generate('a1')).rejects.toThrow('boom');
    expect(repo.map.get('a1')!.status).toBe('failed');
  });
});

describe('bug-bash-service: run', () => {
  it('rejects when no run exists', async () => {
    const { service } = makeService();
    const { sink } = makeSink();
    await expect(service.run('missing', sink)).rejects.toThrow(
      /No Bug Bash run/,
    );
  });

  it('blocks when the run is a draft', async () => {
    const { service } = makeService(seeded({ status: 'draft' }));
    const { sink, events } = makeSink();
    await service.run('a1', sink);
    expect(events.failed[0]).toMatch(/accept scenarios/);
  });

  it('blocks when there are no scenarios', async () => {
    const { service } = makeService(seeded({ status: 'generated', scenarios: [] }));
    const { sink, events } = makeSink();
    await service.run('a1', sink);
    expect(events.failed[0]).toMatch(/accept scenarios/);
  });

  it('runs the team, keeps the analyst, and reports', async () => {
    const lead: BugBashAgent = {
      id: 'lead',
      parentId: null,
      role: 'lead',
      title: 'Lead agent',
      scenarioIds: [],
      status: 'done',
      startedAt: null,
      durationMs: 9,
      inputTokens: null,
      outputTokens: null,
      credits: null,
    };
    const ranScenarios = [scenario({ status: 'pass', observations: 'ok' })];
    const { service, repo, emitted } = makeService({
      ...seeded({
        status: 'generated',
        scenarios: [scenario()],
        agents: [ANALYST],
      }),
      team: {
        run: async (req) => {
          req.sink.activity({ phase: 'running', line: 'go', agentId: 'lead' });
          req.sink.agent({ ...lead });
          return { agents: [lead], scenarios: ranScenarios, report: '## Summary' };
        },
      },
    });
    const { sink, events } = makeSink();
    await service.run('a1', sink);

    const stored = repo.map.get('a1')!;
    expect(stored.status).toBe('reported');
    expect(stored.report).toBe('## Summary');
    expect(stored.scenarios).toEqual(ranScenarios);
    expect(stored.agents.map((a) => a.role)).toEqual(['analyst', 'lead']);
    expect(events.done).toHaveLength(1);
    expect(events.activities.some((a) => a.line === 'go')).toBe(true);
    expect(emitted.some((e) => e.phase === 'done')).toBe(true);
  });

  it('reports cancellation when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service } = makeService({
      ...seeded({ status: 'generated', scenarios: [scenario()] }),
      team: {
        run: async () => {
          throw new Error('interrupted');
        },
      },
    });
    const { sink, events } = makeSink();
    await service.run('a1', sink, controller.signal);
    expect(events.failed).toEqual(['The bug bash was cancelled.']);
  });

  it('treats a MetaAbortError as a cancellation', async () => {
    const { service, repo } = makeService({
      ...seeded({ status: 'generated', scenarios: [scenario()] }),
      team: {
        run: async () => {
          throw new MetaAbortError({ kind: 'aborted', termination: 'confirmed' });
        },
      },
    });
    const { sink, events } = makeSink();
    await service.run('a1', sink);
    expect(events.failed).toEqual(['The bug bash was cancelled.']);
    expect(repo.map.get('a1')!.status).toBe('failed');
  });

  it('reports a generic failure through the sink', async () => {
    const { service, repo } = makeService({
      ...seeded({ status: 'generated', scenarios: [scenario()] }),
      team: {
        run: async () => {
          throw new Error('kaboom');
        },
      },
    });
    const { sink, events } = makeSink();
    await service.run('a1', sink);
    expect(events.failed).toEqual(['kaboom']);
    expect(repo.map.get('a1')!.status).toBe('failed');
  });
});

/** Build a Deps object with a repo pre-seeded with one run. */
function seeded(overrides: Partial<BugBashRun>): { repo: ReturnType<typeof makeRepo> } {
  const run: BugBashRun = {
    id: 'a1',
    featureId: 'f1',
    featureInfo: 'a feature',
    setupInfo: 'setup',
    scenarios: [],
    report: null,
    status: 'draft',
    error: null,
    agents: [],
    createdAt: 't',
    updatedAt: 't',
    ...overrides,
  };
  return { repo: makeRepo([run]) };
}
