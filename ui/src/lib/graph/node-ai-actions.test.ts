import { describe, expect, it } from 'vitest';
import {
  actionsForTier,
  findNodeAiAction,
  NODE_AI_ACTIONS,
} from './node-ai-actions.js';

describe('NODE_AI_ACTIONS catalog', () => {
  it('has unique ids and non-empty labels/hints', () => {
    const ids = NODE_AI_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const action of NODE_AI_ACTIONS) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.hint.length).toBeGreaterThan(0);
      expect(action.tiers.length).toBeGreaterThan(0);
    }
  });
});

describe('actionsForTier', () => {
  it('restricts behavioural actions to member nodes', () => {
    const memberIds = actionsForTier('member').map((a) => a.id);
    expect(memberIds).toEqual(
      expect.arrayContaining(['call-path', 'callers', 'callees']),
    );
    expect(actionsForTier('group').map((a) => a.id)).not.toContain('call-path');
    expect(actionsForTier('type').map((a) => a.id)).not.toContain('callers');
  });

  it('offers explain for every tier', () => {
    for (const tier of ['group', 'type', 'member'] as const) {
      expect(actionsForTier(tier).map((a) => a.id)).toContain('explain');
    }
  });

  it('preserves catalog order', () => {
    const order = actionsForTier('member').map((a) => a.id);
    const catalogOrder = NODE_AI_ACTIONS.filter((a) =>
      a.tiers.includes('member'),
    ).map((a) => a.id);
    expect(order).toEqual(catalogOrder);
  });

  it('restricts ownership/impact to group and type tiers', () => {
    expect(actionsForTier('member').map((a) => a.id)).not.toContain('ownership');
    expect(actionsForTier('group').map((a) => a.id)).toContain('ownership');
    expect(actionsForTier('member').map((a) => a.id)).not.toContain(
      'architecture-impact',
    );
  });
});

describe('findNodeAiAction', () => {
  it('finds a known action', () => {
    expect(findNodeAiAction('explain')?.label).toBe('Explain this');
  });

  it('returns undefined for an unknown id', () => {
    expect(findNodeAiAction('nope')).toBeUndefined();
  });
});
