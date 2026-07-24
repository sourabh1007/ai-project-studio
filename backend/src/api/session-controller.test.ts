import { describe, it, expect } from 'vitest';
import { createSessionRoutes } from './session-controller.js';
import type { SessionLauncher, LaunchedSession } from '../session/session-launcher.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { Logger, LogRecord } from '../kernel/logger.js';
import { createLogger } from '../kernel/logger.js';
import type { Session, StartSessionRequest } from '../session/session-contract.js';
import type { RunningSession } from '../provider/provider-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

const session: Session = {
  id: 's1',
  featureId: 'f1',
  provider: 'copilot',
  requestedModel: 'auto',
  resolvedModel: null,
  status: 'running',
  kind: 'dev',
  prompt: 'do it',
  usageFilePath: 'u.jsonl',
  createdAt: '2025-01-01T00:00:00.000Z',
  startedAt: '2025-01-01T00:00:01.000Z',
  endedAt: null,
  exitCode: null,
};

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

function harness(completion: Promise<Session>) {
  const requests: StartSessionRequest[] = [];
  const logs: LogRecord[] = [];
  const logger: Logger = createLogger('error', (r) => logs.push(r));
  const running = { sessionId: 's1' } as unknown as RunningSession;
  const launcher: SessionLauncher = {
    start: async (request) => {
      requests.push(request);
      const launched: LaunchedSession = { session, running, completion };
      return launched;
    },
  };
  const sessions = {
    listByFeature: (id: string) => [{ ...session, featureId: id }],
    get: (id: string) => (id === 's1' ? session : null),
  } as unknown as SessionRepo;
  const deleted: string[] = [];
  const admin = {
    renameFeature: () => {
      throw new Error('not used');
    },
    deleteFeature: async () => undefined,
    deleteSession: async (id: string) => void deleted.push(id),
  };
  const composeCalls: Array<{ featureId: string; prompt: string }> = [];
  const skills = {
    composeFeaturePrompt: (featureId: string, prompt: string) => {
      composeCalls.push({ featureId, prompt });
      return `[skills:${featureId}]\n${prompt}`;
    },
  };
  const routes = createSessionRoutes({ launcher, sessions, admin, skills, logger });
  return { routes, requests, logs, deleted, composeCalls };
}

describe('session-controller', () => {
  it('starts a session, injects feature skills, and returns 202', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'post', '/features/:featureId/sessions')(
      req({ params: { featureId: 'f1' }, body: { prompt: 'hello', model: 'gpt-5.4-mini' } }),
    );
    expect(result.status).toBe(202);
    expect(result.body).toBe(session);
    expect(h.requests[0]).toEqual({
      featureId: 'f1',
      prompt: '[skills:f1]\nhello',
      model: 'gpt-5.4-mini',
    });
    expect(h.composeCalls).toEqual([{ featureId: 'f1', prompt: 'hello' }]);
  });

  it('does not inject skills into meta sessions', async () => {
    const h = harness(Promise.resolve(session));
    await pick(h.routes, 'post', '/features/:featureId/sessions')(
      req({ params: { featureId: 'f1' }, body: { prompt: 'hello', kind: 'meta' } }),
    );
    expect(h.requests[0].prompt).toBe('hello');
    expect(h.composeCalls).toEqual([]);
  });

  it('logs when the background run rejects', async () => {
    const h = harness(Promise.reject(new Error('run failed')));
    await pick(h.routes, 'post', '/features/:featureId/sessions')(
      req({ params: { featureId: 'f1' }, body: { prompt: 'hello' } }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(h.logs.some((l) => l.message === 'Session run failed')).toBe(true);
  });

  it('rejects invalid start payloads', async () => {
    const h = harness(Promise.resolve(session));
    await expect(
      pick(h.routes, 'post', '/features/:featureId/sessions')(
        req({ params: { featureId: 'f1' }, body: {} }),
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('lists sessions for a feature', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'get', '/features/:featureId/sessions')(
      req({ params: { featureId: 'fX' } }),
    );
    expect(result.status).toBe(200);
    expect((result.body as Session[])[0].featureId).toBe('fX');
  });

  it('gets a session by id', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'get', '/sessions/:id')(
      req({ params: { id: 's1' } }),
    );
    expect(result).toEqual({ status: 200, body: session });
  });

  it('returns 404 for an unknown session', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'get', '/sessions/:id')(
      req({ params: { id: 'nope' } }),
    );
    expect(result.status).toBe(404);
  });

  it('deletes a session and returns its id', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'delete', '/sessions/:id')(
      req({ params: { id: 's1' } }),
    );
    expect(result).toEqual({ status: 200, body: { id: 's1' } });
    expect(h.deleted).toEqual(['s1']);
  });
});
