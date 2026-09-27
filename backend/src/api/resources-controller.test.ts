import { describe, expect, it, vi } from 'vitest';
import { createResourcesRoutes } from './resources-controller.js';
import type { ResourceCleanup, ResourcesService } from '../resources/resources-contract.js';
import { createProcessAttribution } from '../resources/process-attribution.js';
import { initialStorage } from '../resources/storage-scanner.js';

describe('resource API', () => {
  const req = (body: unknown) => ({ body, params: {}, query: {} });
  const setup = () => {
    const service = {
      snapshot: vi.fn(() => ({
        sampledAt: 100, app: createProcessAttribution(2, 0, 30000)({ measuredAt: 100, logicalCpuCount: 1, processes: [] }),
        storage: initialStorage(false), cleanups: [],
      })), refreshStorage: vi.fn(() => ({ accepted: true })),
      requestCleanup: vi.fn(() => ({ status: 'queued' })),
    } as unknown as ResourcesService;
    return { service, routes: createResourcesRoutes(service) };
  };
  it('is optional for existing compositions and exposes only cached reads/explicit actions', async () => {
    expect(createResourcesRoutes()).toEqual([]);
    const { routes, service } = setup();
    expect(await routes[0]!.handler(req(undefined))).toMatchObject({ status: 200, body: { measuredAt: 100, cleanups: [] } });
    expect(await routes[1]!.handler(req(undefined))).toMatchObject({ status: 202, body: { measuredAt: 100, storage: { status: 'unavailable' } } });
    expect(service.refreshStorage).toHaveBeenCalledTimes(1);
    expect(service.requestCleanup).not.toHaveBeenCalled();
  });
  it.each([null, undefined, 'logs', [], {}, { category: 'provider' }, { path: 'C:\\' }, { category: 'logs', path: 'C:\\' }])('rejects arbitrary cleanup input %j', async (body) => {
    const { routes, service } = setup();
    expect((await routes[2]!.handler(req(body))).status).toBe(400);
    expect(service.requestCleanup).not.toHaveBeenCalled();
  });
  it.each(['queued', 'running', 'completed', 'failed'] as const)('returns explicit %s cleanup jobs immediately', async (status) => {
    const { routes, service } = setup();
    vi.mocked(service.requestCleanup).mockReturnValue({ status } as ResourceCleanup);
    const result = await routes[2]!.handler(req({ category: status === 'failed' ? 'cache' : 'logs' }));
    expect(result.status).toBe(status === 'queued' || status === 'running' ? 202 : 200);
    expect(result.body).toEqual({ status });
  });
});
