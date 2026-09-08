import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceAdmin } from '../workspace/workspace-admin-service.js';
import { createFeatureRoutes } from './feature-controller.js';
import { createSummaryRoutes } from './summary-controller.js';
import { createFeatureTasksRoutes } from './feature-tasks-controller.js';
import type { HttpRequest, Route } from './http-contract.js';
import {
  applyRouteOwnership,
  ownApplicationRoutes,
  type ApplicationRouteOwner,
  type RouteOwnershipDeps,
} from './route-ownership.js';
import { createDatabase } from '../persistence/db/connection.js';
import { createFeatureRepo } from '../persistence/feature-repo.js';
import { createSessionRepo } from '../persistence/session-repo.js';
import { createFeatureTasksRepo } from '../persistence/feature-tasks-repo.js';
import { createFeatureService } from '../feature/feature-service.js';
import { createFeatureTasksService } from '../feature-tasks/feature-tasks-service.js';
import { createClock } from '../kernel/clock.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { featureTasksDefaults } from '../feature-tasks/config.js';
import { requireQuiescence } from '../lifecycle/quiescence.js';
import {
  createApplicationWork,
  type ApplicationWorkOwnership,
  type ApplicationWorkScope,
} from '../lifecycle/application-work.js';
import type { Feature } from '../feature/feature-contract.js';
import type { Session } from '../session/session-contract.js';
import type { FeatureTask } from '../feature-tasks/feature-tasks-contract.js';
import type { TreeGroup } from '../feature-tree/feature-tree-contract.js';
import type { FeatureSummary } from '../summarizer/summarizer-contract.js';
import type { SkillAttachment } from '../skills/skills-contract.js';
import type { Automation, Subagent } from '../automation/automation-contract.js';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

function routeMap(routes: readonly Route[]): Map<string, Route> {
  return new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
}

function featureRecord(id: string): Feature {
  return {
    id,
    name: id,
    description: `${id}-description`,
    createdAt: '2026-01-01T00:00:00.000Z',
    summary: null,
    repoId: null,
    checkoutPath: null,
    parentFeatureId: null,
  };
}

function sessionRecord(id: string, featureId: string): Session {
  return {
    id,
    featureId,
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'completed',
    kind: 'dev',
    prompt: '',
    usageFilePath: `usage/${id}.jsonl`,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
  };
}

