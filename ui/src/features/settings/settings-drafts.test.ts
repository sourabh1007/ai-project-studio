import { describe, expect, it } from 'vitest';
import type { ConfigValue, FieldMeta } from '../../lib/types.js';
import { buildFields } from '../../lib/settings-model.js';
import {
  createNamespaceDraftState,
  discardNamespaceDraftConflicts,
  reconcileNamespaceDraftState,
  reconcileSettingsDraftStore,
  updateNamespaceDraftValue,
} from './settings-drafts.js';

function fields(
  values: Record<string, ConfigValue>,
  meta?: Record<string, FieldMeta>,
) {
  return buildFields(values, meta);
}

describe('settings-drafts', () => {
  it('keeps dirty fields, adopts clean server updates and flags same-field conflicts', () => {
    const initial = createNamespaceDraftState(
      fields(
        { mode: 'local', region: 'east' },
        { mode: { kind: 'string' }, region: { kind: 'string' } },
      ),
    );
    const dirty = updateNamespaceDraftValue(initial, 'mode', 'mine');

    const reconciled = reconcileNamespaceDraftState(
      dirty,
      fields(
        { mode: 'server', region: 'west' },
        { mode: { kind: 'string' }, region: { kind: 'string' } },
      ),
    );

    expect(reconciled.values).toEqual({ mode: 'mine', region: 'west' });
    expect(reconciled.conflicts).toEqual(['mode']);
  });

  it('discarding conflicts adopts the latest server value without touching other drafts', () => {
    const reconciled = reconcileNamespaceDraftState(
      {
        values: { mode: 'mine', region: 'west' },
        baseValues: { mode: 'local', region: 'east' },
        conflicts: ['mode'],
      },
      fields(
        { mode: 'server', region: 'west' },
        { mode: { kind: 'string' }, region: { kind: 'string' } },
      ),
    );

    const discarded = discardNamespaceDraftConflicts(
      reconciled,
      fields(
        { mode: 'server', region: 'west' },
        { mode: { kind: 'string' }, region: { kind: 'string' } },
      ),
    );

    expect(discarded.values).toEqual({ mode: 'server', region: 'west' });
    expect(discarded.conflicts).toEqual([]);
  });

  it('reconciles every namespace independently so saving A preserves dirty B', () => {
    const store = reconcileSettingsDraftStore(
      {},
      {
        meta: { mode: 'warm' },
        providers: { model: 'gpt-5.5' },
      },
      {
        meta: { kind: 'object', fields: { mode: { kind: 'string' } } },
        providers: { kind: 'object', fields: { model: { kind: 'string' } } },
      },
    );

    const dirtyStore = {
      ...store,
      providers: updateNamespaceDraftValue(store.providers, 'model', 'claude-opus'),
    };

    const reloaded = reconcileSettingsDraftStore(
      dirtyStore,
      {
        meta: { mode: 'cool' },
        providers: { model: 'gpt-5.5' },
      },
      {
        meta: { kind: 'object', fields: { mode: { kind: 'string' } } },
        providers: { kind: 'object', fields: { model: { kind: 'string' } } },
      },
    );

    expect(reloaded.meta.values.mode).toBe('cool');
    expect(reloaded.providers.values.model).toBe('claude-opus');
    expect(reloaded.providers.conflicts).toEqual([]);
  });
});
