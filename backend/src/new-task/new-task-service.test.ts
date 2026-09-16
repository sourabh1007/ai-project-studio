import { describe, it, expect, vi } from 'vitest';
import { MetaAbortError } from '../meta/meta-runner.js';
import { NotFoundError } from '../kernel/error-types.js';
import {
  createNewTaskService,
  deriveTitle,
  derivePrBody,
  PR_BODY_MAX,
  type NewTaskServiceDeps,
} from './new-task-service.js';
import { newTaskDefaults } from './config.js';
import type {
  NewTaskFileChange,
  NewTaskImplementSink,
  NewTaskRun,
} from './new-task-contract.js';

function inMemoryRepo(): NewTaskServiceDeps['repo'] {
  const store = new Map<string, NewTaskRun>();
  return {
    get: (id) => store.get(id) ?? null,
    create: (run) => void store.set(run.id, run),
    update: (run) => void store.set(run.id, run),
    delete: (id) => void store.delete(id),
    deleteByFeature: (featureId) => {
      for (const [id, run] of store) {
        if (run.featureId === featureId) store.delete(id);
      }
    },
  };
}

function harness(overrides: Partial<NewTaskServiceDeps> = {}) {
  let tick = 0;
  const events: Array<{ phase: string; line: string }> = [];
  const deps: NewTaskServiceDeps = {
    repo: inMemoryRepo(),
    workspace: {
      resolve: () => ({
        repoId: 'r1',
        repoLocalPath: '/repo',
        baseBranch: 'main',
      }),
    },
    git: {
      prepareWorktree: async () => ({
        worktreePath: '/wt',
        branch: 'copilot/new-task-a1',
      }),
      worktreePathFor: () => '/wt',
      commitAll: async () => ({ committed: true, files: [] }),
      pushBranch: async () => undefined,
      changedFilesAgainst: async () => [],
      fileDiff: async () => ({ path: 'x', diff: '', content: '' }),
    },
    pr: {
      create: async () => ({ number: 99, url: 'https://x/pull/99' }),
    },
    reviews: {
      makeEligible: async ({ featureId }) => featureId,
    },
    config: newTaskDefaults,
    clock: {
      now: () => new Date(1_700_000_000_000 + tick * 1000),
      isoNow: () => `2026-01-01T00:00:0${tick++}.000Z`,
    },
    ai: {
      runDetailed: async (req) => {
        req.onActivity?.('working…');
        return { text: 'GENERATED', sessionId: 's1' };
      },
    },
    team: {
      implement: async ({ sink }) => {
        sink.activity({
          phase: 'implementing',
          line: 'team working…',
          agentId: 'manager',
        });
        const agents = [
          {
            id: 'manager',
            parentId: null,
            role: 'manager' as const,
            title: 'Lead agent',
            files: [],
            status: 'done' as const,
            startedAt: null,
            durationMs: 1,
            inputTokens: 1,
            outputTokens: 1,
            credits: null,
          },
        ];
        sink.agent(agents[0]);
        return { agents };
      },
    },
    bus: {
      emit: (_event, payload) =>
        events.push({ phase: payload.phase, line: payload.line }),
    },
    ...overrides,
  };
  return { deps, events, service: createNewTaskService(deps) };
}

function sink(): NewTaskImplementSink & {
  activities: Array<{ phase: string; line: string }>;
  agents: Array<{ id: string; role: string }>;
  finished: NewTaskRun | null;
  finishedFiles: NewTaskFileChange[] | undefined;
  failure: string | null;
} {
  const activities: Array<{ phase: string; line: string }> = [];
  const agents: Array<{ id: string; role: string }> = [];
  return {
    activities,
    agents,
    finished: null,
    finishedFiles: undefined,
    failure: null,
    activity(a) {
      activities.push(a);
    },
    agent(a) {
      agents.push({ id: a.id, role: a.role });
    },
    done(run, files) {
      this.finished = run;
      this.finishedFiles = files;
    },
    failed(error) {
      this.failure = error;
    },
  };
}