function taskRecord(id: string, featureId: string): FeatureTask {
  return {
    id,
    featureId,
    title: id,
    detail: '',
    status: 'pending',
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function groupRecord(id: string, featureId: string): TreeGroup {
  return {
    id,
    featureId,
    parentGroupId: null,
    kind: 'subcategory',
    name: id,
    prNumber: null,
    prUrl: null,
    orderIndex: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function attachmentRecord(id: string, scope: 'feature' | 'session', targetId: string): SkillAttachment {
  return {
    id,
    skillId: `skill-for-${id}`,
    scope,
    targetId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function automationRecord(): Automation {
  return {
    id: 'automation-1',
    name: 'Watch CI',
    mode: 'long',
    status: 'active',
    origin: { featureId: 'feature-1', sessionId: 'session-1' },
    check: { type: 'shell', command: 'echo' },
    condition: { type: 'always' },
    action: { type: 'report', prompt: 'go' },
    intervalMs: 60_000,
    maxRuns: null,
    runCount: 0,
    progress: null,
    plannedSteps: [],
    lastOccurrenceKey: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastCheckedAt: null,
    nextRunAt: null,
    failure: null,
    uncertainty: null,
  };
}

function subagentRecord(): Subagent {
  return {
    id: 'subagent-1',
    automationId: null,
    origin: { featureId: 'feature-2', sessionId: null },
    task: 'follow up',
    status: 'running',
    progress: null,
    result: null,
    sessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function ownershipDeps(): RouteOwnershipDeps {
  return {
    features: {
      get: vi.fn((id: string) => featureRecord(id)),
    },
    sessions: {
      get: vi.fn((id: string) =>
        id === 'session-1'
          ? sessionRecord(id, 'feature-1')
          : id === 'session-2'
            ? sessionRecord(id, 'feature-2')
            : null),
    },
    taskLookup: {
      get: vi.fn((id: string) =>
        id === 'task-1' ? taskRecord(id, 'feature-1') : null),
    },
    groupLookup: {
      get: vi.fn((id: string) =>
        id === 'group-1' ? groupRecord(id, 'feature-1') : null),
    },
    skills: {
      getAttachment: vi.fn((id: string) =>
        id === 'attachment-1'
          ? attachmentRecord(id, 'session', 'session-1')
          : id === 'attachment-feature'
            ? attachmentRecord(id, 'feature', 'feature-2')
          : null),
    },
    automations: {
      get: vi.fn(() => automationRecord()),
    },
    subagents: {
      get: vi.fn(() => subagentRecord()),
    },
  };
}

describe('route ownership', () => {
  it('resolves ownership scopes for feature, session, move, and automation mutations', async () => {
    const deps = ownershipDeps();
    const routes = routeMap(applyRouteOwnership([
      { method: 'delete', path: '/features/:id', handler: () => ({ status: 200, body: null }) },
      { method: 'delete', path: '/sessions/:id', handler: () => ({ status: 200, body: null }) },
      { method: 'post', path: '/tree/move', handler: () => ({ status: 200, body: null }) },
      { method: 'post', path: '/features/:featureId/tasks', handler: () => ({ status: 200, body: null }) },
      { method: 'post', path: '/automations', handler: () => ({ status: 200, body: null }) },
      { method: 'post', path: '/automations/:id/subagents', handler: () => ({ status: 200, body: null }) },
      { method: 'delete', path: '/skills/attachments/:attachmentId', handler: () => ({ status: 200, body: null }) },
      { method: 'put', path: '/context/:scope', handler: () => ({ status: 200, body: null }) },
    ], deps));

    await expect(Promise.resolve(routes.get('delete /features/:id')!.workScope!(request({
      params: { id: 'feature-1' },
    })))).resolves.toEqual({ featureId: 'feature-1' });
    await expect(Promise.resolve(routes.get('delete /features/:id')!.workTrackScope!(request())))
      .resolves.toEqual({});
    await expect(Promise.resolve(routes.get('delete /sessions/:id')!.workScope!(request({
      params: { id: 'session-1' },
    })))).resolves.toEqual({ featureId: 'feature-1', sessionId: 'session-1' });
    await expect(Promise.resolve(routes.get('delete /sessions/:id')!.workTrackScope!(request())))
      .resolves.toEqual({});
    await expect(Promise.resolve(routes.get('post /tree/move')!.workScope!(request({
      body: {
        type: 'session',
        id: 'session-1',
        targetFeatureId: 'feature-2',
        targetParentGroupId: null,
        targetIndex: 0,
      },
    })))).resolves.toEqual({ featureIds: ['feature-1', 'feature-2'], sessionId: 'session-1' });
    await expect(Promise.resolve(routes.get('post /tree/move')!.workScope!(request({
      body: {
        type: 'group',
        id: 'group-1',
        targetFeatureId: 'feature-2',
        targetParentGroupId: null,
        targetIndex: 0,
      },
    })))).resolves.toEqual({ featureIds: ['feature-1', 'feature-2'] });
    await expect(Promise.resolve(routes.get('post /features/:featureId/tasks')!.workScope!(request({
      params: { featureId: 'feature-1' },
    })))).resolves.toEqual({ featureId: 'feature-1' });
    await expect(Promise.resolve(routes.get('post /automations')!.workScope!(request({
      body: {
        name: 'Watch CI',
        mode: 'long',
        check: { type: 'shell', command: 'echo' },
        condition: { type: 'always' },
        action: { type: 'report', prompt: 'go' },
      },
    })))).resolves.toEqual({});
    await expect(Promise.resolve(routes.get('post /automations/:id/subagents')!.workScope!(request({
      params: { id: 'automation-1' },
      body: {
        task: 'follow up',
        origin: { featureId: 'feature-2', sessionId: 'session-2' },
      },
    })))).resolves.toEqual({
      featureIds: ['feature-1', 'feature-2'],
      sessionIds: ['session-1', 'session-2'],
    });
    await expect(Promise.resolve(routes.get('delete /skills/attachments/:attachmentId')!.workScope!(request({
      params: { attachmentId: 'attachment-1' },
    })))).resolves.toEqual({ sessionId: 'session-1' });
    await expect(Promise.resolve(routes.get('put /context/:scope')!.workScope!(request({
      params: { scope: 'feature' },
      body: { scopeId: 'feature-9' },
    })))).resolves.toEqual({ featureId: 'feature-9' });
    await expect(Promise.resolve(routes.get('put /context/:scope')!.workScope!(request({
      params: { scope: 'workspace' },
      body: { scopeId: '' },
    })))).resolves.toEqual({});
  });

  it('passes admission scope separately from tracking scope for deletes', async () => {
    const calls: unknown[] = [];
    const ownerController = new AbortController();
    const requestController = new AbortController();
    let deliveredSignal: AbortSignal | undefined;
    const owner: ApplicationRouteOwner = {
      own: async <T>(
        run: (signal: AbortSignal) => T | Promise<T>,
        scope?: ApplicationWorkScope,
        ownership?: ApplicationWorkOwnership,
      ): Promise<T> => {
        calls.push([scope, ownership]);
        return await run(ownerController.signal);
      },
    };
    const [route] = ownApplicationRoutes(
      applyRouteOwnership([
        {
          method: 'delete',
          path: '/features/:id',
          handler: (request) => {
            deliveredSignal = request.signal;
            return { status: 200, body: { ok: true } };
          },
        },
      ], ownershipDeps()),
      owner,
    );

    await expect(route.handler(request({
      params: { id: 'feature-1' },
      signal: requestController.signal,
    }))).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(deliveredSignal).not.toBe(ownerController.signal);
    ownerController.abort();
    expect(deliveredSignal?.aborted).toBe(true);
    expect(deliveredSignal?.reason).toBe(ownerController.signal.reason);
    expect(calls).toEqual([[
      { featureId: 'feature-1' },
      { trackScope: {}, allowBlockedScope: true },
    ]]);
  });

  it('defaults unowned routes to empty admission and tracking scopes', async () => {
    const calls: unknown[] = [];
    const owner: ApplicationRouteOwner = {
      own: async <T>(
        run: (signal: AbortSignal) => T | Promise<T>,
        scope?: ApplicationWorkScope,
        ownership?: ApplicationWorkOwnership,
      ): Promise<T> => {
        calls.push([scope, ownership]);
        return await run(new AbortController().signal);
      },
    };
    const [route] = ownApplicationRoutes([
      {
        method: 'post',
        path: '/skills/import',
        handler: () => ({ status: 201, body: { ok: true } }),
      },
    ], owner);

    await expect(route.handler(request({ body: { any: true } }))).resolves.toEqual({
      status: 201,
      body: { ok: true },
    });
    expect(calls).toEqual([[{}, { trackScope: {}, allowBlockedScope: false }]]);
  });

  it('covers resolver edge cases and missing lookup failures', async () => {
    const deps = ownershipDeps();
    const routes = routeMap(applyRouteOwnership([
      { method: 'post', path: '/features/:id/move', handler: () => ({ status: 200, body: null }) },
      { method: 'post', path: '/skills/:id/attachments', handler: () => ({ status: 200, body: null }) },
      { method: 'delete', path: '/skills/attachments/:attachmentId', handler: () => ({ status: 200, body: null }) },
      { method: 'put', path: '/tasks/:taskId', handler: () => ({ status: 200, body: null }) },
      { method: 'put', path: '/groups/:groupId', handler: () => ({ status: 200, body: null }) },
      { method: 'post', path: '/subagents/:id/progress', handler: () => ({ status: 200, body: null }) },
      { method: 'post', path: '/repos/:id/pulls', handler: () => ({ status: 200, body: null }) },
      { method: 'post', path: '/tree/move', handler: () => ({ status: 200, body: null }) },
      { method: 'post', path: '/skills/import', handler: () => ({ status: 200, body: null }) },
    ], deps));

    await expect(Promise.resolve(routes.get('post /features/:id/move')!.workScope!(request({
      params: { id: 'feature-1' },
      body: { targetParentFeatureId: 'feature-2' },
    })))).resolves.toEqual({ featureIds: ['feature-1', 'feature-2'] });
    await expect(Promise.resolve(routes.get('post /skills/:id/attachments')!.workScope!(request({
      body: { scope: 'feature', targetId: 'feature-1' },
    })))).resolves.toEqual({ featureId: 'feature-1' });
    await expect(Promise.resolve(routes.get('post /skills/:id/attachments')!.workScope!(request({
      body: { scope: 'session', targetId: 'session-1' },
    })))).resolves.toEqual({ sessionId: 'session-1' });
    await expect(Promise.resolve(routes.get('post /skills/:id/attachments')!.workScope!(request({
      body: { scope: 'unknown', targetId: 'session-1' },
    })))).resolves.toEqual({});
    await expect(Promise.resolve(routes.get('post /skills/:id/attachments')!.workScope!(request({
      body: {},
    })))).resolves.toEqual({});
    await expect(Promise.resolve(routes.get('put /tasks/:taskId')!.workScope!(request({
      params: { taskId: 'task-1' },
    })))).resolves.toEqual({ featureId: 'feature-1' });
    await expect(Promise.resolve(routes.get('delete /skills/attachments/:attachmentId')!.workScope!(request({
      params: { attachmentId: 'attachment-feature' },
    })))).resolves.toEqual({ featureId: 'feature-2' });
    await expect(Promise.resolve(routes.get('post /subagents/:id/progress')!.workScope!(request({
      params: { id: 'subagent-1' },
    })))).resolves.toEqual({ featureId: 'feature-2' });
    await expect(Promise.resolve(routes.get('post /repos/:id/pulls')!.workScope!(request({
      body: { parentFeatureId: 'feature-2' },
    })))).resolves.toEqual({ featureId: 'feature-2' });
    await expect(Promise.resolve(routes.get('post /repos/:id/pulls')!.workScope!(request({
      body: {},
    })))).resolves.toEqual({});
    await expect(Promise.resolve(routes.get('post /tree/move')!.workScope!(request({
      body: undefined,
    })))).resolves.toEqual({});
    await expect(Promise.resolve(routes.get('post /tree/move')!.workScope!(request({
      body: {
        type: 'session',
        targetFeatureId: 'feature-2',
      },
    })))).resolves.toEqual({ featureId: 'feature-2' });
    await expect(Promise.resolve(routes.get('post /tree/move')!.workScope!(request({
      body: {
        type: 'session',
      },
    })))).resolves.toEqual({});
    await expect(Promise.resolve(routes.get('post /tree/move')!.workScope!(request({
      body: {
        type: 'other',
        id: 'mystery',
        targetFeatureId: 'feature-2',
      },
    })))).resolves.toEqual({ featureId: 'feature-2' });
    expect(routes.get('post /skills/import')!.workScope).toBeUndefined();

    await expect(Promise.resolve().then(() => routes.get('put /tasks/:taskId')!.workScope!(request({
      params: { taskId: 'missing-task' },
    })))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(Promise.resolve().then(() => routes.get('put /groups/:groupId')!.workScope!(request({
      params: { groupId: 'missing-group' },
    })))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(Promise.resolve().then(() => applyRouteOwnership([
      { method: 'delete', path: '/sessions/:id', handler: () => ({ status: 200, body: null }) },
    ], deps)[0].workScope!(request({
      params: { id: 'missing-session' },
    })))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(Promise.resolve().then(() => routes.get('delete /skills/attachments/:attachmentId')!.workScope!(request({
      params: { attachmentId: 'missing-attachment' },
    })))).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('blocks late same-feature writes during delete while unrelated feature work stays usable', async () => {
    let featureIds = 0;
    let taskIds = 0;
    const clock = createClock(() => Date.parse('2026-01-01T00:00:00.000Z'));
    const db = createDatabase({ databasePath: ':memory:' });
    const featureRepo = createFeatureRepo(db);
    const sessionRepo = createSessionRepo(db);
    const tasksRepo = createFeatureTasksRepo(db);
    const features = createFeatureService({
      repo: featureRepo,
      ids: createIdGenerator(() => `feature-${++featureIds}`),
      clock,
      repos: { get: () => ({ id: 'repo-1' }) },
    });
    const featureA = features.create({ name: 'A', description: 'alpha' });
    const featureB = features.create({ name: 'B', description: 'beta' });
    const tasks = createFeatureTasksService({
      repo: tasksRepo,
      runner: { generate: async () => [] },
      features,
      ids: createIdGenerator(() => `task-${++taskIds}`),
      clock,
      config: featureTasksDefaults,
    });
    const applicationWork = createApplicationWork();
    const admin = createWorkspaceAdmin({
      features,
      sessions: sessionRepo,
      quiescence: {
        feature: (id) => requireQuiescence([() => applicationWork.quiesceFeature(id, 100)]),
        session: (id) => requireQuiescence([() => applicationWork.quiesceSession(id, 100)]),
      },
      usage: { deleteBySession: () => {} },
      transcripts: { delete: async () => {} },
      summaries: { delete: () => {} },
      sessionFiles: { deleteBySession: () => {} },
      terminals: { close: () => {} },
    });
    let releaseAbort!: () => void;
    const abortSettled = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    let summarySignal!: AbortSignal;
    const summarizer = {
      summarize: vi.fn(async ({ signal }: { signal?: AbortSignal }): Promise<FeatureSummary> => {
        summarySignal = signal!;
        return await new Promise<FeatureSummary>((_, reject) => {
          signal?.addEventListener('abort', () => {
            void abortSettled.then(() => reject(signal.reason));
          }, { once: true });
        });
      }),
    };
    const routes = routeMap(ownApplicationRoutes(applyRouteOwnership([
      ...createFeatureRoutes({ features, admin }),
      ...createSummaryRoutes({
        summarizer,
        summaries: { save: () => {}, load: () => null, delete: () => {} },
      }),
      ...createFeatureTasksRoutes({ tasks }),
    ], {
      ...ownershipDeps(),
      features,
      sessions: sessionRepo,
      taskLookup: tasksRepo,
    }), applicationWork));

    const inFlight = routes.get('post /features/:featureId/summary')!.handler(request({
      params: { featureId: featureA.id },
    }));
    await Promise.resolve();

    let deleted = false;
    const deleting = Promise.resolve(routes.get('delete /features/:id')!.handler(request({
      params: { id: featureA.id },
    }))).then((result) => {
      deleted = true;
      return result;
    });
    await Promise.resolve();

    await expect(routes.get('post /features/:featureId/tasks')!.handler(request({
      params: { featureId: featureA.id },
      body: { title: 'blocked' },
    }))).rejects.toMatchObject({ kind: 'conflict' });
    const allowed = await routes.get('post /features/:featureId/tasks')!.handler(request({
      params: { featureId: featureB.id },
      body: { title: 'allowed' },
    }));
    expect(allowed.status).toBe(201);
    expect(deleted).toBe(false);
    expect(summarySignal.aborted).toBe(true);

    releaseAbort();
    await expect(inFlight).rejects.toBe(summarySignal.reason);
    await expect(deleting).resolves.toEqual({ status: 200, body: { id: featureA.id } });

    expect(features.get(featureB.id).id).toBe(featureB.id);
    expect(() => features.get(featureA.id)).toThrow(/Unknown feature/);
    expect(tasksRepo.listByFeature(featureA.id)).toEqual([]);
    expect(tasksRepo.listByFeature(featureB.id)).toHaveLength(1);
  });

  it('keeps ordinary producers blocked after a failed delete but allows a later delete retry', async () => {
    let featureIds = 0;
    let taskIds = 0;
    const clock = createClock(() => Date.parse('2026-01-01T00:00:00.000Z'));
    const db = createDatabase({ databasePath: ':memory:' });
    const featureRepo = createFeatureRepo(db);
    const sessionRepo = createSessionRepo(db);
    const tasksRepo = createFeatureTasksRepo(db);
    const features = createFeatureService({
      repo: featureRepo,
      ids: createIdGenerator(() => `feature-${++featureIds}`),
      clock,
      repos: { get: () => ({ id: 'repo-1' }) },
    });
    const featureA = features.create({ name: 'A', description: 'alpha' });
    const featureB = features.create({ name: 'B', description: 'beta' });
    const tasks = createFeatureTasksService({
      repo: tasksRepo,
      runner: { generate: async () => [] },
      features,
      ids: createIdGenerator(() => `task-${++taskIds}`),
      clock,
      config: featureTasksDefaults,
    });
    const applicationWork = createApplicationWork();
    let providerDrained = false;
    let providerQuiesceCalls = 0;
    const admin = createWorkspaceAdmin({
      features,
      sessions: sessionRepo,
      quiescence: {
        feature: (id) => requireQuiescence([
          () => applicationWork.quiesceFeature(id, 1),
          async () => {
            providerQuiesceCalls += 1;
            return providerDrained;
          },
        ]),
        session: (id) => requireQuiescence([() => applicationWork.quiesceSession(id, 1)]),
      },
      usage: { deleteBySession: () => {} },
      transcripts: { delete: async () => {} },
      summaries: { delete: () => {} },
      sessionFiles: { deleteBySession: () => {} },
      terminals: { close: () => {} },
    });
    const routes = routeMap(ownApplicationRoutes(applyRouteOwnership([
      ...createFeatureRoutes({ features, admin }),
      ...createFeatureTasksRoutes({ tasks }),
    ], {
      ...ownershipDeps(),
      features,
      sessions: sessionRepo,
      taskLookup: tasksRepo,
    }), applicationWork));

    await expect(routes.get('delete /features/:id')!.handler(request({
      params: { id: featureA.id },
    }))).rejects.toMatchObject({ kind: 'conflict' });
    expect(providerQuiesceCalls).toBe(1);

    await expect(routes.get('post /features/:featureId/tasks')!.handler(request({
      params: { featureId: featureA.id },
      body: { title: 'still blocked' },
    }))).rejects.toMatchObject({ kind: 'conflict' });
    const unrelated = await routes.get('post /features/:featureId/tasks')!.handler(request({
      params: { featureId: featureB.id },
      body: { title: 'unrelated still works' },
    }));
    expect(unrelated.status).toBe(201);

    providerDrained = true;
    await expect(routes.get('post /features/:featureId/tasks')!.handler(request({
      params: { featureId: featureA.id },
      body: { title: 'blocked until retry' },
    }))).rejects.toMatchObject({ kind: 'conflict' });

    await expect(routes.get('delete /features/:id')!.handler(request({
      params: { id: featureA.id },
    }))).resolves.toEqual({ status: 200, body: { id: featureA.id } });
    expect(providerQuiesceCalls).toBe(2);
    expect(() => features.get(featureA.id)).toThrow(/Unknown feature/);
  });
});
