import { describe, it, expect } from 'vitest';
import { createFeatureRoutes } from './feature-controller.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { Feature } from '../feature/feature-contract.js';
import type { Session } from '../session/session-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

const feature: Feature = {
  id: 'f1',
  name: 'Login',
  description: 'Add login',
  createdAt: '2025-01-01T00:00:00.000Z',
  summary: null,
};

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

function harness() {
  const created: unknown[] = [];
  const moved: unknown[] = [];
  const service = {
    create: (input: unknown) => {
      created.push(input);
      return feature;
    },
    list: () => [feature],
    get: (id: string) => ({ ...feature, id }),
    moveFeature: (input: unknown) => {
      moved.push(input);
    },
  } as unknown as FeatureService;
  const renamed: { id: string; name: string }[] = [];
  const deleted: string[] = [];
  const admin = {
    renameFeature: (id: string, name: string) => {
      renamed.push({ id, name });
      return { ...feature, id, name };
    },
    renameSession: (id: string, name: string | null) =>
      ({ ...feature, id, name } as unknown as Session),
    deleteFeature: async (id: string) => void deleted.push(id),
    deleteSession: async () => undefined,
  };
  return {
    routes: createFeatureRoutes({ features: service, admin }),
    created,
    moved,
    renamed,
    deleted,
  };
}

describe('feature-controller', () => {
  it('creates a feature and returns 201', async () => {
    const h = harness();
    const result = await pick(h.routes, 'post', '/features')(
      req({ body: { name: 'Login', description: 'Add login' } }),
    );
    expect(result.status).toBe(201);
    expect(result.body).toBe(feature);
    expect(h.created).toEqual([{ name: 'Login', description: 'Add login' }]);
  });

  it('forwards repoId when creating a feature under a repository', async () => {
    const h = harness();
    const result = await pick(h.routes, 'post', '/features')(
      req({ body: { name: 'Login', description: 'd', repoId: 'r1' } }),
    );
    expect(result.status).toBe(201);
    expect(h.created).toEqual([
      { name: 'Login', description: 'd', repoId: 'r1' },
    ]);
  });

  it('rejects invalid create payloads', () => {
    const h = harness();
    let caught: unknown;
    try {
      pick(h.routes, 'post', '/features')(req({ body: { name: '' } }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ kind: 'validation' });
  });

  it('lists features', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/features')(req());
    expect(result).toEqual({ status: 200, body: [feature] });
  });

  it('gets a feature by id', async () => {
    const h = harness();
    const result = await pick(h.routes, 'get', '/features/:id')(
      req({ params: { id: 'f9' } }),
    );
    expect(result.status).toBe(200);
    expect((result.body as Feature).id).toBe('f9');
  });

  it('renames a feature and returns 200', async () => {
    const h = harness();
    const result = await pick(h.routes, 'put', '/features/:id')(
      req({ params: { id: 'f1' }, body: { name: 'Renamed' } }),
    );
    expect(result.status).toBe(200);
    expect((result.body as Feature).name).toBe('Renamed');
    expect(h.renamed).toEqual([{ id: 'f1', name: 'Renamed' }]);
  });

  it('rejects blank rename payloads', () => {
    const h = harness();
    let caught: unknown;
    try {
      pick(h.routes, 'put', '/features/:id')(
        req({ params: { id: 'f1' }, body: { name: '' } }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ kind: 'validation' });
  });

  it('deletes a feature and returns its id', async () => {
    const h = harness();
    const result = await pick(h.routes, 'delete', '/features/:id')(
      req({ params: { id: 'f1' } }),
    );
    expect(result).toEqual({ status: 200, body: { id: 'f1' } });
    expect(h.deleted).toEqual(['f1']);
  });

  it('moves a feature and returns the updated feature', async () => {
    const h = harness();
    const result = await pick(h.routes, 'post', '/features/:id/move')(
      req({
        params: { id: 'f1' },
        body: { targetRepoId: 'r2', targetIndex: 1 },
      }),
    );
    expect(result.status).toBe(200);
    expect((result.body as Feature).id).toBe('f1');
    expect(h.moved).toEqual([
      { id: 'f1', targetRepoId: 'r2', targetIndex: 1, targetParentFeatureId: null },
    ]);
  });

  it('moves a feature to the repo-less group with a null target', async () => {
    const h = harness();
    const result = await pick(h.routes, 'post', '/features/:id/move')(
      req({
        params: { id: 'f1' },
        body: { targetRepoId: null, targetIndex: 0 },
      }),
    );
    expect(result.status).toBe(200);
    expect(h.moved).toEqual([
      { id: 'f1', targetRepoId: null, targetIndex: 0, targetParentFeatureId: null },
    ]);
  });

  it('nests a feature under a parent when targetParentFeatureId is given', async () => {
    const h = harness();
    const result = await pick(h.routes, 'post', '/features/:id/move')(
      req({
        params: { id: 'f1' },
        body: { targetRepoId: 'r2', targetIndex: 0, targetParentFeatureId: 'p9' },
      }),
    );
    expect(result.status).toBe(200);
    expect(h.moved).toEqual([
      { id: 'f1', targetRepoId: 'r2', targetIndex: 0, targetParentFeatureId: 'p9' },
    ]);
  });

  it('rejects invalid move payloads', () => {
    const h = harness();
    let caught: unknown;
    try {
      pick(h.routes, 'post', '/features/:id/move')(
        req({ params: { id: 'f1' }, body: { targetIndex: -1 } }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ kind: 'validation' });
  });
});
