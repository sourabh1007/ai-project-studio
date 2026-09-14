import { describe, expect, it } from 'vitest';
import {
  blockedMoveTargets,
  featureMoveTargets,
  type MovableFeature,
  type MovableGroup,
} from './feature-move-targets.js';

const repos = [
  { id: 'r1', name: 'CosmosDB' },
  { id: 'r2', name: 'Fabric' },
];

const features: MovableFeature[] = [
  { id: 'a', name: 'Reviews', repoId: 'r1', parentFeatureId: null },
  { id: 'b', name: 'Indexing', repoId: 'r1', parentFeatureId: 'a' },
  { id: 'c', name: 'Deep', repoId: null, parentFeatureId: 'b' },
  { id: 'd', name: 'Solo', repoId: 'r1' },
  { id: 'e', name: 'Other', repoId: 'r2', parentFeatureId: null },
];

describe('blockedMoveTargets', () => {
  it('blocks the feature and every descendant', () => {
    expect([...blockedMoveTargets(features, 'a')].sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('blocks only the feature when it is a leaf', () => {
    expect([...blockedMoveTargets(features, 'c')]).toEqual(['c']);
  });
});

describe('featureMoveTargets', () => {
  it('lists nested destinations with an indented path and inherited repo', () => {
    const moved = features.find((f) => f.id === 'd') as MovableFeature;
    const targets = featureMoveTargets(features, moved, repos);
    expect(targets.map((t) => t.label)).toEqual([
      'Reviews',
      'Reviews / Indexing',
      'Reviews / Indexing / Deep',
      'Fabric (top level)',
      'Other',
    ]);
    const deep = targets.find((t) => t.label.endsWith('Deep'));
    expect(deep).toMatchObject({ parentFeatureId: 'c', repoId: 'r1', depth: 3 });
  });

  it('omits the moved feature, its descendants and its current parent', () => {
    const moved = features.find((f) => f.id === 'b') as MovableFeature;
    const targets = featureMoveTargets(features, moved, repos);
    expect(targets.map((t) => t.parentFeatureId)).toEqual([
      null,
      'd',
      null,
      'e',
    ]);
  });

  it('keeps the current repository top level out of the list for a root feature', () => {
    const moved = features.find((f) => f.id === 'a') as MovableFeature;
    const targets = featureMoveTargets(features, moved, repos);
    expect(targets.map((t) => t.label)).toEqual([
      'Solo',
      'Fabric (top level)',
      'Other',
    ]);
  });

  it('offers the top level of the current repository to a nested feature', () => {
    const moved = features.find((f) => f.id === 'c') as MovableFeature;
    const targets = featureMoveTargets(features, moved, repos);
    expect(targets[0]).toMatchObject({
      parentFeatureId: null,
      repoId: 'r1',
      label: 'CosmosDB (top level)',
    });
  });
});

const groups: MovableGroup[] = [
  { id: 'g1', name: 'Folder', featureId: 'a', parentGroupId: null },
  { id: 'g2', name: 'Sub', featureId: 'a', parentGroupId: 'g1', kind: 'subcategory' },
  { id: 'gpr', name: 'PR #5', featureId: 'a', parentGroupId: null, kind: 'pr' },
  { id: 'gdangling', name: 'Lost', featureId: 'ghost', parentGroupId: 'missing', kind: 'subcategory' },
  { id: 'gself', name: 'Loop', featureId: 'e', parentGroupId: 'gself', kind: 'subcategory' },
];

describe('featureMoveTargets with subcategory groups', () => {
  it('offers subcategory folders, skipping PR containers, with nested paths', () => {
    const moved = features.find((f) => f.id === 'd') as MovableFeature;
    const targets = featureMoveTargets(features, moved, repos, groups);
    const groupTargets = targets.filter((t) => t.parentGroupId);
    expect(groupTargets.map((t) => ({ id: t.parentGroupId, label: t.label, repoId: t.repoId }))).toEqual([
      { id: 'g1', label: 'Reviews / Folder', repoId: 'r1' },
      { id: 'g2', label: 'Reviews / Folder / Sub', repoId: 'r1' },
      { id: 'gdangling', label: 'Lost', repoId: null },
      { id: 'gself', label: 'Other / Loop', repoId: 'r2' },
    ]);
  });

  it('excludes folders owned by the moved feature or its descendants', () => {
    const moved = features.find((f) => f.id === 'a') as MovableFeature;
    const targets = featureMoveTargets(features, moved, repos, groups);
    const groupTargets = targets.filter((t) => t.parentGroupId);
    expect(groupTargets.map((t) => t.parentGroupId)).toEqual(['gdangling', 'gself']);
  });

  it('skips the folder the feature already lives in and offers its repo top level', () => {
    const moved: MovableFeature = {
      id: 'x',
      name: 'Placed',
      repoId: 'r1',
      parentFeatureId: null,
      parentGroupId: 'g1',
    };
    const targets = featureMoveTargets(features, moved, repos, groups);
    expect(targets.some((t) => t.label === 'CosmosDB (top level)')).toBe(true);
    const groupTargets = targets.filter((t) => t.parentGroupId);
    expect(groupTargets.map((t) => t.parentGroupId)).toEqual(['g2', 'gdangling', 'gself']);
  });
});
