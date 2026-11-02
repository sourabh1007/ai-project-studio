import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../persistence/db/connection.js';
import { createFeatureRepo } from '../persistence/feature-repo.js';
import { createFeatureGroupsRepo } from '../persistence/feature-groups-repo.js';
import { createFeatureTreeService } from '../feature-tree/feature-tree-service.js';
import { featureTreeDefaults } from '../feature-tree/config.js';
import { createFeatureTreeRoutes } from './feature-tree-controller.js';
import { mountRoutes } from './express-adapter.js';
import { createAgentAttachmentRepo } from '../persistence/agent-attachment-repo.js';
import { createSessionRepo } from '../persistence/session-repo.js';
import { createClientOperationRepo } from '../persistence/client-operation-repo.js';
import { createSqliteUnitOfWork } from '../persistence/sqlite-unit-of-work.js';
import { createFeatureService } from '../feature/feature-service.js';
import { createFeatureRoutes } from './feature-controller.js';
import { createTerminalRoutes } from './terminal-controller.js';
import { createAgentRoutes } from './agent-controller.js';
import { createAgentService } from '../agents/agent-service.js';
import { createAgentRegistry } from '../agents/agent-registry.js';
import { createSessionFactory } from '../session/session-factory.js';
import { createClientOperations } from '../client-operations/client-operations-service.js';
import { clientOperationsDefaults } from '../client-operations/config.js';
import type { HttpRequest, Route } from './http-contract.js';

const KEY = 'idempotency-key';
let seq = 0;
const ids = { next: () => `id-${++seq}` };
const clock = { isoNow: () => '2026-01-01T00:00:00.000Z', now: () => new Date('2026-01-01T00:00:00.000Z') } as never;
const sessionConfig = { defaultKind: 'dev' as const, usageDir: 'C:/u', usageFileExtension: '.jsonl' };

function req(over: Partial<HttpRequest>): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...over };
}
function find(routes: Route[], method: string, path: string): Route['handler'] {
  return routes.find((r) => r.method === method && r.path === path)!.handler;
}
/** A fresh service over the same database simulates a backend restart. */
function operationsOn(db: DatabaseSync) {
  return createClientOperations({
    repo: createClientOperationRepo(db),
    unitOfWork: createSqliteUnitOfWork(db),
    clock,
    config: clientOperationsDefaults,
  });
}

function featureRoutes(db = createDatabase({ databasePath: ':memory:' })) {
  const features = createFeatureService({
    repo: createFeatureRepo(db), ids, clock, repos: { get: () => ({}) }, groups: { get: () => null },
  } as never);
  return { routes: createFeatureRoutes({ features, admin: {} as never, operations: operationsOn(db) }), features, db };
}

