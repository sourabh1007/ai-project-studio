import { describe, it, expect } from 'vitest';
import { createAgentRoutes } from './agent-controller.js';
import type { AgentService } from '../agents/agent-service.js';
import type { HttpRequest } from './http-contract.js';

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { params: {}, query: {}, body: undefined, ...overrides };
}

function routes(service: Partial<AgentService>) {
  const list = createAgentRoutes({ agents: service as AgentService });
  return (method: string, path: string) => {
    const route = list.find((r) => r.method === method && r.path === path)!;
    return route.handler;
  };
}

describe('agent-controller', () => {
  it('lists the catalog', async () => {
    const find = routes({ listCatalog: () => ['c'] as never });
    expect(await find('get', '/agents')(request())).toEqual({ status: 200, body: ['c'] });
  });

  it('gets one catalog item by id', async () => {
    const seen: string[] = [];
    const find = routes({
      getCatalogItem: (id) => { seen.push(id); return { manifest: { id } } as never; },
    });
    const result = await find('get', '/agents/:agentId')(request({ params: { agentId: 'review-board' } }));
    expect(seen).toEqual(['review-board']);
    expect(result).toMatchObject({ status: 200 });
  });

  it('lists attached and available agents for a feature', async () => {
    const find = routes({
      attachedAgents: (featureId) => [{ featureId }] as never,
      availableAgents: (featureId) => [{ featureId, ok: true }] as never,
    });
    expect(await find('get', '/features/:featureId/agents')(request({ params: { featureId: 'f1' } })))
      .toEqual({ status: 200, body: [{ featureId: 'f1' }] });
    expect(await find('get', '/features/:featureId/agents/available')(request({ params: { featureId: 'f1' } })))
      .toEqual({ status: 200, body: [{ featureId: 'f1', ok: true }] });
  });

  it('attaches an agent to a feature', async () => {
    const calls: Array<[string, string]> = [];
    const find = routes({
      attach: (featureId, agentId) => { calls.push([featureId, agentId]); return { id: 'att-1' } as never; },
    });
    const result = await find('post', '/features/:featureId/agents')(
      request({ params: { featureId: 'f1' }, body: { agentId: 'review-board' } }),
    );
    expect(calls).toEqual([['f1', 'review-board']]);
    expect(result).toEqual({ status: 201, body: { id: 'att-1' } });
  });

  it('rejects an attach without a valid agentId', async () => {
    const find = routes({ attach: () => ({}) as never });
    const handler = find('post', '/features/:featureId/agents');
    await expect(async () => handler(request({ params: { featureId: 'f1' }, body: {} }))).rejects.toThrow(/agentId/);
    await expect(async () => handler(request({ params: { featureId: 'f1' }, body: { agentId: '  ' } }))).rejects.toThrow(/agentId/);
    await expect(async () => handler(request({ params: { featureId: 'f1' }, body: null }))).rejects.toThrow(/agentId/);
  });

  it('detaches an attachment by id', async () => {
    const removed: string[] = [];
    const find = routes({ detach: (id) => { removed.push(id); } });
    const result = await find('delete', '/agents/attachments/:attachmentId')(
      request({ params: { attachmentId: 'att-9' } }),
    );
    expect(removed).toEqual(['att-9']);
    expect(result).toEqual({ status: 200, body: { id: 'att-9' } });
  });
});
