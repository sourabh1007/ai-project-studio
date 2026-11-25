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
  it('filters hidden provider rows before pagination and applies the same exposure rule to details', async () => {
    const repo = createMetaOperationRepo(db);
    repo.create({ ...repo.get('operation')!, operationId: 'agency', providerId: 'agency' });
    repo.create({ ...repo.get('operation')!, operationId: 'unknown', providerId: null });
    let signedIn = false;
    routes = createMetaOperationsRoutes({ operations: repo, config: metaOperationsDefaults, microsoftSignedIn: () => signedIn });
    expect(await routes[0].handler(request({ query: { limit: '1' } }))).toMatchObject({
      body: { items: [{ operationId: 'operation' }], nextCursor: 'operation' },
    });
    expect(await routes[0].handler(request({ query: { after: 'operation', limit: '1' } }))).toMatchObject({
      body: { items: [{ operationId: 'unknown' }], nextCursor: 'unknown' },
    });
    expect(await routes[1].handler(request({ params: { operationId: 'agency' } }))).toMatchObject({ status: 404 });
    signedIn = true;
    expect(await routes[1].handler(request({ params: { operationId: 'agency' } }))).toMatchObject({ status: 200 });
    routes = createMetaOperationsRoutes({ operations: repo, config: metaOperationsDefaults });
    expect(await routes[1].handler(request({ params: { operationId: 'agency' } }))).toMatchObject({ status: 200 });
  });
  it.each([
    { from: '2026-01-01T00:00:00.000Z' }, { to: '2026-01-01T00:00:00.000Z' },
    { from: 'invalid', to: 'invalid' },
    { from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
    { from: '2024-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
  ])('rejects malformed or oversized analytical windows %j', async (query) => {
    expect(await routes[0].handler(request({ query }))).toMatchObject({ status: 400 });
  });
  it('filters bounded run and agent histories without parsing labels', async () => {
    const repo = createMetaOperationRepo(db);
    repo.create({ ...repo.get('operation')!, operationId: 'typed', createdAt: '2026-01-15T00:00:00.000Z',
      correlation: { runId: 'r', agentId: 'review-board', perspectiveId: 'security' } });
    expect(await routes[0].handler(request({ query: { featureId: 'f', agentId: 'review-board', runId: 'r',
      from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' } })))
      .toMatchObject({ status: 200, body: { items: [{ operationId: 'typed', correlation: { runId: 'r' } }] } });
    expect(repo.get('typed')?.correlation).toEqual({ runId: 'r', agentId: 'review-board', perspectiveId: 'security' });
    expect(repo.listPage({ runId: 'other' }, null, 10).items).toEqual([]);
    expect(await routes[0].handler(request({ query: { from: '2026-01-15T00:00:00Z', to: '2026-01-15T00:00:00.001Z' } })))
      .toMatchObject({ status: 200, body: { items: [{ operationId: 'typed' }] } });
  });
});
