import { describe, expect, it } from 'vitest';
import { createDatabase } from '../persistence/db/connection.js';
import { createMcpUsageRepo } from '../persistence/mcp-usage-repo.js';
import { createMcpUsageRoutes } from './mcp-usage-controller.js';
import { createClock } from '../kernel/clock.js';

describe('bounded MCP observed history', () => {
  it('keeps provider, server, scope, feature and measured latency separate, caps payloads and respects provider visibility', async () => {
    const db = createDatabase({ databasePath: ':memory:' });
    try {
      const repo = createMcpUsageRepo(db);
      for (let index = 0; index < 502; index++) repo.recordObserved({
        featureId: index === 0 ? 'other' : 'feature', sessionId: 'session', callId: String(index),
        provider: 'copilot', server: 'tools', tool: 'read', origin: 'configured', scope: 'feature',
        recordedAt: '2026-01-02T00:00:00.000Z',
      });
      repo.recordCompletion({ provider: 'copilot', callId: '1', completedAt: '2026-01-02T00:00:01.000Z' });
      const query = { provider: 'copilot', server: 'tools', scope: 'feature' as const,
        from: '2026-01-01T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z' };
      expect(repo.observedHistory!({ ...query, featureId: 'other' })).toEqual([
        { callId: '0', tool: 'read', at: '2026-01-02T00:00:00.000Z', durationMs: null },
      ]);
      const routes = createMcpUsageRoutes({ mcpUsage: repo, clock: createClock() });
      const handler = routes.find((route) => route.method === 'get')!.handler;
      const request = (q: Record<string, string>) => handler({ params: {}, body: null, query: q });
      expect(await request(query)).toMatchObject({ status: 200, body: { limited: true } });
      expect((await request({ ...query, featureId: 'other' })).body).toMatchObject({ limited: false });
      expect(await request({ ...query, featureId: 'other', from: '2026-01-02T00:00:00Z', to: '2026-01-02T00:00:00.001Z' }))
        .toMatchObject({ status: 200, body: { items: [{ callId: '0' }] } });
      expect(await request({ ...query, provider: 'agency' })).toMatchObject({ status: 404 });
      const signed = createMcpUsageRoutes({ mcpUsage: repo, clock: createClock(), microsoftSignedIn: () => true })[0];
      expect(await signed.handler({ params: {}, body: null, query: { ...query, provider: 'agency' } })).toMatchObject({ status: 200 });
      const unsigned = createMcpUsageRoutes({ mcpUsage: repo, clock: createClock(), microsoftSignedIn: () => false })[0];
      expect(await unsigned.handler({ params: {}, body: null, query: { ...query, provider: 'agency' } })).toMatchObject({ status: 404 });
      for (const invalid of [{ ...query, to: query.from }, { ...query, from: 'invalid' },
        { ...query, to: '2026-04-01T00:00:00.000Z' }, { ...query, server: '' }]) {
        expect(await request(invalid)).toMatchObject({ status: 400 });
      }
      expect(repo.observedHistory!({ ...query, scope: 'internal' })).toEqual([]);
    } finally { db.close(); }
  });
});
