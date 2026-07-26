import { describe, it, expect } from 'vitest';
import { createSessionFilesRoutes } from './session-files-controller.js';
import type { SessionFile } from '../session-files/session-files-contract.js';
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

describe('session-files-controller', () => {
  it('returns the files the store lists for the session', async () => {
    const files: SessionFile[] = [
      {
        path: 'C:/a/one.ts',
        name: 'one.ts',
        dir: 'C:/a',
        tool: 'create',
        firstSeenAt: '2024-01-01T00:00:00Z',
      },
    ];

    const result = await pick(
      createSessionFilesRoutes({
        sessionFiles: {
          list: (id) => {
            expect(id).toBe('s1');
            return files;
          },
        },
      }),
      'get',
      '/sessions/:sessionId/files',
    )(req({ params: { sessionId: 's1' } }));

    expect(result).toEqual({ status: 200, body: files });
  });
});
