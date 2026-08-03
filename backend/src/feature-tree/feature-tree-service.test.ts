import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { Session } from '../session/session-contract.js';
import {
  createFeatureTreeService,
  type FeatureTreeService,
} from './feature-tree-service.js';
import type { TreeGroup } from './feature-tree-contract.js';
import type {
  FeatureGroupsRepo,
  GroupPlacement,
} from './feature-groups-repo-port.js';
import { featureTreeDefaults } from './config.js';

function group(overrides: Partial<TreeGroup> = {}): TreeGroup {
  return {
    id: 'g1',
    featureId: 'f1',
    parentGroupId: null,
    kind: 'subcategory',
    name: 'Group',
    prNumber: null,
    prUrl: null,
    orderIndex: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'auto',
    resolvedModel: null,
    status: 'running',
    kind: 'dev',
    scope: 'feature',
    groupId: null,
    orderIndex: 0,
    prompt: 'do it',
    usageFilePath: 'u',
    createdAt: '2025-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function makeGroupsRepo(initial: TreeGroup[] = []) {
  const store = new Map(initial.map((g) => [g.id, { ...g }]));
  const repo: FeatureGroupsRepo & { all(): TreeGroup[] } = {
    listByFeature: (featureId) =>
      [...store.values()]
        .filter((g) => g.featureId === featureId)
        .map((g) => ({ ...g })),
    get: (id) => {
      const found = store.get(id);
      return found ? { ...found } : null;
    },
    save: (g) => {
      store.set(g.id, { ...g });
    },
    updateName: (id, name) => {
      const found = store.get(id);
      if (found) {
        found.name = name;
      }
    },
    updatePlacement: (id, placement: GroupPlacement) => {
      const found = store.get(id);
      if (found) {
        found.featureId = placement.featureId;
        found.parentGroupId = placement.parentGroupId;
        found.orderIndex = placement.orderIndex;
      }
    },
    delete: (id) => {
      store.delete(id);
    },
    deleteByFeature: (featureId) => {
      for (const [id, g] of store) {
        if (g.featureId === featureId) {
          store.delete(id);
        }
      }
    },
    all: () => [...store.values()].map((g) => ({ ...g })),
  };
  return repo;
}

function makeSessionsRepo(initial: Session[] = []) {
  const store = new Map(initial.map((s) => [s.id, { ...s }]));
  return {
    get: (id: string) => {
      const found = store.get(id);
      return found ? { ...found } : null;
    },
    listByFeature: (featureId: string) =>
      [...store.values()]
        .filter((s) => s.featureId === featureId && (s.scope ?? 'feature') === 'feature')
        .map((s) => ({ ...s })),
    updatePlacement: (
      id: string,
      placement: { featureId: string; groupId: string | null; orderIndex: number },
    ) => {
      const found = store.get(id);
      if (found) {
        found.featureId = placement.featureId;
        found.groupId = placement.groupId;
        found.orderIndex = placement.orderIndex;
      }
    },
    all: () => [...store.values()].map((s) => ({ ...s })),
  };
}

function makeFeatures(known: string[]) {
  const set = new Set(known);
  return {
    get: (id: string) => {
      if (!set.has(id)) {
        throw new NotFoundError(`Unknown feature: ${id}`);
      }
      return { id };
    },
  };
}

function makeIds() {
  let n = 0;
  return { next: () => `gen-${++n}` };
}

const clock = { isoNow: () => '2025-06-01T00:00:00.000Z' };

function build(
  groups: FeatureGroupsRepo,
  sessions: ReturnType<typeof makeSessionsRepo>,
  features = makeFeatures(['f1', 'f2']),
): FeatureTreeService {
  return createFeatureTreeService({
    groups,
    sessions,
    features,
    ids: makeIds(),
    clock,
    config: featureTreeDefaults,
  });
}

describe('feature-tree service', () => {
  describe('listGroups', () => {
    it('returns the groups for a feature', () => {
      const groups = makeGroupsRepo([group({ id: 'a' }), group({ id: 'b', featureId: 'f2' })]);
      const service = build(groups, makeSessionsRepo());
      expect(service.listGroups('f1').map((g) => g.id)).toEqual(['a']);
    });
  });

  describe('createGroup', () => {
    it('creates a root subcategory positioned after existing children', () => {
      const groups = makeGroupsRepo([group({ id: 'a', orderIndex: 0 })]);
      const sessions = makeSessionsRepo([session({ id: 's1', orderIndex: 1 })]);
      const service = build(groups, sessions);
      const created = service.createGroup({
        featureId: 'f1',
        kind: 'subcategory',
        name: 'Docs',
      });
      expect(created).toMatchObject({
        id: 'gen-1',
        featureId: 'f1',
        parentGroupId: null,
        kind: 'subcategory',
        name: 'Docs',
        prNumber: null,
        prUrl: null,
        orderIndex: 2,
        createdAt: '2025-06-01T00:00:00.000Z',
      });
      expect(groups.get('gen-1')).not.toBeNull();
    });

    it('nests a group under a valid parent', () => {
      const groups = makeGroupsRepo([group({ id: 'parent' })]);
      const service = build(groups, makeSessionsRepo());
      const created = service.createGroup({
        featureId: 'f1',
        parentGroupId: 'parent',
        kind: 'subcategory',
        name: 'Child',
      });
      expect(created.parentGroupId).toBe('parent');
      expect(created.orderIndex).toBe(0);
    });

    it('rejects an unknown parent group', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      expect(() =>
        service.createGroup({
          featureId: 'f1',
          parentGroupId: 'ghost',
          kind: 'subcategory',
          name: 'x',
        }),
      ).toThrow(NotFoundError);
    });

    it('rejects a parent from another feature', () => {
      const groups = makeGroupsRepo([group({ id: 'p', featureId: 'f2' })]);
      const service = build(groups, makeSessionsRepo());
      expect(() =>
        service.createGroup({
          featureId: 'f1',
          parentGroupId: 'p',
          kind: 'subcategory',
          name: 'x',
        }),
      ).toThrow(ValidationError);
    });

    it('validates an unknown feature', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      expect(() =>
        service.createGroup({ featureId: 'nope', kind: 'subcategory', name: 'x' }),
      ).toThrow(NotFoundError);
    });

    it('requires pr metadata for a pr group', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      expect(() =>
        service.createGroup({ featureId: 'f1', kind: 'pr', name: 'PR' }),
      ).toThrow(ValidationError);
      expect(() =>
        service.createGroup({
          featureId: 'f1',
          kind: 'pr',
          name: 'PR',
          prNumber: 12,
          prUrl: '',
        }),
      ).toThrow(ValidationError);
    });

    it('creates a pr group carrying its number and url', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      const created = service.createGroup({
        featureId: 'f1',
        kind: 'pr',
        name: 'PR #12',
        prNumber: 12,
        prUrl: 'https://example/pr/12',
      });
      expect(created).toMatchObject({
        kind: 'pr',
        prNumber: 12,
        prUrl: 'https://example/pr/12',
      });
    });

    it('falls back to the configured default name when blank', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      const created = service.createGroup({
        featureId: 'f1',
        kind: 'subcategory',
        name: '   ',
      });
      expect(created.name).toBe(featureTreeDefaults.defaultSubcategoryName);
    });
  });

  describe('renameGroup', () => {
    it('renames an existing group', () => {
      const groups = makeGroupsRepo([group({ id: 'a', name: 'Old' })]);
      const service = build(groups, makeSessionsRepo());
      expect(service.renameGroup('a', 'New').name).toBe('New');
      expect(groups.get('a')?.name).toBe('New');
    });

    it('applies the default name when blank', () => {
      const groups = makeGroupsRepo([group({ id: 'a' })]);
      const service = build(groups, makeSessionsRepo());
      expect(service.renameGroup('a', '  ').name).toBe(
        featureTreeDefaults.defaultSubcategoryName,
      );
    });

    it('rejects an unknown group', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      expect(() => service.renameGroup('ghost', 'x')).toThrow(NotFoundError);
    });
  });

  describe('deleteGroup', () => {
    it('promotes child groups and sessions to the parent, then removes it', () => {
      const groups = makeGroupsRepo([
        group({ id: 'parent', parentGroupId: null, orderIndex: 0 }),
        group({ id: 'target', parentGroupId: 'parent', orderIndex: 0 }),
        group({ id: 'sibling', parentGroupId: 'parent', orderIndex: 1 }),
        group({ id: 'child', parentGroupId: 'target', orderIndex: 0 }),
      ]);
      const sessions = makeSessionsRepo([
        session({ id: 'sess', groupId: 'target', orderIndex: 1 }),
      ]);
      const service = build(groups, sessions);
      service.deleteGroup('target');

      expect(groups.get('target')).toBeNull();
      // sibling keeps index 0; promoted child group then session follow it.
      expect(groups.get('sibling')?.orderIndex).toBe(0);
      const promotedGroup = groups.get('child');
      expect(promotedGroup?.parentGroupId).toBe('parent');
      expect(promotedGroup?.orderIndex).toBe(1);
      const promotedSession = sessions.get('sess');
      expect(promotedSession?.groupId).toBe('parent');
      expect(promotedSession?.orderIndex).toBe(2);
    });

    it('rejects an unknown group', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      expect(() => service.deleteGroup('ghost')).toThrow(NotFoundError);
    });
  });

  describe('moveNode', () => {
    it('reorders a session within the same container', () => {
      const sessions = makeSessionsRepo([
        session({ id: 's1', orderIndex: 0 }),
        session({ id: 's2', orderIndex: 1 }),
        session({ id: 's3', orderIndex: 2 }),
      ]);
      const service = build(makeGroupsRepo(), sessions);
      service.moveNode({
        type: 'session',
        id: 's3',
        targetFeatureId: 'f1',
        targetParentGroupId: null,
        targetIndex: 0,
      });
      expect(sessions.get('s3')?.orderIndex).toBe(0);
      expect(sessions.get('s1')?.orderIndex).toBe(1);
      expect(sessions.get('s2')?.orderIndex).toBe(2);
    });

    it('orders a legacy sibling with a missing orderIndex as zero', () => {
      const sessions = makeSessionsRepo([
        session({ id: 'legacy', orderIndex: undefined as unknown as number }),
        session({ id: 's2', orderIndex: 5 }),
      ]);
      const service = build(makeGroupsRepo(), sessions);
      service.moveNode({
        type: 'session',
        id: 's2',
        targetFeatureId: 'f1',
        targetParentGroupId: null,
        targetIndex: 0,
      });
      expect(sessions.get('s2')?.orderIndex).toBe(0);
      expect(sessions.get('legacy')?.orderIndex).toBe(1);
    });

    it('moves a session into a group and appends beyond the end (clamped)', () => {
      const groups = makeGroupsRepo([group({ id: 'g' })]);
      const sessions = makeSessionsRepo([
        session({ id: 's1', groupId: null, orderIndex: 0 }),
        session({ id: 'existing', groupId: 'g', orderIndex: 0 }),
      ]);
      const service = build(groups, sessions);
      service.moveNode({
        type: 'session',
        id: 's1',
        targetFeatureId: 'f1',
        targetParentGroupId: 'g',
        targetIndex: 99,
      });
      expect(sessions.get('s1')?.groupId).toBe('g');
      expect(sessions.get('s1')?.orderIndex).toBe(1);
      expect(sessions.get('existing')?.orderIndex).toBe(0);
    });

    it('moves a session to another feature', () => {
      const sessions = makeSessionsRepo([session({ id: 's1', featureId: 'f1' })]);
      const service = build(makeGroupsRepo(), sessions);
      service.moveNode({
        type: 'session',
        id: 's1',
        targetFeatureId: 'f2',
        targetParentGroupId: null,
        targetIndex: 0,
      });
      expect(sessions.get('s1')?.featureId).toBe('f2');
    });

    it('rejects moving an unknown session', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      expect(() =>
        service.moveNode({
          type: 'session',
          id: 'ghost',
          targetFeatureId: 'f1',
          targetParentGroupId: null,
          targetIndex: 0,
        }),
      ).toThrow(NotFoundError);
    });

    it('reorders a group within the same container (negative index clamped)', () => {
      const groups = makeGroupsRepo([
        group({ id: 'a', orderIndex: 0 }),
        group({ id: 'b', orderIndex: 1 }),
      ]);
      const service = build(groups, makeSessionsRepo());
      service.moveNode({
        type: 'group',
        id: 'b',
        targetFeatureId: 'f1',
        targetParentGroupId: null,
        targetIndex: -5,
      });
      expect(groups.get('b')?.orderIndex).toBe(0);
      expect(groups.get('a')?.orderIndex).toBe(1);
    });

    it('rejects dropping a group into itself', () => {
      const groups = makeGroupsRepo([group({ id: 'a' })]);
      const service = build(groups, makeSessionsRepo());
      expect(() =>
        service.moveNode({
          type: 'group',
          id: 'a',
          targetFeatureId: 'f1',
          targetParentGroupId: 'a',
          targetIndex: 0,
        }),
      ).toThrow(ValidationError);
    });

    it('rejects dropping a group into its own descendant', () => {
      const groups = makeGroupsRepo([
        group({ id: 'root', parentGroupId: null }),
        group({ id: 'mid', parentGroupId: 'root' }),
        group({ id: 'leaf', parentGroupId: 'mid' }),
      ]);
      const service = build(groups, makeSessionsRepo());
      expect(() =>
        service.moveNode({
          type: 'group',
          id: 'root',
          targetFeatureId: 'f1',
          targetParentGroupId: 'leaf',
          targetIndex: 0,
        }),
      ).toThrow(ValidationError);
    });

    it('allows reparenting a group to a non-descendant sibling', () => {
      const groups = makeGroupsRepo([
        group({ id: 'a', parentGroupId: null, orderIndex: 0 }),
        group({ id: 'b', parentGroupId: null, orderIndex: 1 }),
        group({ id: 'child', parentGroupId: 'a', orderIndex: 0 }),
      ]);
      const service = build(groups, makeSessionsRepo());
      service.moveNode({
        type: 'group',
        id: 'child',
        targetFeatureId: 'f1',
        targetParentGroupId: 'b',
        targetIndex: 0,
      });
      expect(groups.get('child')?.parentGroupId).toBe('b');
      expect(groups.get('child')?.orderIndex).toBe(0);
    });

    it('tolerates a broken parent chain when checking for cycles', () => {
      const groups = makeGroupsRepo([
        group({ id: 'root', parentGroupId: null }),
        // `orphan` references a parent that no longer exists.
        group({ id: 'orphan', parentGroupId: 'vanished' }),
      ]);
      const service = build(groups, makeSessionsRepo());
      service.moveNode({
        type: 'group',
        id: 'root',
        targetFeatureId: 'f1',
        targetParentGroupId: 'orphan',
        targetIndex: 0,
      });
      expect(groups.get('root')?.parentGroupId).toBe('orphan');
    });

    it('treats a missing orderIndex as zero when ordering and re-homing', () => {
      const groups = makeGroupsRepo([group({ id: 'root', parentGroupId: null })]);
      const sessions = makeSessionsRepo([
        session({
          id: 'legacy',
          groupId: 'root',
          orderIndex: undefined as unknown as number,
        }),
      ]);
      const service = build(groups, sessions);
      service.moveNode({
        type: 'group',
        id: 'root',
        targetFeatureId: 'f2',
        targetParentGroupId: null,
        targetIndex: 0,
      });
      expect(sessions.get('legacy')?.featureId).toBe('f2');
      expect(sessions.get('legacy')?.orderIndex).toBe(0);
    });

    it('re-homes a whole group subtree to another feature', () => {
      const groups = makeGroupsRepo([
        group({ id: 'root', featureId: 'f1', parentGroupId: null }),
        group({ id: 'child', featureId: 'f1', parentGroupId: 'root' }),
        group({ id: 'other', featureId: 'f1', parentGroupId: null }),
      ]);
      const sessions = makeSessionsRepo([
        session({ id: 'in-subtree', featureId: 'f1', groupId: 'child', orderIndex: 0 }),
        session({ id: 'root-level', featureId: 'f1', groupId: null, orderIndex: 0 }),
        session({ id: 'other-group', featureId: 'f1', groupId: 'other', orderIndex: 0 }),
      ]);
      const service = build(groups, sessions);
      service.moveNode({
        type: 'group',
        id: 'root',
        targetFeatureId: 'f2',
        targetParentGroupId: null,
        targetIndex: 0,
      });
      expect(groups.get('root')?.featureId).toBe('f2');
      expect(groups.get('child')?.featureId).toBe('f2');
      expect(groups.get('child')?.parentGroupId).toBe('root');
      expect(sessions.get('in-subtree')?.featureId).toBe('f2');
      // Nodes outside the subtree stay on f1.
      expect(groups.get('other')?.featureId).toBe('f1');
      expect(sessions.get('root-level')?.featureId).toBe('f1');
      expect(sessions.get('other-group')?.featureId).toBe('f1');
    });

    it('rejects an unknown target feature', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      expect(() =>
        service.moveNode({
          type: 'session',
          id: 's1',
          targetFeatureId: 'nope',
          targetParentGroupId: null,
          targetIndex: 0,
        }),
      ).toThrow(NotFoundError);
    });

    it('rejects an unknown target group', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      expect(() =>
        service.moveNode({
          type: 'session',
          id: 's1',
          targetFeatureId: 'f1',
          targetParentGroupId: 'ghost',
          targetIndex: 0,
        }),
      ).toThrow(NotFoundError);
    });

    it('rejects a target group from another feature', () => {
      const groups = makeGroupsRepo([group({ id: 'g', featureId: 'f2' })]);
      const service = build(groups, makeSessionsRepo());
      expect(() =>
        service.moveNode({
          type: 'session',
          id: 's1',
          targetFeatureId: 'f1',
          targetParentGroupId: 'g',
          targetIndex: 0,
        }),
      ).toThrow(ValidationError);
    });

    it('rejects moving an unknown group', () => {
      const service = build(makeGroupsRepo(), makeSessionsRepo());
      expect(() =>
        service.moveNode({
          type: 'group',
          id: 'ghost',
          targetFeatureId: 'f1',
          targetParentGroupId: null,
          targetIndex: 0,
        }),
      ).toThrow(NotFoundError);
    });

    it('orders tied siblings deterministically by id', () => {
      const groups = makeGroupsRepo([
        group({ id: 'b', orderIndex: 0 }),
        group({ id: 'a', orderIndex: 0 }),
      ]);
      const sessions = makeSessionsRepo([session({ id: 'z', groupId: null, orderIndex: 0 })]);
      const service = build(groups, sessions);
      // Move session to the front; tied groups a,b resolve by id before it.
      service.moveNode({
        type: 'session',
        id: 'z',
        targetFeatureId: 'f1',
        targetParentGroupId: null,
        targetIndex: 5,
      });
      expect(groups.get('a')?.orderIndex).toBe(0);
      expect(groups.get('b')?.orderIndex).toBe(1);
      expect(sessions.get('z')?.orderIndex).toBe(2);
    });
  });
});

describe('feature-tree service (isolation)', () => {
  let groups: ReturnType<typeof makeGroupsRepo>;
  beforeEach(() => {
    groups = makeGroupsRepo();
  });

  it('starts empty', () => {
    const service = build(groups, makeSessionsRepo());
    expect(service.listGroups('f1')).toEqual([]);
  });
});
