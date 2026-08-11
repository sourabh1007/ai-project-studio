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
  name: null,
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

function harness(
  completion: Promise<Session>,
  startError?: Error,
  options: {
    withHistory?: boolean;
    listAll?: Session[];
    historySummary?: string | null;
    historyFirstUserMessage?: string | null;
  } = {},
) {
  const requests: StartSessionRequest[] = [];
  const logs: LogRecord[] = [];
  const logger: Logger = createLogger('error', (r) => logs.push(r));
  const running = { sessionId: 's1' } as unknown as RunningSession;
  const launcher: SessionLauncher = {
    start: async (request) => {
      requests.push(request);
      if (startError) {
        throw startError;
      }
      const launched: LaunchedSession = { session, running, completion };
      return launched;
    },
  };
  const sessions = {
    listByFeature: (id: string) => [{ ...session, featureId: id }],
    listByFeatureAll: (id: string) => [
      ...(options.listAll ?? [
        { ...session, featureId: id },
        { ...session, id: 'meta1', featureId: id, kind: 'meta', prompt: '' },
      ]),
    ],
    get: (id: string) => (id === 's1' ? session : null),
  } as unknown as SessionRepo;
  const deleted: string[] = [];
  const renamed: Array<{ id: string; name: string | null }> = [];
  const admin = {
    renameFeature: () => {
      throw new Error('not used');
    },
    renameSession: (id: string, name: string | null) => {
      renamed.push({ id, name });
      return { ...session, id, name };
    },
    deleteFeature: async () => undefined,
    deleteSession: async (id: string) => void deleted.push(id),
  };
  const history = options.withHistory === false ? undefined : {
    read: (ids: string[]) =>
      ids.map((id) => ({
        sessionId: id,
        summary:
          id === 'meta1'
            ? 'historySummary' in options
              ? options.historySummary ?? null
              : 'Summarized meta work'
            : null,
        firstUserMessage:
          id === 'meta1'
            ? 'historyFirstUserMessage' in options
              ? options.historyFirstUserMessage ?? null
              : 'investigate the PR'
            : null,
        checkpoints: [],
      })),
  };
  const routes = createSessionRoutes({
    launcher,
    sessions,
    admin,
    history,
    logger,
  });
  return { routes, requests, logs, deleted, renamed };
}

describe('session-controller', () => {
  it('starts a session with the original prompt and returns 202', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'post', '/features/:featureId/sessions')(
      req({ params: { featureId: 'f1' }, body: { prompt: 'hello', model: 'gpt-5.4-mini' } }),
    );
    expect(result.status).toBe(202);
    expect(result.body).toBe(session);
    expect(h.requests[0]).toEqual({
      featureId: 'f1',
      prompt: 'hello',
      model: 'gpt-5.4-mini',
    });
  });

  it('preserves meta prompts', async () => {
    const h = harness(Promise.resolve(session));
    await pick(h.routes, 'post', '/features/:featureId/sessions')(
      req({ params: { featureId: 'f1' }, body: { prompt: 'hello', kind: 'meta' } }),
    );
    expect(h.requests[0].prompt).toBe('hello');
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

  it('propagates the typed not-ready conflict from session creation', async () => {
    const h = harness(
      Promise.resolve(session),
      Object.assign(new Error('Repository context is not ready'), {
        kind: 'conflict',
      }),
    );
    await expect(
      pick(h.routes, 'post', '/features/:featureId/sessions')(
        req({ params: { featureId: 'f1' }, body: { prompt: 'hello' } }),
      ),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect(h.logs).toEqual([]);
  });

  it('lists sessions for a feature', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'get', '/features/:featureId/sessions')(
      req({ params: { featureId: 'fX' } }),
    );
    expect(result.status).toBe(200);
    expect((result.body as Session[])[0].featureId).toBe('fX');
  });

  it('includes internal sessions and enriches their work title when requested', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'get', '/features/:featureId/sessions')(
      req({ params: { featureId: 'fX' }, query: { includeInternal: 'true' } }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'meta1',
          kind: 'meta',
          workTitle: 'investigate the PR',
        }),
      ]),
    );
  });

  it('accepts includeInternal=1 and falls back to the CLI summary for a title', async () => {
    const h = harness(Promise.resolve(session), undefined, {
      historyFirstUserMessage: null,
      historySummary: 'Summarized meta work',
    });
    const result = await pick(h.routes, 'get', '/features/:featureId/sessions')(
      req({ params: { featureId: 'fX' }, query: { includeInternal: '1' } }),
    );
    expect(result.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'meta1',
          workTitle: 'Summarized meta work',
        }),
      ]),
    );
  });

  it('lists sessions without title enrichment when history is unavailable', async () => {
    const h = harness(Promise.resolve(session), undefined, {
      withHistory: false,
    });
    const result = await pick(h.routes, 'get', '/features/:featureId/sessions')(
      req({ params: { featureId: 'fX' }, query: { includeInternal: 'true' } }),
    );
    expect((result.body as Session[]).some((item) => item.workTitle)).toBe(false);
  });

  it('does not query history for an empty session list', async () => {
    const h = harness(Promise.resolve(session), undefined, { listAll: [] });
    const result = await pick(h.routes, 'get', '/features/:featureId/sessions')(
      req({ params: { featureId: 'fX' }, query: { includeInternal: 'true' } }),
    );
    expect(result.body).toEqual([]);
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

  it('renames a session and returns the updated record', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'put', '/sessions/:id')(
      req({ params: { id: 's1' }, body: { name: 'Auth spike' } }),
    );
    expect(result.status).toBe(200);
    expect((result.body as Session).name).toBe('Auth spike');
    expect(h.renamed).toEqual([{ id: 's1', name: 'Auth spike' }]);
  });

  it('accepts a null name to clear a session name', async () => {
    const h = harness(Promise.resolve(session));
    const result = await pick(h.routes, 'put', '/sessions/:id')(
      req({ params: { id: 's1' }, body: { name: null } }),
    );
    expect(result.status).toBe(200);
    expect(h.renamed).toEqual([{ id: 's1', name: null }]);
  });

  it('rejects a rename payload missing the name field', () => {
    const h = harness(Promise.resolve(session));
    expect(() =>
      pick(h.routes, 'put', '/sessions/:id')(
        req({ params: { id: 's1' }, body: {} }),
      ),
    ).toThrow();
  });
});