describe('deriveTitle / derivePrBody', () => {
  it('takes the first non-empty problem line', () => {
    expect(deriveTitle('\n  Fix the login bug  \nmore')).toBe('Fix the login bug');
  });

  it('falls back and clamps long titles', () => {
    expect(deriveTitle('   \n  ')).toBe('New task');
    const long = 'x'.repeat(100);
    const title = deriveTitle(long);
    expect(title.length).toBe(72);
    expect(title.endsWith('…')).toBe(true);
  });

  it('contains only the problem and the solution (the plan)', () => {
    const base: NewTaskRun = {
      id: 'a1', featureId: 'f1', problem: 'P', context: 'CTX', plan: 'PLAN',
      status: 'planned', branch: 'b', prNumber: null, prUrl: null,
      reviewFeatureId: null, error: null, agents: [],
      createdAt: 't', updatedAt: 't',
    };
    const body = derivePrBody(base);
    expect(body).toContain('## Problem');
    expect(body).toContain('P');
    expect(body).toContain('## Solution');
    expect(body).toContain('PLAN');
    // Nothing beyond the problem and solution belongs in the description.
    expect(body).not.toContain('## Context');
    expect(body).not.toContain('CTX');
    expect(body).not.toContain('## Changed files');
    expect(body).not.toContain('Opened by the New Task agent');
    expect(derivePrBody({ ...base, plan: null })).toContain('## Solution');
  });

  it('truncates a long plan to stay under the PR description limit', () => {
    const base: NewTaskRun = {
      id: 'a1', featureId: 'f1', problem: 'P', context: '', plan: 'x'.repeat(20_000),
      status: 'planned', branch: 'b', prNumber: null, prUrl: null,
      reviewFeatureId: null, error: null, agents: [],
      createdAt: 't', updatedAt: 't',
    };
    const body = derivePrBody(base);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body).toContain('plan truncated');
  });

  it('hard-clamps even when the fixed sections alone overflow', () => {
    const base: NewTaskRun = {
      id: 'a1', featureId: 'f1', problem: 'P'.repeat(5000), context: '', plan: 'PLAN',
      status: 'planned', branch: 'b', prNumber: null, prUrl: null,
      reviewFeatureId: null, error: null, agents: [],
      createdAt: 't', updatedAt: 't',
    };
    const body = derivePrBody(base);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body.endsWith('…')).toBe(true);
  });
});

describe('new-task-service saveInputs', () => {
  it('creates a draft run', () => {
    const { service } = harness();
    const run = service.saveInputs('a1', 'f1', { problem: ' P ', context: ' C ' });
    expect(run).toMatchObject({
      id: 'a1', featureId: 'f1', problem: 'P', context: 'C', status: 'draft',
    });
    expect(service.get('a1')).toEqual(run);
  });

  it('rejects an empty problem', () => {
    const { service } = harness();
    expect(() => service.saveInputs('a1', 'f1', { problem: '  ', context: '' })).toThrow(
      'problem statement is required',
    );
  });

  it('resets an existing draft, clearing its plan', () => {
    const { service } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P1', context: '' });
    const run = service.saveInputs('a1', 'f1', { problem: 'P2', context: '' });
    expect(run.problem).toBe('P2');
    expect(run.plan).toBeNull();
    expect(run.status).toBe('draft');
  });

  it('refuses to edit a task that already has a PR', () => {
    const { service, deps } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    deps.repo.update({ ...service.get('a1')!, status: 'pr-created' });
    expect(() => service.saveInputs('a1', 'f1', { problem: 'P2', context: '' })).toThrow(
      'already has an open pull request',
    );
  });
});

