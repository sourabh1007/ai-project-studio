import { describe, it, expect } from 'vitest';
import { createFeatureTreeRoutes } from './feature-tree-controller.js';
import type { FeatureTreeService } from '../feature-tree/feature-tree-service.js';
import type { TreeGroup } from '../feature-tree/feature-tree-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

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

const group: TreeGroup = {
  id: 'g1',
  featureId: 'f1',
  parentGroupId: null,
  kind: 'subcategory',
  name: 'Docs',
  prNumber: null,
  prUrl: null,
  orderIndex: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function harness() {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] = args;
  };
  const tree = {
    listGroups: (id: string) => (record('listGroups', id), [group]),
    createGroup: (input: unknown) => (record('createGroup', input), group),
    renameGroup: (id: string, name: string) => (record('renameGroup', id, name), group),
    deleteGroup: (id: string) => record('deleteGroup', id),
    moveNode: (input: unknown) => record('moveNode', input),
  } as unknown as FeatureTreeService;
  return { routes: createFeatureTreeRoutes({ tree }), calls };
}

describe('feature-tree-controller', () => {
  it('lists a feature groups', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'get', '/features/:featureId/groups')(
      req({ params: { featureId: 'f1' } }),
    );
    expect(res).toEqual({ status: 200, body: [group] });
    expect(calls.listGroups).toEqual(['f1']);
  });

  it('creates a subcategory', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'post', '/features/:featureId/groups')(
      req({
        params: { featureId: 'f1' },
        body: { kind: 'subcategory', name: 'Docs' },
      }),
    );
    expect(res).toEqual({ status: 201, body: group });
    expect(calls.createGroup).toEqual([
      { featureId: 'f1', kind: 'subcategory', name: 'Docs' },
    ]);
  });

  it('creates a pr group with metadata', () => {
    const { routes, calls } = harness();
    pick(routes, 'post', '/features/:featureId/groups')(
      req({
        params: { featureId: 'f1' },
        body: {
          kind: 'pr',
          name: 'PR #12',
          prNumber: 12,
          prUrl: 'https://example/pr/12',
          parentGroupId: null,
        },
      }),
    );
    expect(calls.createGroup).toEqual([
      {
        featureId: 'f1',
        kind: 'pr',
        name: 'PR #12',
        prNumber: 12,
        prUrl: 'https://example/pr/12',
        parentGroupId: null,
      },
    ]);
  });

  it('rejects an invalid create-group body', () => {
    const { routes } = harness();
    const handler = pick(routes, 'post', '/features/:featureId/groups');
    expect(() =>
      handler(req({ params: { featureId: 'f1' }, body: { kind: 'bogus', name: 'x' } })),
    ).toThrow();
  });

  it('renames a group', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'put', '/groups/:groupId')(
      req({ params: { groupId: 'g1' }, body: { name: 'New' } }),
    );
    expect(res).toEqual({ status: 200, body: group });
    expect(calls.renameGroup).toEqual(['g1', 'New']);
  });

  it('rejects an invalid rename body', () => {
    const { routes } = harness();
    const handler = pick(routes, 'put', '/groups/:groupId');
    expect(() => handler(req({ params: { groupId: 'g1' }, body: {} }))).toThrow();
  });

  it('deletes a group', () => {
    const { routes, calls } = harness();
    const res = pick(routes, 'delete', '/groups/:groupId')(
      req({ params: { groupId: 'g1' } }),
    );
    expect(res).toEqual({ status: 200, body: { id: 'g1' } });
    expect(calls.deleteGroup).toEqual(['g1']);
  });

  it('moves a node', () => {
    const { routes, calls } = harness();
    const body = {
      type: 'session',
      id: 's1',
      targetFeatureId: 'f2',
      targetParentGroupId: null,
      targetIndex: 0,
    };
    const res = pick(routes, 'post', '/tree/move')(req({ body }));
    expect(res).toEqual({ status: 200, body: { moved: true } });
    expect(calls.moveNode).toEqual([body]);
  });

  it('rejects an invalid move body', () => {
    const { routes } = harness();
    const handler = pick(routes, 'post', '/tree/move');
    expect(() => handler(req({ body: { type: 'session', id: 's1' } }))).toThrow();
  });
});
