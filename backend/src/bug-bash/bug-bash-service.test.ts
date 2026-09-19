import { describe, it, expect } from 'vitest';
import type { Clock } from '../kernel/clock.js';
import { MetaAbortError, type MetaRunResult } from '../meta/meta-runner.js';
import { bugBashDefaults } from './config.js';
import { createBugBashService } from './bug-bash-service.js';
import type { BugBashTeam, BugBashTeamResult } from './bug-bash-team.js';
import type {
  BugBashGenerateResult,
  BugBashGenerateTeam,
} from './bug-bash-generate-team.js';
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
    scenarios: [] as Array<{ id: string; status: string }>,
    done: [] as BugBashRun[],
    failed: [] as string[],
  };
  const sink: BugBashRunSink = {
    activity: (a) => events.activities.push(a),
    agent: (a) => events.agents.push(a),
    scenario: (progress) => events.scenarios.push(progress),
    done: (r) => events.done.push(r),
    failed: (e) => events.failed.push(e),
  };
  return { sink, events };
}

interface Deps {
  repo?: BugBashRunRepo & { map: Map<string, BugBashRun> };
  generateTeam?: BugBashGenerateTeam;
  team?: BugBashTeam;
  runDetailed?: () => Promise<MetaRunResult>;
}

function makeService(deps: Deps = {}) {
  const repo = deps.repo ?? makeRepo();
  const emitted: Array<{ phase: string; line: string; agentId?: string }> = [];
  const generateTeam: BugBashGenerateTeam =
    deps.generateTeam ??
    ({
      generate: async (): Promise<BugBashGenerateResult> => ({
        agents: [],
        scenarios: [],
      }),
    } as BugBashGenerateTeam);
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
        (async () => ({ text: fence('{"reply":"ok"}'), sessionId: 's' })),
    },
    generateTeam,
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
      otherInfo: '  extra notes  ',
    });
    expect(run.status).toBe('draft');
    expect(run.featureInfo).toBe('a feature');
    expect(run.setupInfo).toBe('docs');
    expect(run.otherInfo).toBe('extra notes');
    expect(repo.map.get('a1')).toBeDefined();
  });

  it('resets an existing run back to a draft, dropping scenarios/report', () => {
    const { service } = makeService(
      seeded({ status: 'reported', scenarios: [scenario()], report: 'old' }),
    );
    const run = service.saveInputs('a1', 'f1', {
      featureInfo: 'new',
      setupInfo: '',
      otherInfo: '',
    });
    expect(run.status).toBe('draft');
    expect(run.scenarios).toEqual([]);
    expect(run.report).toBeNull();
  });
});