describe('new-task-service plan', () => {
  it('throws when there is no run', async () => {
    const { service } = harness();
    await expect(service.plan('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to plan once a PR exists', async () => {
    const { service, deps } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    deps.repo.update({ ...service.get('a1')!, status: 'pr-created' });
    await expect(service.plan('a1')).rejects.toThrow('already has an open pull request');
  });

  it('produces a plan, sets the branch and emits activity', async () => {
    const { service, events } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    const run = await service.plan('a1');
    expect(run.status).toBe('planned');
    expect(run.plan).toBe('GENERATED');
    expect(run.branch).toBe('copilot/new-task-a1');
    expect(events).toContainEqual({ phase: 'planning', line: 'working…' });
  });

  it('marks the run failed and rethrows on planner error', async () => {
    const { service } = harness({
      ai: { runDetailed: async () => { throw new Error('planner down'); } },
    });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    await expect(service.plan('a1')).rejects.toThrow('planner down');
    expect(service.get('a1')).toMatchObject({ status: 'failed', error: 'planner down' });
  });

  it('stringifies a non-Error planner failure', async () => {
    const { service } = harness({
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      ai: { runDetailed: async () => { throw 'string failure'; } },
    });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    await expect(service.plan('a1')).rejects.toBe('string failure');
    expect(service.get('a1')!.error).toBe('string failure');
  });

  it('streams planning activity and the settled run to a sink', async () => {
    const { service } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    const s = sink();
    const run = await service.plan('a1', undefined, s);
    expect(run.status).toBe('planned');
    expect(s.activities).toContainEqual({
      phase: 'planning',
      line: 'working…',
      agentId: 'planner',
    });
    expect(
      s.activities.some(
        (a) => a.phase === 'planning' && a.line.startsWith('📝 Prompt sent'),
      ),
    ).toBe(true);
    expect(s.finished).toMatchObject({ status: 'planned', plan: 'GENERATED' });
    expect(s.failure).toBeNull();
  });

  it('emits and persists a planner agent with metrics', async () => {
    const { service } = harness({
      ai: {
        runDetailed: async (req) => {
          req.onActivity?.('working…');
          return {
            text: 'GENERATED',
            sessionId: 's1',
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              nanoAiu: 2_000_000_000,
              credits: null,
            },
          };
        },
      },
    });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    const s = sink();
    const run = await service.plan('a1', undefined, s);
    expect(s.agents).toContainEqual({ id: 'planner', role: 'planner' });
    expect(run.agents).toHaveLength(1);
    expect(run.agents[0]).toMatchObject({
      id: 'planner',
      role: 'planner',
      status: 'done',
      inputTokens: 10,
      outputTokens: 5,
      credits: 2,
    });
    expect(run.agents[0].durationMs).not.toBeNull();
  });

  it('reports a planner failure through the sink instead of throwing', async () => {
    const { service } = harness({
      ai: { runDetailed: async () => { throw new Error('planner down'); } },
    });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    const s = sink();
    const run = await service.plan('a1', undefined, s);
    expect(run.status).toBe('failed');
    expect(s.failure).toBe('planner down');
    expect(s.finished).toBeNull();
  });

  it('cuts the branch from a configured base and folds in a suggestion', async () => {
    let seenBase = '';
    let seenPrompt = '';
    const { service } = harness({
      git: {
        prepareWorktree: async (input) => {
          seenBase = input.baseBranch;
          return { worktreePath: '/wt', branch: 'copilot/new-task-a1' };
        },
        worktreePathFor: () => '/wt',
        commitAll: async () => ({ committed: true, files: [] }),
        pushBranch: async () => undefined,
        changedFilesAgainst: async () => [],
        fileDiff: async () => ({ path: 'x', diff: '', content: '' }),
      },
      ai: {
        runDetailed: async (req) => {
          seenPrompt = req.prompt;
          return { text: 'GENERATED', sessionId: 's1' };
        },
      },
    });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    await service.plan('a1', undefined, undefined, {
      baseBranch: 'release/2.0',
      suggestion: 'Cover the null case',
    });
    expect(seenBase).toBe('release/2.0');
    expect(seenPrompt).toContain('Cover the null case');
  });

  it('re-plan passes the previous branch so git cuts a fresh one', async () => {
    let seenPrevious: string | undefined = 'unset';
    const { service } = harness({
      git: {
        prepareWorktree: async (input) => {
          seenPrevious = input.previousBranch;
          return { worktreePath: '/wt', branch: 'copilot/new-task-a1-r2' };
        },
        worktreePathFor: () => '/wt',
        commitAll: async () => ({ committed: true, files: [] }),
        pushBranch: async () => undefined,
        changedFilesAgainst: async () => [],
        fileDiff: async () => ({ path: 'x', diff: '', content: '' }),
      },
    });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    await service.plan('a1');
    expect(seenPrevious).toBeUndefined();
    await service.plan('a1');
    expect(seenPrevious).toBe('copilot/new-task-a1-r2');
  });

  it('treats a user-cancelled plan as a reset, not a failure (with sink)', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service } = harness({
      ai: { runDetailed: async () => { throw new Error('aborted'); } },
    });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    const s = sink();
    const run = await service.plan('a1', controller.signal, s);
    expect(s.failure).toBe('Planning was cancelled.');
    // The run is NOT marked failed — the cancel endpoint resets it to draft.
    expect(run.status).toBe('planning');
    expect(service.get('a1')!.status).toBe('planning');
  });

  it('a cancelled plan without a sink returns the un-failed run', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service } = harness({
      ai: { runDetailed: async () => { throw new Error('aborted'); } },
    });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    const run = await service.plan('a1', controller.signal);
    expect(run.status).toBe('planning');
  });
});

