import type { ResourcesService } from '../resources/resources-contract.js';
import { resourceView } from '../resources/resource-view.js';
import type { Route } from './http-contract.js';

export function createResourcesRoutes(resources?: ResourcesService): Route[] {
  if (!resources) return [];
  return [
    { method: 'get', path: '/resources', handler: () => ({ status: 200, body: resourceView(resources.snapshot()) }) },
    { method: 'post', path: '/resources/storage/refresh', handler: () => {
      resources.refreshStorage();
      return { status: 202, body: resourceView(resources.snapshot()) };
    } },
    {
      method: 'post', path: '/resources/cleanup',
      handler: ({ body }) => {
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !('category' in body) ||
          (body.category !== 'logs' && body.category !== 'cache')) {
          return { status: 400, body: { error: 'Expected exactly { category: "logs" | "cache" }. Paths are never accepted.' } };
        }
        const result = resources.requestCleanup(body.category);
        return {
          status: result.status === 'queued' || result.status === 'running' ? 202 : 200,
          body: result,
        };
      },
    },
  ];
}
