import { describe, it, expect } from 'vitest';
import { createSessionImportRoutes } from './session-import-controller.js';
import { ValidationError } from '../kernel/error-types.js';
import type {
  SessionImportService,
  ImportableSession,
  ImportSessionRequest,
} from '../session-import/session-import-contract.js';
import type { Session } from '../session/session-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

function pick(routes: Route[], method: string, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new Error(`route ${method} ${path} not found`);
  }
  return route.handler;
}

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

const importable: ImportableSession[] = [
  {
    externalId: 'ext-1',
    provider: 'agency',
    title: 'A session',
    cwd: '/work',
    repository: 'org/repo',
    branch: 'main',
    model: 'gpt-5.4',
    messageCount: 3,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
  },
];

const imported = { id: 'ext-1', featureId: 'f1', provider: 'agency' } as Session;

function harness() {
  const calls: ImportSessionRequest[] = [];
  const service: SessionImportService = {
    listImportable: () => importable,
    import: (request) => {
      calls.push(request);
      return imported;
    },
  };
  return { routes: createSessionImportRoutes({ imports: service }), calls };
}

describe('session-import-controller', () => {
  it('lists importable sessions', async () => {
    const result = await pick(harness().routes, 'get', '/importable-sessions')(req());
    expect(result).toEqual({ status: 200, body: importable });
  });

  it('imports a session and returns 201', async () => {
    const { routes, calls } = harness();
    const result = await pick(routes, 'post', '/features/:featureId/import-session')(
      req({ params: { featureId: 'f1' }, body: { provider: 'agency', externalId: 'ext-1' } }),
    );
    expect(result).toEqual({ status: 201, body: imported });
    expect(calls).toEqual([{ featureId: 'f1', provider: 'agency', externalId: 'ext-1' }]);
  });

  it('rejects an invalid import body', async () => {
    const handler = pick(harness().routes, 'post', '/features/:featureId/import-session');
    await expect(
      Promise.resolve().then(() => handler(req({ params: { featureId: 'f1' }, body: {} }))),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
