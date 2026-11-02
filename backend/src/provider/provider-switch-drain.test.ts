import { describe, expect, it, vi } from 'vitest';
import { createProviderSwitchDrain, type ProviderSwitchDrainDeps } from './provider-switch-drain.js';
import { createActiveProviderPolicy, type ProviderExecutionLease } from './active-provider.js';
import { createProviderRoutes } from '../api/provider-controller.js';
import { createProviderRegistry } from './provider-registry.js';

function harness(overrides: Partial<ProviderSwitchDrainDeps> = {}) {
  const deps: ProviderSwitchDrainDeps = {
    blockers: () => [], quotaCapturing: () => false, stopQuota: vi.fn(),
    drainTerminals: vi.fn(async () => true), drainWarmWorkers: vi.fn(() => []),
    onDrained: vi.fn(), timeoutMs: 5_000, ...overrides,
  };
  return { deps, drain: createProviderSwitchDrain(deps) };
}
describe('provider switch drain', () => {
  it('restores old-provider warm workers through the switch endpoint after a confirmed drain but failed save', async () => {
    const events: string[] = [];
    const failure = new Error('disk full');
    let warmLease!: ProviderExecutionLease;
    const onSwitchFailed = vi.fn(() => {
      warmLease = policy.acquire('copilot', { kind: 'warm', id: 'restored', label: 'Restored old CLI worker' });
      events.push(`restart:${policy.get().providerId}`);
    });
    const policy = createActiveProviderPolicy({
      enabledProviderIds: () => ['copilot', 'claude'], isEligible: () => true,
      initialProviderId: 'copilot', onSwitchFailed,
      saveSelected: () => { events.push('save'); throw failure; },
    });
    warmLease = policy.acquire('copilot', { kind: 'warm', id: 'old', label: 'Old CLI worker' });
    const drainProviderWork = createProviderSwitchDrain({
      blockers: () => policy.get().blockers, quotaCapturing: () => false,
      stopQuota: () => { events.push('stop-quota'); },
      drainTerminals: async () => true,
      drainWarmWorkers: () => [Promise.resolve().then(() => {
        warmLease.release();
        events.push('confirmed-exit');
        return true;
      })],
      onDrained: () => { events.push('cold-fallback'); },
      timeoutMs: 5_000,
    });
    const route = createProviderRoutes({
      registry: createProviderRegistry(), executionPolicy: policy, drainProviderWork,
      microsoftSignedIn: () => false,
      bootstrapInfo: () => ({
        defaultProvider: 'copilot', providers: [{ id: 'copilot', installed: true }, { id: 'claude', installed: true }],
      }),
    }).find((candidate) => candidate.path === '/providers/switch')!;
    await expect(route.handler({
      params: {}, query: {}, body: { providerId: 'claude', remember: true, expectedRevision: 0 },
    })).rejects.toBe(failure);
    expect(events).toEqual(['stop-quota', 'confirmed-exit', 'cold-fallback', 'save', 'restart:copilot']);
    expect(policy.get()).toMatchObject({ providerId: 'copilot', revision: 0, remember: true });
    expect(onSwitchFailed).toHaveBeenCalledOnce();
    expect(policy.get().blockers).toMatchObject([{ id: 'restored' }]);
    warmLease.release();
  });

  it.each(['unconfirmed-exit', 'remaining-owner'] as const)(
    'does not restart old workers after a refused switch with %s',
    async (proof) => {
      let remainingOwner = false;
      const onSwitchFailed = vi.fn();
      const saveSelected = vi.fn();
      const policy = createActiveProviderPolicy({
        enabledProviderIds: () => ['copilot', 'claude'], isEligible: () => true,
        initialProviderId: 'copilot', saveSelected, onSwitchFailed,
        externalBlockers: () => remainingOwner ? [{ kind: 'process', id: 'native', label: 'Native owner' }] : [],
      });
      const warmLease = policy.acquire('copilot', { kind: 'warm', id: 'old', label: 'Old worker' });
      const drainProviderWork = createProviderSwitchDrain({
        blockers: () => policy.get().blockers, quotaCapturing: () => false, stopQuota: () => {},
        drainTerminals: async () => true,
        drainWarmWorkers: () => [Promise.resolve().then(() => {
          if (proof === 'unconfirmed-exit') return false;
          warmLease.release();
          return true;
        })],
        onDrained: () => { remainingOwner = true; }, timeoutMs: 5_000,
      });
      const route = createProviderRoutes({
        registry: createProviderRegistry(), executionPolicy: policy, drainProviderWork,
        microsoftSignedIn: () => false,
        bootstrapInfo: () => ({ defaultProvider: 'copilot', providers: [{ id: 'claude', installed: true }] }),
      }).find((candidate) => candidate.path === '/providers/switch')!;
      expect(await route.handler({
        params: {}, query: {}, body: { providerId: 'claude', remember: true, expectedRevision: 0 },
      })).toMatchObject({ status: 409 });
      expect(onSwitchFailed).not.toHaveBeenCalled();
      expect(saveSelected).not.toHaveBeenCalled();
      expect(policy.get().providerId).toBe('copilot');
      warmLease.release();
    },
  );
  it('only drains safe terminal, warm and idle quota owners under one bounded deadline', async () => {
    const h = harness({
      blockers: () => ['terminal', 'warm', 'process'].map((kind) => ({ kind, id: kind, label: kind }))
        .concat([{ kind: 'probe', id: 'plan-usage', label: 'Idle quota worker' }]),
      drainWarmWorkers: vi.fn(() => [Promise.resolve(true)]),
    });
    await h.drain();
    expect(h.deps.stopQuota).toHaveBeenCalledOnce();
    expect(h.deps.drainTerminals).toHaveBeenCalledWith(5_000);
    expect(h.deps.drainWarmWorkers).toHaveBeenCalledWith(5_000);
    expect(h.deps.onDrained).toHaveBeenCalledOnce();
  });
  it.each(['session', 'execution', 'queued', 'probe'])('refuses %s work before requesting any termination', async (kind) => {
    const h = harness({ blockers: () => [{ kind, id: 'running', label: 'Background work' }] });
    await expect(h.drain()).rejects.toThrow('background AI work');
    expect(h.deps.stopQuota).not.toHaveBeenCalled();
    expect(h.deps.drainTerminals).not.toHaveBeenCalled();
  });
  it('refuses actively capturing quota work and retains unconfirmed native owners', async () => {
    const capturing = harness({ quotaCapturing: () => true });
    await expect(capturing.drain()).rejects.toThrow('background AI work');
    expect(capturing.deps.stopQuota).not.toHaveBeenCalled();
    const unconfirmed = harness({ drainTerminals: async () => false });
    await expect(unconfirmed.drain()).rejects.toThrow('not confirmed');
    expect(unconfirmed.deps.onDrained).not.toHaveBeenCalled();
    const warm = harness({ drainWarmWorkers: () => [Promise.resolve(false)] });
    await expect(warm.drain()).rejects.toThrow('not confirmed');
    expect(warm.deps.onDrained).not.toHaveBeenCalled();
  });
  it('does not report a successful drain on termination errors', async () => {
    const h = harness({ drainTerminals: async () => { throw new Error('kill failed'); } });
    await expect(h.drain()).rejects.toThrow('kill failed');
    expect(h.deps.onDrained).not.toHaveBeenCalled();
  });
});
