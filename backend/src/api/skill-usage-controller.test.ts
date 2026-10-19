import { describe, expect, it, vi } from 'vitest';
import { createSkillUsageRoutes } from './skill-usage-controller.js';
import { skillUsageDefaults } from '../skill-usage/config.js';
import type { HttpRequest } from './http-contract.js';

describe('skill usage API', () => {
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
