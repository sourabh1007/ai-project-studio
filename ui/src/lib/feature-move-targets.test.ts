import { describe, expect, it } from 'vitest';
import {
  blockedMoveTargets,
  featureMoveTargets,
  type MovableFeature,
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