describe('feature create idempotency', () => {
  const body = { name: 'Alpha', description: 'd' };

  it('preserves every existing subcategory when HTTP creates a feature inside one, including after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'feature-owner-'));
    const databasePath = join(root, 'test.db');
    const h = featureRoutes(createDatabase({ databasePath }));
    let initialClosed = false;
    const owner = h.features.create(body);
    const groups = createFeatureGroupsRepo(h.db);
    const tree = createFeatureTreeService({
      groups, sessions: createSessionRepo(h.db), features: h.features,
      ids, clock, config: featureTreeDefaults,
    });
    const folder = tree.createGroup({ featureId: owner.id, kind: 'subcategory', name: 'Work' });
    tree.createGroup({ featureId: owner.id, parentGroupId: folder.id, kind: 'subcategory', name: 'Nested work' });
    tree.createGroup({ featureId: owner.id, kind: 'subcategory', name: 'Other work' });
    const original = tree.listGroups(owner.id);
    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountRoutes(router, [...h.routes, ...createFeatureTreeRoutes({ tree })]);
    app.use('/api', router);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    try {
      const response = await fetch(`${base}/features`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', [KEY]: 'subcategory-create-op' },
        body: JSON.stringify({ name: 'Child', description: '', parentGroupId: folder.id }),
      });
      expect(response.status).toBe(201);
      const child = await response.json() as { id: string; parentGroupId: string };
      expect(child.parentGroupId).toBe(folder.id);
      expect(await fetch(`${base}/features/${owner.id}/groups`).then((result) => result.json())).toEqual(original);
      expect(await fetch(`${base}/features/${child.id}/groups`).then((result) => result.json())).toEqual([]);
      const replay = await fetch(`${base}/features`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', [KEY]: 'subcategory-create-op' },
        body: JSON.stringify({ name: 'Child', description: '', parentGroupId: folder.id }),
      });
      expect(await replay.json()).toEqual(child);
      expect(h.features.list()).toHaveLength(2);
      h.db.close();
      initialClosed = true;
      const restarted = featureRoutes(createDatabase({ databasePath }));
      try {
        const persisted = createFeatureGroupsRepo(restarted.db);
        expect(restarted.features.get(child.id).parentGroupId).toBe(folder.id);
        expect(persisted.listByFeature(owner.id)).toEqual(original);
        expect(persisted.listByFeature(child.id)).toEqual([]);
      } finally {
        restarted.db.close();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (!initialClosed) h.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replays the same feature for the same key', async () => {
    const { routes, features } = featureRoutes();
    const post = find(routes, 'post', '/features');
    const first = await post(req({ body, headers: { [KEY]: 'op-1' } }));
    const retry = await post(req({ body, headers: { [KEY]: 'op-1' } }));
    expect(features.list()).toHaveLength(1);
    expect(retry).toEqual(first);
    expect(first.status).toBe(201);
  });

  it('replays after a backend restart (new service, same database)', async () => {
    const first = featureRoutes();
    const created = await find(first.routes, 'post', '/features')(req({ body, headers: { [KEY]: 'op-r' } }));
    const restarted = featureRoutes(first.db);
    const retry = await find(restarted.routes, 'post', '/features')(req({ body, headers: { [KEY]: 'op-r' } }));
    expect(restarted.features.list()).toHaveLength(1);
    expect(retry).toEqual(created);
  });

  it('conflicts when the same key is reused with different input', async () => {
    const { routes, features } = featureRoutes();
    const post = find(routes, 'post', '/features');
    await post(req({ body, headers: { [KEY]: 'op-2' } }));
    await expect(Promise.resolve().then(() => post(req({ body: { ...body, name: 'Beta' }, headers: { [KEY]: 'op-2' } }))))
      .rejects.toMatchObject({ kind: 'conflict', details: { code: 'operation_key_conflict' } });
    expect(features.list()).toHaveLength(1);
  });

  it('still creates distinct features without a key or with different keys', async () => {
    const { routes, features } = featureRoutes();
    const post = find(routes, 'post', '/features');
    await post(req({ body }));
    await post(req({ body }));
    await post(req({ body, headers: { [KEY]: 'k-a' } }));
    await post(req({ body, headers: { [KEY]: 'k-b' } }));
    expect(features.list()).toHaveLength(4);
  });

  it('rejects a malformed key before creating anything', async () => {
    const { routes, features } = featureRoutes();
    await expect(Promise.resolve().then(() => find(routes, 'post', '/features')(req({ body, headers: { [KEY]: 'bad key!' } }))))
      .rejects.toMatchObject({ kind: 'validation' });
    expect(features.list()).toHaveLength(0);
  });

  it('allows the same key to retry after a rolled-back failure', async () => {
    const db = createDatabase({ databasePath: ':memory:' });
    let fail = true;
    const repo = createFeatureRepo(db);
    const features = createFeatureService({
      repo: { ...repo, create: (f: never) => { if (fail) { fail = false; throw new Error('disk'); } return repo.create(f); } },
      ids, clock, repos: { get: () => ({}) }, groups: { get: () => null },
    } as never);
    const routes = createFeatureRoutes({ features, admin: {} as never, operations: operationsOn(db) });
    const post = find(routes, 'post', '/features');
    await expect(Promise.resolve().then(() => post(req({ body, headers: { [KEY]: 'op-f' } })))).rejects.toThrow('disk');
    expect(features.list()).toHaveLength(0);
    expect((await post(req({ body, headers: { [KEY]: 'op-f' } }))).status).toBe(201);
    expect(features.list()).toHaveLength(1);
  });
});

