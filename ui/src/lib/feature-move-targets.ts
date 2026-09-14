export interface MovableFeature {
  id: string;
  name: string;
  repoId: string | null;
  parentFeatureId?: string | null;
  parentGroupId?: string | null;
}

/** A subcategory group a feature may be moved into. */
export interface MovableGroup {
  id: string;
  name: string;
  /** The feature that owns this group. */
  featureId: string;
  /** Parent subcategory group, or null when directly under its feature. */
  parentGroupId: string | null;
  /** 'subcategory' folders accept features; 'pr' containers do not. */
  kind?: string;
}

export interface FeatureMoveTarget {
  /** Destination parent feature, or null for the top level of a repository. */
  parentFeatureId: string | null;
  /** Destination subcategory group, or null when not moving into a group. */
  parentGroupId?: string | null;
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
  groups: readonly MovableGroup[] = [],
): FeatureMoveTarget[] {
  const blocked = blockedMoveTargets(features, moved.id);
  const currentParent = moved.parentFeatureId ?? null;
  const currentGroup = moved.parentGroupId ?? null;
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
    if (currentParent !== null || currentGroup !== null || moved.repoId !== repo.id) {
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

  appendGroupTargets(features, groups, blocked, currentGroup, targets);
  return targets;
}

/**
 * Adds every subcategory folder a feature may be moved into. A feature can live
 * inside a subcategory of any other (non-blocked) feature; the destination
 * inherits the owning feature's repository. PR containers are skipped — only
 * folders hold features — as is the moved feature's current folder (a no-op).
 */
function appendGroupTargets(
  features: readonly MovableFeature[],
  groups: readonly MovableGroup[],
  blocked: ReadonlySet<string>,
  currentGroup: string | null,
  targets: FeatureMoveTarget[],
): void {
  const featureById = new Map(features.map((f) => [f.id, f]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const labelFor = (group: MovableGroup): string => {
    const parts: string[] = [];
    let cursor: MovableGroup | undefined = group;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      parts.unshift(cursor.name);
      cursor = cursor.parentGroupId ? groupById.get(cursor.parentGroupId) : undefined;
    }
    const owner = featureById.get(group.featureId);
    return [owner?.name ?? '', ...parts].filter(Boolean).join(' / ');
  };
  for (const group of groups) {
    if ((group.kind ?? 'subcategory') !== 'subcategory') continue;
    if (blocked.has(group.featureId)) continue;
    if (group.id === currentGroup) continue;
    const owner = featureById.get(group.featureId);
    targets.push({
      parentFeatureId: null,
      parentGroupId: group.id,
      repoId: owner?.repoId ?? null,
      label: labelFor(group),
      depth: 1,
    });
  }
}
