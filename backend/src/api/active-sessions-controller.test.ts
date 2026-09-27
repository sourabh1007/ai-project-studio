import { describe, expect, it, vi } from 'vitest';
import { createActiveSessionsRoutes } from './active-sessions-controller.js';
import type { HttpRequest } from './http-contract.js';

describe('read-only active session routes', () => {
  it('serves safe snapshots/debug without a mutation or attach route', async () => {
    const snapshot = { sampledAt: 1, pollMs: 3000, entries: [] };
    const debug = { sampledAt: 1, entry: null, state: 'unavailable', activity: [], output: '', error: null, truncated: false };
    const service = { snapshot: () => snapshot, debug: vi.fn(() => debug) };
    const routes = createActiveSessionsRoutes(service);
    const request: HttpRequest = { params: {}, query: {}, body: null };
    expect(routes.map((route) => route.method)).toEqual(['get', 'get']);
    expect(await routes[0].handler(request)).toEqual({ status: 200, body: snapshot });
    expect(await routes[1].handler({ ...request, params: { id: 'warm:s1' } })).toEqual({ status: 200, body: debug });
    expect(service.debug).toHaveBeenCalledWith('warm:s1');
    for (const id of [undefined, '', 'bad', 'warm:', `session:${'x'.repeat(513)}`]) {
      expect(await routes[1].handler({ ...request, params: id === undefined ? {} : { id } })).toMatchObject({ status: 400 });
    }
  });
});
