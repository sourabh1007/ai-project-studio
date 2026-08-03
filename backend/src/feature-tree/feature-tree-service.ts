import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type { Session } from '../session/session-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { FeatureTreeConfig } from './config.js';
import type {
  CreateGroupInput,
  MoveNodeInput,
  TreeGroup,
  TreeNodeType,
} from './feature-tree-contract.js';
import type { FeatureGroupsRepo } from './feature-groups-repo-port.js';

/** The session operations the tree needs: read placement and re-home. */
export type TreeSessionRepo = Pick<
  SessionRepo,
  'get' | 'listByFeature' | 'updatePlacement'
>;

export interface FeatureTreeServiceDeps {
  groups: FeatureGroupsRepo;
  sessions: TreeSessionRepo;
  /** Validates a feature exists (throws NotFoundError otherwise). */
  features: { get(id: string): unknown };
  ids: IdGenerator;
  clock: Clock;
  config: FeatureTreeConfig;
}

export interface FeatureTreeService {
  /** All groups belonging to a feature (the UI assembles the nested tree). */
  listGroups(featureId: string): TreeGroup[];
  createGroup(input: CreateGroupInput): TreeGroup;
  renameGroup(id: string, name: string): TreeGroup;
  /** Deletes a group, promoting its children to the group's own parent. */
  deleteGroup(id: string): void;
  /** Moves a session or group to a new container/position (drag-and-drop). */
  moveNode(input: MoveNodeInput): void;
}

/** One child of a container, unified across sessions and groups for ordering. */
interface OrderedChild {
  type: TreeNodeType;
  id: string;
  orderIndex: number;
}

