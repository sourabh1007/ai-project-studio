import { describe, it, expect, vi } from 'vitest';
import { createActiveProviderPolicy, type ActiveProviderPolicyDeps } from './active-provider.js';
import { PROVIDER_SELECTION_NAMESPACE, providerSelectionConfigSchema, providerSelectionDefaults } from './provider-selection/config.js';

function setup(overrides: Partial<ActiveProviderPolicyDeps> = {}) {
  const saveSelected = vi.fn();
  const policy = createActiveProviderPolicy({
    enabledProviderIds: () => ['copilot', 'claude', 'agency'],
    isEligible: (id) => id !== 'agency',
    initialProviderId: 'copilot',
    saveSelected,
    ...overrides,
  });
  return { policy, saveSelected };
}

describe('active provider policy', () => {
  it('validates the module configuration', () => {
    expect(PROVIDER_SELECTION_NAMESPACE).toBe('providerSelection');
    expect(providerSelectionConfigSchema.parse(providerSelectionDefaults)).toEqual({ providerId: null, allowInternalAgency: false });
    expect(providerSelectionConfigSchema.parse({ providerId: ' claude ' })).toEqual({ providerId: 'claude', allowInternalAgency: false });
    expect(providerSelectionConfigSchema.safeParse({ providerId: '' }).success).toBe(false);
  });

  it('requires explicit setup and never executes the fallback', () => {
    const { policy } = setup({ initialProviderId: null, defaultProviderId: 'copilot' });
    expect(policy.get()).toEqual({ providerId: null, selectionRequired: true, revision: 0, blockers: [], remember: false });
    expect(() => policy.acquire()).toThrow('Choose an active CLI');
    expect(() => policy.assertActive('copilot')).toThrow('Choose an active CLI');
    expect(policy.select('claude')).toMatchObject({ providerId: 'claude', revision: 1, selectionRequired: false });
  });

  it('rejects unavailable and ineligible providers including stale persisted choices', () => {
    const { policy } = setup({ initialProviderId: 'agency' });
    expect(policy.get().providerId).toBeNull();
    expect(() => policy.select('agency')).toThrow('not enabled and eligible');
    expect(() => policy.select('missing')).toThrow('not enabled and eligible');
    expect(() => policy.acquire('agency')).toThrow('Choose an active CLI');
  });

  it('persists synchronously before committing and does not change on failure', () => {
    let policy!: ReturnType<typeof setup>['policy'];
    const save = vi.fn(() => {
      expect(policy.get().providerId).toBe('copilot');
      throw new Error('disk full');
    });
    policy = setup({ saveSelected: save }).policy;
    expect(() => policy.select('claude')).toThrow('disk full');
    expect(policy.get()).toMatchObject({ providerId: 'copilot', revision: 0 });
    expect(save).toHaveBeenCalledWith('claude');
  });

  it('prevents reentrant execution or selection from synchronous persistence notifications', () => {
    let policy!: ReturnType<typeof setup>['policy'];
    policy = setup({
      saveSelected: () => {
        expect(() => policy.acquire('copilot')).toThrow('being persisted');
        expect(() => policy.select('copilot')).toThrow('being persisted');
      },
    }).policy;
    expect(policy.select('claude')).toMatchObject({ providerId: 'claude', revision: 1 });
  });

  it('retains every independent lease until released, with idempotent release', () => {
    const { policy, saveSelected } = setup();
    const owner = { kind: 'terminal', id: 'one', label: 'Interactive session' };
    const first = policy.acquire('copilot', owner);
    const second = policy.acquire();
    const snapshot = policy.get();
    snapshot.blockers[0].label = 'mutated';
    expect(policy.get().blockers[0].label).toBe(owner.label);
    expect(() => policy.select('claude')).toThrow(expect.objectContaining({
      kind: 'conflict', details: expect.objectContaining({ code: 'provider_switch_blocked', blockers: expect.any(Array) }),
    }));
    expect(policy.select('copilot').revision).toBe(0);
    expect(saveSelected).not.toHaveBeenCalled();
    first.release();
    first.release();
    expect(policy.get().blockers).toHaveLength(1);
    second.release();
    expect(policy.select('claude')).toMatchObject({ providerId: 'claude', revision: 1 });
    expect(() => policy.acquire('copilot')).toThrow('not the active');
    expect(() => policy.assertActive('agency')).toThrow('not the active');
  });

  it('includes external queued, warming and probe ownership', () => {
    const blocker = { kind: 'warming', id: 'pool', label: 'Warm pool' };
    const externalBlockers = vi.fn(() => [blocker]);
    const { policy } = setup({ externalBlockers });
    expect(() => policy.select('claude')).toThrow('Stop all CLI work');
    externalBlockers.mockReturnValue([]);
    expect(policy.select('claude').blockers).toEqual([]);
  });

  it('rechecks runtime eligibility before admission', () => {
    let allowed = true;
    const { policy } = setup({ isEligible: () => allowed });
    const lease = policy.acquire('copilot');
    allowed = false;
    expect(policy.get().selectionRequired).toBe(true);
    expect(() => policy.acquire('copilot')).toThrow('Choose an active CLI');
    lease.release();
  });

  it('does not silently activate a stale unavailable provider when operator availability later changes', () => {
    let enabled = false;
    const { policy } = setup({ initialProviderId: 'agency', isEligible: () => enabled });
    enabled = true;
    expect(policy.get()).toMatchObject({ providerId: null, selectionRequired: true });
    expect(policy.select('agency')).toMatchObject({ providerId: 'agency', selectionRequired: false });
  });

  it('clears a remembered selection for this launch only and supports same-provider preference changes', () => {
    const { policy, saveSelected } = setup();
    expect(policy.get().remember).toBe(true);
    const lease = policy.acquire();
    expect(policy.select('copilot', false)).toMatchObject({ providerId: 'copilot', remember: false, revision: 1 });
    expect(saveSelected).toHaveBeenLastCalledWith(null);
    expect(policy.acquire().providerId).toBe('copilot');
    expect(setup({ initialProviderId: null }).policy.get().selectionRequired).toBe(true);
    expect(policy.select('copilot', true)).toMatchObject({ remember: true, revision: 2 });
    expect(saveSelected).toHaveBeenLastCalledWith('copilot');
    lease.release();
  });

  it('fences execution and concurrent changes for the whole asynchronous drain', async () => {
    const { policy, saveSelected } = setup();
    const lease = policy.acquire();
    let finish!: () => void;
    const drain = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const switching = policy.switchTo('claude', false, 0, drain);
    expect(() => policy.acquire()).toThrow('being persisted');
    expect(() => policy.select('copilot')).toThrow('being persisted');
    await expect(policy.switchTo('copilot', true, 0, drain)).rejects.toThrow('being persisted');
    expect(policy.get().providerId).toBe('copilot');
    lease.release();
    finish();
    expect(await switching).toMatchObject({ providerId: 'claude', remember: false, revision: 1 });
    expect(saveSelected).toHaveBeenCalledWith(null);
    await expect(policy.switchTo('copilot', true, 0, drain)).rejects.toThrow('changed');
  });

  it('preserves the previous choice on unconfirmed exit, drain error and save failure', async () => {
    const { policy, saveSelected } = setup();
    const lease = policy.acquire();
    await expect(policy.switchTo('claude', true, 0, async () => {})).rejects.toThrow('Stop all CLI');
    expect(policy.get()).toMatchObject({ providerId: 'copilot', revision: 0 });
    lease.release();
    await expect(policy.switchTo('claude', true, 0, async () => { throw new Error('timeout'); })).rejects.toThrow('timeout');
    saveSelected.mockImplementation(() => { throw new Error('disk full'); });
    await expect(policy.switchTo('claude', true, 0, async () => {})).rejects.toThrow('disk full');
    expect(policy.get()).toMatchObject({ providerId: 'copilot', remember: true, revision: 0 });
    expect(policy.acquire().providerId).toBe('copilot');
  });

  it('rechecks entitlement after draining and skips drain for preference-only changes', async () => {
    let eligible = true;
    const { policy } = setup({ isEligible: () => eligible, initialRemember: false });
    const drain = vi.fn(async () => { eligible = false; });
    expect(await policy.switchTo('copilot', true, 0, drain)).toMatchObject({ remember: true });
    expect(drain).not.toHaveBeenCalled();
    await expect(policy.switchTo('claude', true, 1, drain)).rejects.toThrow('not enabled and eligible');
    expect(policy.get().selectionRequired).toBe(true);
  });
});