describe('bug-bash-service: prerequisites', () => {
  it('generates prerequisite questions from the inputs', async () => {
    const { service, repo } = makeService({
      ...seeded({ otherInfo: 'extra' }),
      runDetailed: async () => ({
        text: fence(
          '{"prerequisites":[{"question":"Which account?","detail":"needed to connect","options":["Shared","Personal"]},{"question":"","detail":"dropped"}]}',
        ),
        sessionId: 's',
      }),
    });
    const run = await service.generatePrerequisites('a1');
    expect(run.prerequisites).toEqual([
      {
        id: 'prereq-1',
        question: 'Which account?',
        detail: 'needed to connect',
        options: ['Shared', 'Personal'],
        answer: '',
      },
    ]);
    expect(repo.map.get('a1')!.prerequisites).toHaveLength(1);
  });

  it('preserves an existing answer for an unchanged question on regenerate', async () => {
    const { service } = makeService({
      ...seeded({
        prerequisites: [
          {
            id: 'prereq-1',
            question: 'Which account?',
            detail: 'old',
            answer: 'account-42',
          },
        ],
      }),
      runDetailed: async () => ({
        text: fence(
          '{"prerequisites":[{"question":"Which account?","detail":"new"}]}',
        ),
        sessionId: 's',
      }),
    });
    const run = await service.generatePrerequisites('a1');
    expect(run.prerequisites[0].answer).toBe('account-42');
    expect(run.prerequisites[0].detail).toBe('new');
  });

  it('saves answers by id, leaving other questions untouched', () => {
    const { service } = makeService(
      seeded({
        prerequisites: [
          { id: 'prereq-1', question: 'Q1', detail: '', answer: '' },
          { id: 'prereq-2', question: 'Q2', detail: '', answer: 'keep' },
        ],
      }),
    );
    const run = service.savePrerequisiteAnswers('a1', [
      { id: 'prereq-1', answer: 'answered' },
      { id: 'missing', answer: 'ignored' },
    ]);
    expect(run.prerequisites[0].answer).toBe('answered');
    expect(run.prerequisites[1].answer).toBe('keep');
  });

  it('folds other info and answered prerequisites into the generation context', async () => {
    let capturedSetup = '';
    const generateTeam: BugBashGenerateTeam = {
      generate: async (request): Promise<BugBashGenerateResult> => {
        capturedSetup = request.setupInfo;
        return { agents: [], scenarios: [] };
      },
    };
    const { service } = makeService({
      ...seeded({
        setupInfo: 'run it',
        otherInfo: 'be careful',
        prerequisites: [
          { id: 'prereq-1', question: 'Which account?', detail: '', answer: 'acct-1' },
          { id: 'prereq-2', question: 'Unanswered?', detail: '', answer: '   ' },
        ],
      }),
      generateTeam,
    });
    await service.generate('a1');
    expect(capturedSetup).toContain('run it');
    expect(capturedSetup).toContain('Other information:\nbe careful');
    expect(capturedSetup).toContain('Q: Which account?\nA: acct-1');
    expect(capturedSetup).not.toContain('Unanswered?');
  });

  it('yields an empty context when nothing extra is provided', async () => {
    let capturedSetup = 'unset';
    const generateTeam: BugBashGenerateTeam = {
      generate: async (request): Promise<BugBashGenerateResult> => {
        capturedSetup = request.setupInfo;
        return { agents: [], scenarios: [] };
      },
    };
    const { service } = makeService({
      ...seeded({ setupInfo: '', otherInfo: '', prerequisites: [] }),
      generateTeam,
    });
    await service.generate('a1');
    expect(capturedSetup).toBe('');
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

  it('generates scenarios and streams the analyst team to the sink', async () => {
    const leadAnalyst: BugBashAgent = {
      ...ANALYST,
      id: 'analyst-lead',
      title: 'Lead analyst',
    };
    const subAnalyst: BugBashAgent = {
      ...ANALYST,
      id: 'analyst-1',
      parentId: 'analyst-lead',
      title: 'Analyst',
    };
    const { service, repo, emitted } = makeService({
      ...seeded({ status: 'draft' }),
      generateTeam: {
        generate: async (req) => {
          req.sink.activity({
            phase: 'generating',
            line: 'reading code',
            agentId: 'analyst-1',
          });
          req.sink.agent({ ...subAnalyst, status: 'running' });
          req.sink.scenario({ id: 'scenario-1', status: 'running' });
          req.sink.agent(subAnalyst);
          return {
            agents: [leadAnalyst, subAnalyst],
            scenarios: [
              {
                title: 'Empty',
                input: 'x',
                steps: ['a'],
                expectedOutput: 'err',
                confirmation: '',
              },
            ],
          };
        },
      },
    });
    const { sink, events } = makeSink();
    const run = await service.generate('a1', undefined, sink);

    expect(run.status).toBe('generated');
    expect(run.scenarios).toHaveLength(1);
    expect(run.scenarios[0].id).toBe('scenario-1');
    expect(run.scenarios[0].title).toBe('Empty');
    expect(run.agents.map((a) => a.id)).toEqual(['analyst-lead', 'analyst-1']);
    expect(run.agents.every((a) => a.role === 'analyst')).toBe(true);
    // The sub-agent's running/done snapshots reached the sink.
    expect(events.agents.map((a) => a.status)).toEqual(['running', 'done']);
    expect(events.scenarios).toEqual([
      { id: 'scenario-1', status: 'running' },
    ]);
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
      generateTeam: {
        generate: async () => ({
          agents: [],
          scenarios: [
            {
              title: 'One',
              input: '',
              steps: ['a'],
              expectedOutput: '',
              confirmation: '',
            },
            {
              title: 'Two',
              input: '',
              steps: ['b'],
              expectedOutput: '',
              confirmation: '',
            },
          ],
        }),
      },
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
      generateTeam: {
        generate: async () => {
          throw 'stringboom';
        },
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
      generateTeam: {
        generate: async () => {
          throw new Error('interrupted');
        },
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
      generateTeam: {
        generate: async () => {
          throw new Error('boom');
        },
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
      generateTeam: {
        generate: async () => {
          throw new Error('boom');
        },
      },
    });
    await expect(service.generate('a1')).rejects.toThrow('boom');
    expect(repo.map.get('a1')!.status).toBe('failed');
  });
});

describe('bug-bash-service: refine', () => {
  it('rejects a blank message', async () => {
    const { service } = makeService(seeded({ status: 'generated' }));
    await expect(service.refine('a1', [], '   ')).rejects.toThrow(
      'A message is required.',
    );
  });

  it('replies without changing scenarios when nothing is revised', async () => {
    const { service } = makeService({
      ...seeded({ status: 'generated', scenarios: [scenario()] }),
      runDetailed: async () => ({
        text: fence('{"reply":"Here is why","revised":null}'),
        sessionId: 'c',
      }),
    });
    const result = await service.refine(
      'a1',
      [{ role: 'user', content: 'why this?' }],
      'why this?',
    );
    expect(result.reply).toBe('Here is why');
    expect(result.run.scenarios).toHaveLength(1);
    expect(result.run.scenarios[0].title).toBe('A');
  });

  it('applies a revised scenario list and re-ids them', async () => {
    const { service, repo } = makeService({
      ...seeded({
        status: 'reported',
        scenarios: [scenario()],
        report: 'old report',
      }),
      runDetailed: async () => ({
        text: fence(
          JSON.stringify({
            reply: 'Updated',
            revised: {
              scenarios: [
                { title: 'New one', steps: ['x'] },
                { title: 'New two', steps: ['y'] },
              ],
            },
          }),
        ),
        sessionId: 'c',
      }),
    });
    const result = await service.refine('a1', [], 'add two scenarios');
    expect(result.reply).toBe('Updated');
    expect(result.run.scenarios.map((s) => s.id)).toEqual([
      'scenario-1',
      'scenario-2',
    ]);
    expect(result.run.status).toBe('generated');
    expect(result.run.report).toBeNull();
    expect(repo.map.get('a1')!.scenarios).toHaveLength(2);
  });

  it('ignores a revised payload that yields no scenarios', async () => {
    const { service } = makeService({
      ...seeded({ status: 'generated', scenarios: [scenario()] }),
      runDetailed: async () => ({
        text: fence('{"reply":"hm","revised":{"scenarios":[]}}'),
        sessionId: 'c',
      }),
    });
    const result = await service.refine('a1', [], 'clear them');
    expect(result.run.scenarios).toHaveLength(1);
    expect(result.run.status).toBe('generated');
  });

  it('ignores a non-object revised payload', async () => {
    const { service } = makeService({
      ...seeded({ status: 'generated', scenarios: [scenario()] }),
      runDetailed: async () => ({
        text: fence('{"reply":"ok","revised":"a string"}'),
        sessionId: 'c',
      }),
    });
    const result = await service.refine('a1', [], 'hello');
    expect(result.run.scenarios).toHaveLength(1);
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
          req.sink.scenario({ id: 'scenario-1', status: 'running' });
          req.sink.scenario({ id: 'scenario-1', status: 'pass' });
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
    expect(events.scenarios).toEqual([
      { id: 'scenario-1', status: 'running' },
      { id: 'scenario-1', status: 'pass' },
    ]);
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
    otherInfo: '',
    prerequisites: [],
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