export function createFeatureTreeService(
  deps: FeatureTreeServiceDeps,
): FeatureTreeService {
  const { groups, sessions, features, ids, clock, config } = deps;

  const sessionGroupId = (session: Session): string | null =>
    session.groupId ?? null;

  /** Children (groups + sessions) of a container, sorted by position. */
  const childrenOf = (
    featureId: string,
    parentGroupId: string | null,
  ): OrderedChild[] => {
    const childGroups = groups
      .listByFeature(featureId)
      .filter((group) => group.parentGroupId === parentGroupId)
      .map(
        (group): OrderedChild => ({
          type: 'group',
          id: group.id,
          orderIndex: group.orderIndex,
        }),
      );
    const childSessions = sessions
      .listByFeature(featureId)
      .filter((session) => sessionGroupId(session) === parentGroupId)
      .map(
        (session): OrderedChild => ({
          type: 'session',
          id: session.id,
          orderIndex: session.orderIndex ?? 0,
        }),
      );
    return [...childGroups, ...childSessions].sort(
      (left, right) =>
        left.orderIndex - right.orderIndex || left.id.localeCompare(right.id),
    );
  };

  /** Whether `nodeId` is `ancestorId` itself or nested somewhere beneath it. */
  const isSelfOrDescendant = (
    featureId: string,
    ancestorId: string,
    nodeId: string,
  ): boolean => {
    const byId = new Map(
      groups.listByFeature(featureId).map((group) => [group.id, group]),
    );
    let cursor: string | null = nodeId;
    while (cursor !== null) {
      if (cursor === ancestorId) {
        return true;
      }
      const current = byId.get(cursor);
      cursor = current ? current.parentGroupId : null;
    }
    return false;
  };

  /** Group ids in the subtree rooted at (and including) `rootId`. */
  const collectSubtree = (allGroups: TreeGroup[], rootId: string): Set<string> => {
    const childrenByParent = new Map<string, TreeGroup[]>();
    for (const group of allGroups) {
      const key = group.parentGroupId ?? '';
      const bucket = childrenByParent.get(key);
      if (bucket) {
        bucket.push(group);
      } else {
        childrenByParent.set(key, [group]);
      }
    }
    const ids = new Set<string>([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      const parent = queue.shift() as string;
      for (const child of childrenByParent.get(parent) ?? []) {
        if (!ids.has(child.id)) {
          ids.add(child.id);
          queue.push(child.id);
        }
      }
    }
    return ids;
  };

  /** Re-homes a group's whole subtree onto another feature, keeping structure. */
  const reassignSubtreeFeature = (root: TreeGroup, newFeatureId: string): void => {
    const featureGroups = groups.listByFeature(root.featureId);
    const featureSessions = sessions.listByFeature(root.featureId);
    const subtree = collectSubtree(featureGroups, root.id);
    for (const group of featureGroups) {
      if (subtree.has(group.id)) {
        groups.updatePlacement(group.id, {
          featureId: newFeatureId,
          parentGroupId: group.parentGroupId,
          orderIndex: group.orderIndex,
        });
      }
    }
    for (const session of featureSessions) {
      const parent = sessionGroupId(session);
      if (parent !== null && subtree.has(parent)) {
        sessions.updatePlacement(session.id, {
          featureId: newFeatureId,
          groupId: parent,
          orderIndex: session.orderIndex ?? 0,
        });
      }
    }
  };

  /** Assigns contiguous order indices to a container's children in order. */
  const renumber = (
    ordered: OrderedChild[],
    featureId: string,
    parentGroupId: string | null,
  ): void => {
    ordered.forEach((child, index) => {
      if (child.type === 'group') {
        groups.updatePlacement(child.id, {
          featureId,
          parentGroupId,
          orderIndex: index,
        });
      } else {
        sessions.updatePlacement(child.id, {
          featureId,
          groupId: parentGroupId,
          orderIndex: index,
        });
      }
    });
  };

  const requireGroup = (id: string): TreeGroup => {
    const group = groups.get(id);
    if (!group) {
      throw new NotFoundError(`Unknown group: ${id}`);
    }
    return group;
  };

  return {
    listGroups(featureId) {
      return groups.listByFeature(featureId);
    },

    createGroup(input) {
      features.get(input.featureId);
      const parentGroupId = input.parentGroupId ?? null;
      if (parentGroupId !== null) {
        const parent = requireGroup(parentGroupId);
        if (parent.featureId !== input.featureId) {
          throw new ValidationError('Parent group belongs to another feature');
        }
      }
      const isPr = input.kind === 'pr';
      if (isPr && (input.prNumber == null || !input.prUrl)) {
        throw new ValidationError('A PR group requires a prNumber and prUrl');
      }
      const name = input.name.trim() || config.defaultSubcategoryName;
      const group: TreeGroup = {
        id: ids.next(),
        featureId: input.featureId,
        parentGroupId,
        kind: input.kind,
        name,
        prNumber: isPr ? (input.prNumber as number) : null,
        prUrl: isPr ? (input.prUrl as string) : null,
        orderIndex: childrenOf(input.featureId, parentGroupId).length,
        createdAt: clock.isoNow(),
      };
      groups.save(group);
      return group;
    },

    renameGroup(id, name) {
      const group = requireGroup(id);
      const next = name.trim() || config.defaultSubcategoryName;
      groups.updateName(id, next);
      return { ...group, name: next };
    },

    deleteGroup(id) {
      const group = requireGroup(id);
      const { featureId, parentGroupId } = group;
      const promoted = childrenOf(featureId, id);
      const existing = childrenOf(featureId, parentGroupId).filter(
        (child) => child.id !== id,
      );
      renumber([...existing, ...promoted], featureId, parentGroupId);
      groups.delete(id);
    },

    moveNode(input) {
      const { type, id, targetFeatureId, targetIndex } = input;
      features.get(targetFeatureId);
      const targetParentGroupId = input.targetParentGroupId ?? null;
      if (targetParentGroupId !== null) {
        const parent = requireGroup(targetParentGroupId);
        if (parent.featureId !== targetFeatureId) {
          throw new ValidationError('Target group belongs to another feature');
        }
      }

      if (type === 'group') {
        const moving = requireGroup(id);
        if (
          targetParentGroupId !== null &&
          targetFeatureId === moving.featureId &&
          isSelfOrDescendant(moving.featureId, id, targetParentGroupId)
        ) {
          throw new ValidationError('Cannot move a group into its own subtree');
        }
        if (targetFeatureId !== moving.featureId) {
          reassignSubtreeFeature(moving, targetFeatureId);
        }
      } else if (!sessions.get(id)) {
        throw new NotFoundError(`Unknown session: ${id}`);
      }

      const siblings = childrenOf(targetFeatureId, targetParentGroupId).filter(
        (child) => child.id !== id,
      );
      const index = Math.max(0, Math.min(targetIndex, siblings.length));
      const ordered = [
        ...siblings.slice(0, index),
        { type, id, orderIndex: index },
        ...siblings.slice(index),
      ];
      renumber(ordered, targetFeatureId, targetParentGroupId);
    },
  };
}
