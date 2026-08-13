import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_STORES,
  allDelegated,
  type CredentialStore,
} from './credential-storage.js';

describe('CREDENTIAL_STORES', () => {
  it('has unique ids and non-empty fields', () => {
    const ids = new Set<string>();
    for (const store of CREDENTIAL_STORES) {
      expect(ids.has(store.id)).toBe(false);
      ids.add(store.id);
      expect(store.name.length).toBeGreaterThan(0);
      expect(store.backing.length).toBeGreaterThan(0);
      expect(store.description.length).toBeGreaterThan(0);
    }
    expect(ids.size).toBe(CREDENTIAL_STORES.length);
  });
});

describe('allDelegated', () => {
  it('is true for the default catalog (nothing app-managed)', () => {
    expect(allDelegated()).toBe(true);
  });

  it('is true for an empty list', () => {
    expect(allDelegated([])).toBe(true);
  });

  it('is false when any store is app-managed', () => {
    const stores: CredentialStore[] = [
      {
        id: 'x',
        name: 'X',
        backing: 'app db',
        description: 'stored by the app',
        managedByApp: true,
      },
    ];
    expect(allDelegated(stores)).toBe(false);
  });
});