describe('terminal-session create idempotency', () => {
  function terminal(db = createDatabase({ databasePath: ':memory:' })) {
    const sessions = createSessionRepo(db);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const routes = createTerminalRoutes({
      resolver: { resolve: async () => { await gate; return { provider: { id: 'copilot' } as never, model: 'auto' }; } },
      factory: createSessionFactory({ ids, clock, config: sessionConfig } as never),
      sessions,
      config: sessionConfig,
      bootstrap: { assertFeatureReady: async () => {} },
      operations: operationsOn(db),
    });
    return { routes, sessions, release, db };
  }
  const path = '/features/:featureId/terminal-sessions';

  it('concurrent same-key requests create ONE session', async () => {
    const { routes, sessions, release } = terminal();
    const r = { params: { featureId: 'f1' }, body: { prompt: 'go' }, headers: { [KEY]: 'op-t' } };
    const a = find(routes, 'post', path)(req(r));
    const b = find(routes, 'post', path)(req(r));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(sessions.listByFeature('f1')).toHaveLength(1);
    expect(ra).toEqual(rb);
  });

  it('retry after response loss and after a restart returns the original session', async () => {
    const first = terminal();
    first.release();
    const r = { params: { featureId: 'f1' }, body: {}, headers: { [KEY]: 'op-t2' } };
    const created = await find(first.routes, 'post', path)(req(r));
    const restarted = terminal(first.db);
    restarted.release();
    const retry = await find(restarted.routes, 'post', path)(req(r));
    expect(restarted.sessions.listByFeature('f1')).toHaveLength(1);
    expect(retry).toEqual(created);
  });

  it('resumes a pending key left by a crashed process into exactly one session', async () => {
    const first = terminal();
    const r = { params: { featureId: 'f1' }, body: {}, headers: { [KEY]: 'op-t3' } };
    void Promise.resolve(find(first.routes, 'post', path)(req(r))).catch(() => {}); // never resolves: simulates a crash mid-flight
    const restarted = terminal(first.db);
    restarted.release();
    const one = await find(restarted.routes, 'post', path)(req(r));
    const two = await find(restarted.routes, 'post', path)(req(r));
    expect(two).toEqual(one);
    expect(restarted.sessions.listByFeature('f1')).toHaveLength(1);
  });

  it('conflicts when the body differs under the same key', async () => {
    const { routes, release } = terminal();
    release();
    const headers = { [KEY]: 'op-t4' };
    await find(routes, 'post', path)(req({ params: { featureId: 'f1' }, body: { prompt: 'a' }, headers }));
    await expect(Promise.resolve().then(() => find(routes, 'post', path)(
      req({ params: { featureId: 'f1' }, body: { prompt: 'b' }, headers }))))
      .rejects.toMatchObject({ kind: 'conflict' });
  });
});

describe('feature-agent attach idempotency', () => {
  function agents(allowMultiplePerFeature: boolean, db = createDatabase({ databasePath: ':memory:' })) {
    const registry = createAgentRegistry([{
      manifest: {
        id: 'new-task', title: 'New Task', description: '', icon: 'x', allowMultiplePerFeature,
        prerequisiteLabel: '', usageLabel: 'new-task', promptFields: [],
      },
      checkPrerequisite: () => ({ met: true }),
    }] as never);
    const service = createAgentService({
      registry, attachments: createAgentAttachmentRepo(db),
      usage: { aggregateByLabel: () => ({ credits: null, runs: 0 }) } as never,
      clock, newId: ids.next,
    } as never);
    return { routes: createAgentRoutes({ agents: service, operations: operationsOn(db) }), service, db };
  }
  const path = '/features/:featureId/agents';
  const r = (key: string) => ({ params: { featureId: 'f1' }, body: { agentId: 'new-task' }, headers: { [KEY]: key } });

  it('same key on a multi-attach agent yields ONE attachment, a new key a second', async () => {
    const { routes, service } = agents(true);
    const first = await find(routes, 'post', path)(req(r('op-a')));
    const retry = await find(routes, 'post', path)(req(r('op-a')));
    expect(service.attachedAgents('f1')).toHaveLength(1);
    expect(retry).toEqual(first);
    await find(routes, 'post', path)(req(r('op-a2')));
    expect(service.attachedAgents('f1')).toHaveLength(2);
  });

  it('single-attach retry replays 201 across a restart instead of a 409', async () => {
    const one = agents(false);
    const first = await find(one.routes, 'post', path)(req(r('op-b')));
    const restarted = agents(false, one.db);
    const retry = await find(restarted.routes, 'post', path)(req(r('op-b')));
    expect(retry).toEqual(first);
    await expect(Promise.resolve().then(() => find(restarted.routes, 'post', path)(req(r('op-other')))))
      .rejects.toMatchObject({ kind: 'conflict' });
  });
});
