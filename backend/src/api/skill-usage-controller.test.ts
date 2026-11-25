import { describe, expect, it, vi } from 'vitest';
import { createSkillUsageRoutes } from './skill-usage-controller.js';
import { skillUsageDefaults } from '../skill-usage/config.js';
import type { HttpRequest } from './http-contract.js';

describe('skill usage API', () => {
  it('passes validated exclusive UTC windows to workspace and feature reads', async () => {
    const read = vi.fn(() => ({ rows: [], limited: false, maxEvents: 5000 }));
    const routes = createSkillUsageRoutes({ usage: { record: vi.fn(), read }, config: skillUsageDefaults });
    const window = { from: '2024-01-01', to: '2025-01-01' };
    await routes[0].handler({ query: { scope: 'internal', ...window }, params: {}, body: undefined });
    expect(read).toHaveBeenLastCalledWith({ scope: 'internal', window }, 5000);
    await routes[1].handler({ query: window, params: { featureId: 'f1' }, body: undefined });
    expect(read).toHaveBeenLastCalledWith({ scope: 'feature', featureId: 'f1', window }, 5000);
  });

  it.each([
    { from: '2026-01-01' },
    { to: '2026-02-01' },
    { from: '2026-02-30', to: '2026-03-10' },
    { from: '2026-99-99', to: '2027-01-01' },
    { from: 'not-a-date', to: '2026-02-01' },
    { from: '2026-02-01', to: '2026-02-01' },
    { from: '2026-02-01', to: '2026-01-01' },
    { from: '2024-01-01', to: '2025-01-02' },
  ])('rejects malformed or oversized windows before reading usage: %j', (query) => {
    const read = vi.fn();
    const routes = createSkillUsageRoutes({ usage: { record: vi.fn(), read }, config: skillUsageDefaults });
    for (const route of routes) {
      expect(() => route.handler({ query, params: { featureId: 'f1' }, body: undefined })).toThrow();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('validates scopes and bounds workspace and feature reads', async () => {
    const snapshot = { rows: [], limited: false, maxEvents: 5000 };
    const read = vi.fn(() => snapshot);
    const routes = createSkillUsageRoutes({ usage: { record: vi.fn(), read }, config: skillUsageDefaults });
    const request = (query = {}, params = {}): HttpRequest => ({ query, params, body: undefined });
    expect(await routes[0].handler(request())).toEqual({ status: 200, body: snapshot });
    expect(read).toHaveBeenLastCalledWith({ scope: 'feature' }, 5000);
    await routes[0].handler(request({ scope: 'internal' }));
    expect(read).toHaveBeenLastCalledWith({ scope: 'internal' }, 5000);
    await routes[1].handler(request({}, { featureId: 'f1' }));
    expect(read).toHaveBeenLastCalledWith({ scope: 'feature', featureId: 'f1' }, 5000);
    expect(() => routes[0].handler(request({ scope: 'everything' }))).toThrow();
  });
});
