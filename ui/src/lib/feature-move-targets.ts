export interface MovableFeature {
  id: string;
  name: string;
  repoId: string | null;
  parentFeatureId?: string | null;
}

export interface FeatureMoveTarget {
  /** Destination parent feature, or null for the top level of a repository. */
  parentFeatureId: string | null;
  repoId: string | null;
  /** Indented path shown in the picker, e.g. "Reviews / CosmosDB". */
  label: string;
  depth: number;
}

function childrenOf(
  features: readonly MovableFeature[],
  parentId: string | null,
): MovableFeature[] {
  return features.filter((f) => (f.parentFeatureId ?? null) === parentId);
}

/** Every feature that may not receive the move: the feature itself and its descendants. */
export function blockedMoveTargets(
  features: readonly MovableFeature[],
  movedId: string,
): Set<string> {
  const blocked = new Set<string>([movedId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const feature of features) {
      const parent = feature.parentFeatureId ?? null;
      if (parent && blocked.has(parent) && !blocked.has(feature.id)) {
        blocked.add(feature.id);
        grew = true;
      }
    }
  }
  return blocked;
}

/**
 * Legal destinations for an explicit move, in tree order.
 *
 * Dragging only ever offered whatever row happened to be visible, so a deeply
 * nested destination was effectively unreachable. This enumerates every legal
 * destination up front — including the repository top level — and leaves out
 * the moved feature's own subtree, which the backend rejects as a cycle.
 */
export function featureMoveTargets(
  features: readonly MovableFeature[],
  moved: MovableFeature,
  repos: readonly { id: string; name: string }[],
): FeatureMoveTarget[] {
  const blocked = blockedMoveTargets(features, moved.id);
  const currentParent = moved.parentFeatureId ?? null;
  const targets: FeatureMoveTarget[] = [];

  const walk = (parentId: string, repoId: string | null, depth: number, prefix: string): void => {
    for (const child of childrenOf(features, parentId)) {
      if (blocked.has(child.id)) continue;
      const label = `${prefix} / ${child.name}`;
      if (child.id !== currentParent) {
        targets.push({
          parentFeatureId: child.id,
          repoId: child.repoId ?? repoId,
          label,
          depth,
        });
      }
      walk(child.id, child.repoId ?? repoId, depth + 1, label);
    }
  };

  for (const repo of repos) {
    const roots = childrenOf(features, null).filter((f) => f.repoId === repo.id);
    if (currentParent !== null || moved.repoId !== repo.id) {
      targets.push({
        parentFeatureId: null,
        repoId: repo.id,
        label: `${repo.name} (top level)`,
        depth: 0,
      });
    }
    for (const root of roots) {
      if (blocked.has(root.id)) continue;
      if (root.id !== currentParent) {
        targets.push({
          parentFeatureId: root.id,
          repoId: root.repoId,
          label: root.name,
          depth: 1,
        });
      }
      walk(root.id, root.repoId, 2, root.name);
    }
  }
  return targets;
}