describe('new-task-service reset', () => {
  it('returns null when there is no run', () => {
    const { service } = harness();
    expect(service.reset('missing')).toBeNull();
  });

  it('reverts an in-flight run to a clean draft, keeping inputs and branch', () => {
    const { service, deps } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: 'C' });
    deps.repo.update({
      ...service.get('a1')!,
      status: 'planning',
      plan: 'DRAFT',
      error: 'oops',
      branch: 'b',
    });
    const run = service.reset('a1');
    expect(run).toMatchObject({
      status: 'draft',
      plan: null,
      error: null,
      problem: 'P',
      context: 'C',
      branch: 'b',
    });
  });

  it('leaves a shipped (pr-created) task unchanged', () => {
    const { service, deps } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    deps.repo.update({ ...service.get('a1')!, status: 'pr-created' });
    expect(service.reset('a1')?.status).toBe('pr-created');
  });
});

async function planned(service: ReturnType<typeof harness>['service']) {
  service.saveInputs('a1', 'f1', { problem: 'P', context: 'C' });
  await service.plan('a1');
}

describe('new-task-service fileDiff', () => {
  it('throws when there is no run', async () => {
    const { service } = harness();
    await expect(service.fileDiff('missing', 'src/a.ts')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rejects an empty path', async () => {
    const { service } = harness();
    await planned(service);
    await expect(service.fileDiff('a1', '   ')).rejects.toThrow(
      'A file path is required.',
    );
  });

  it('rejects a task that has no branch yet', async () => {
    const { service } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    await expect(service.fileDiff('a1', 'src/a.ts')).rejects.toThrow(
      'no branch yet',
    );
  });

  it('resolves the worktree and returns the git diff', async () => {
    let seen: unknown;
    const { service } = harness({
      git: {
        prepareWorktree: async () => ({
          worktreePath: '/wt',
          branch: 'copilot/new-task-a1',
        }),
        worktreePathFor: () => '/resolved-wt',
        commitAll: async () => ({ committed: true, files: [] }),
        pushBranch: async () => undefined,
        changedFilesAgainst: async () => [],
        fileDiff: async (input) => {
          seen = input;
          return { path: input.path, diff: 'DIFF', content: 'BODY' };
        },
      },
    });
    await planned(service);
    const result = await service.fileDiff('a1', '  src/a.ts  ');
    expect(seen).toEqual({
      worktreePath: '/resolved-wt',
      baseBranch: 'main',
      path: 'src/a.ts',
    });
    expect(result).toEqual({ path: 'src/a.ts', diff: 'DIFF', content: 'BODY' });
  });
});

describe('new-task-service implement', () => {
  it('throws when there is no run', async () => {
    const { service } = harness();
    await expect(service.implement('missing', sink())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('fails when a PR already exists', async () => {
    const { service, deps } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    deps.repo.update({ ...service.get('a1')!, status: 'pr-created' });
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toMatch(/already has an open pull request/);
  });

  it('fails when no plan has been approved', async () => {
    const { service } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toMatch(/Approve a plan/);
  });

  it('implements, opens a PR and becomes review-eligible', async () => {
    const { service } = harness();
    await planned(service);
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toBeNull();
    expect(s.finished).toMatchObject({
      status: 'pr-created',
      prNumber: 99,
      prUrl: 'https://x/pull/99',
      reviewFeatureId: 'f1',
    });
    expect(s.activities.map((a) => a.phase)).toContain('creating-pr');
    expect(s.activities.at(-1)).toEqual({
      phase: 'done',
      line: 'Opened pull request #99.',
    });
    expect(service.get('a1')!.status).toBe('pr-created');
  });

  it('implements via the team, forwarding agents and persisting them', async () => {
    const { service, events } = harness();
    await planned(service);
    const s = sink();
    await service.implement('a1', s);
    expect(s.agents).toContainEqual({ id: 'manager', role: 'manager' });
    expect(service.get('a1')!.agents).toContainEqual(
      expect.objectContaining({ id: 'manager', role: 'manager' }),
    );
    // Team activity is forwarded to both the sink and the bus.
    expect(s.activities).toContainEqual(
      expect.objectContaining({ line: 'team working…' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ line: 'team working…' }),
    );
  });

  it('retains the planner snapshot alongside the team after implementing', async () => {
    const { service } = harness();
    await planned(service);
    const s = sink();
    await service.implement('a1', s);
    const roles = service.get('a1')!.agents.map((a) => a.role);
    expect(roles).toContain('planner');
    expect(roles).toContain('manager');
  });

  it('resumes an interrupted implementation stuck in implementing', async () => {
    const { service, deps } = harness();
    await planned(service);
    deps.repo.update({ ...service.get('a1')!, status: 'implementing' });
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toBeNull();
    expect(service.get('a1')!.status).toBe('pr-created');
  });

  it('retries a failed run whose plan and branch survived', async () => {
    const { service, deps } = harness();
    await planned(service);
    deps.repo.update({
      ...service.get('a1')!,
      status: 'failed',
      error: 'PR description too long',
    });
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toBeNull();
    expect(service.get('a1')!.status).toBe('pr-created');
  });

  it('forwards the changed-file summary to the sink', async () => {
    const files: NewTaskFileChange[] = [
      { path: 'src/a.ts', changeType: 'modified' },
      { path: 'src/b.ts', changeType: 'added' },
    ];
    const { service } = harness({
      git: {
        prepareWorktree: async () => ({
          worktreePath: '/wt',
          branch: 'copilot/new-task-a1',
        }),
        worktreePathFor: () => '/wt',
        commitAll: async () => ({ committed: true, files }),
        pushBranch: async () => undefined,
        changedFilesAgainst: async () => [],
        fileDiff: async () => ({ path: 'x', diff: '', content: '' }),
      },
    });
    await planned(service);
    const s = sink();
    await service.implement('a1', s);
    expect(s.finishedFiles).toEqual(files);
  });

  it('recovers a branch a prior attempt already committed', async () => {
    const files: NewTaskFileChange[] = [
      { path: 'src/c.ts', changeType: 'modified' },
    ];
    const { service } = harness({
      git: {
        prepareWorktree: async () => ({ worktreePath: '/wt', branch: 'b' }),
        worktreePathFor: () => '/wt',
        commitAll: async () => ({ committed: false, files: [] }),
        pushBranch: async () => undefined,
        changedFilesAgainst: async () => files,
        fileDiff: async () => ({ path: 'x', diff: '', content: '' }),
      },
    });
    await planned(service);
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toBeNull();
    expect(service.get('a1')!.status).toBe('pr-created');
    expect(s.finishedFiles).toEqual(files);
  });

  it('fails when the implementation made no changes', async () => {
    const { service } = harness({
      git: {
        prepareWorktree: async () => ({ worktreePath: '/wt', branch: 'b' }),
        worktreePathFor: () => '/wt',
        commitAll: async () => ({ committed: false, files: [] }),
        pushBranch: async () => undefined,
        changedFilesAgainst: async () => [],
        fileDiff: async () => ({ path: 'x', diff: '', content: '' }),
      },
    });
    await planned(service);
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toMatch(/no file changes/);
    expect(service.get('a1')!.status).toBe('failed');
  });

  it('reports a cancelled implementation', async () => {
    const { service } = harness({
      team: {
        implement: async () => {
          throw new MetaAbortError({ kind: 'aborted', termination: 'confirmed' });
        },
      },
    });
    await planned(service);
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toMatch(/cancelled/);
  });

  it('treats a user-cancelled implementation as a reset, not a failure', async () => {
    const { service } = harness({
      team: {
        implement: async () => {
          throw new Error('aborted');
        },
      },
    });
    await planned(service);
    const controller = new AbortController();
    controller.abort();
    const s = sink();
    await service.implement('a1', s, controller.signal);
    expect(s.failure).toBe('Implementation was cancelled.');
    // Not marked failed — the cancel endpoint resets it to draft.
    expect(service.get('a1')!.status).toBe('implementing');
  });

  it('surfaces a generic failure from opening the PR', async () => {
    const { service } = harness({
      pr: { create: async () => { throw new Error('gh exploded'); } },
    });
    await planned(service);
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toBe('gh exploded');
  });

  it('fails a planned run missing its branch', async () => {
    const { service, deps } = harness();
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    deps.repo.update({
      ...service.get('a1')!,
      status: 'planned',
      plan: 'PLAN',
      branch: null,
    });
    const s = sink();
    await service.implement('a1', s);
    expect(s.failure).toMatch(/Approve a plan/);
  });

  it('passes the abort signal through to the planner', async () => {
    const runDetailed = vi.fn(async () => ({ text: 'X', sessionId: 's' }));
    const { service } = harness({ ai: { runDetailed } });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    const controller = new AbortController();
    await service.plan('a1', controller.signal);
    expect(runDetailed.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it('requests the auto model so planning stays warm-pool eligible', async () => {
    const runDetailed = vi.fn(async () => ({ text: 'X', sessionId: 's' }));
    const { service } = harness({ ai: { runDetailed } });
    service.saveInputs('a1', 'f1', { problem: 'P', context: '' });
    await service.plan('a1');
    expect(runDetailed.mock.calls[0][0]).toMatchObject({
      scope: 'internal',
      model: 'auto',
    });
  });
});

describe('new-task-service get', () => {
  it('returns null for an unknown attachment', () => {
    const { service } = harness();
    expect(service.get('nope')).toBeNull();
  });
});
