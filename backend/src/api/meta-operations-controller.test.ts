import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../persistence/db/connection.js';
import { createMetaOperationRepo } from '../persistence/meta-operation-repo.js';
import { createMetaOperationsRoutes } from './meta-operations-controller.js';
import { metaOperationsDefaults } from '../meta/meta-operations-config.js';
import type { MetaOperation } from '../meta/meta-operation-contract.js';
import type { HttpRequest, Route } from './http-contract.js';

describe('meta operation result routes with actual SQLite', () => {
  let db: DatabaseSync;
  let routes: Route[];
  const request = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({ params: {}, query: {}, body: null, ...overrides });
  beforeEach(() => {
    db = createDatabase({ databasePath: ':memory:' });
    const repo = createMetaOperationRepo(db);
    const operation: MetaOperation = {
      operationId: 'operation', featureId: 'f', automationId: 'a', originSessionId: 'origin',
      providerId: 'copilot', requestedModel: 'auto', resolvedModel: null, sessionId: 's',
      providerSessionId: 'provider', sessionIds: ['s'], transport: 'warm-acp', state: 'completed',
      outcome: 'returned', purpose: null, label: 'Saved output', resultText: 'x'.repeat(1200),
      errorMessage: null, usageState: 'unknown', usage: null, createdAt: 't', updatedAt: 't',
      startedAt: 't', finishedAt: 't',
    };
    repo.create(operation);
    repo.create({ ...operation, operationId: 'z', resultText: null, state: 'interrupted', outcome: 'unknown' });
    routes = createMetaOperationsRoutes({ operations: repo, config: metaOperationsDefaults });
  });
  afterEach(() => db.close());

  it('lists bounded metadata, supports filters/cursors, and retrieves the entire independent saved result', async () => {
    expect(routes.map((route) => [route.method, route.path])).toEqual([['get', '/meta/operations'], ['get', '/meta/operations/:operationId']]);
    const listed = await routes[0].handler(request({ query: { featureId: 'f', sessionId: 's', automationId: 'a', limit: '1' } }));
    expect(listed).toMatchObject({ status: 200, body: { items: [{ operationId: 'operation', hasResult: true, usageState: 'unknown' }], nextCursor: 'operation' } });
    expect(JSON.stringify(listed.body)).not.toContain('x'.repeat(1200));
    expect(await routes[0].handler(request({ query: { after: 'operation', limit: '1' } }))).toMatchObject({ body: { items: [{ operationId: 'z', hasResult: false }], nextCursor: null } });
    expect(await routes[0].handler(request())).toMatchObject({ status: 200 });
    expect(await routes[1].handler(request({ params: { operationId: 'operation' } }))).toMatchObject({ status: 200, body: { resultText: 'x'.repeat(1200) } });
    expect(await routes[1].handler(request({ params: { operationId: 'z' } }))).toMatchObject({ status: 200, body: { resultText: null, outcome: 'unknown' } });
  });

  it.each([{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: '-2' }, { featureId: '' }, { after: '' }, { unexpected: 'field' }])('rejects invalid list input %j', async (query) => {
    expect(await routes[0].handler(request({ query }))).toMatchObject({ status: 400 });
  });

  it('returns explicit invalid-ID and absent-result errors', async () => {
    expect(await routes[1].handler(request())).toMatchObject({ status: 400 });
    expect(await routes[1].handler(request({ params: { operationId: 'missing' } }))).toMatchObject({ status: 404 });
  });
});
