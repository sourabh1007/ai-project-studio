import { describe, expect, it, vi } from 'vitest';
import { createMobileRoutes } from './mobile-controller.js';
import type { MobileService } from './mobile-service.js';
import type { MobileChat } from './mobile-contract.js';

const id = '4aab198c-3c7c-4c99-b991-dde94cf52735';
const chat: MobileChat = {
  id, version: 1, repoId: id, attachmentId: id, featureId: id, title: 'Task', status: 'plan-ready',
  messages: [], proposal: null, files: [], approval: null, consumedApprovalId: null,
  terminalSessionId: null, terminalRunning: false, error: null, createdAt: '', updatedAt: '', run: null, planHash: null,
};
function harness() {
  const result = vi.fn(() => chat);
  const asyncResult = vi.fn(async () => chat);
  const service: MobileService = {
    bootstrap: vi.fn(() => ({ repositories: [], chats: [chat] })),
    get: result, create: result, discuss: result, applyPlan: result, implement: result,
    preview: asyncResult, publish: result, cancel: result, terminal: asyncResult, closeTerminal: asyncResult,
    retryPlan: result, importRepository: vi.fn(async () => ({ id, name: 'owner/repo', remoteUrl: '', defaultBranch: 'main' })),
    terminalAllowed: () => false, diff: vi.fn(async () => ({ path: 'file.ts', diff: '+new', content: 'new' })),
    waitForIdle: async () => undefined,
  };
  return { service, routes: createMobileRoutes(service) };
}
describe('allowlisted mobile routes', () => {
  it('wires only the intended operations and validates all mutation envelopes', async () => {
    const h = harness();
    const bodies: Record<string, unknown> = {
      '/chats': { id, repoId: id, problem: 'Fix this' },
      '/chats/:id/messages': { id, text: 'Please refine' },
      '/chats/:id/apply-plan': { plan: 'Approved proposed plan' },
      '/chats/:id/implement': { planHash: 'a'.repeat(64) },
      '/chats/:id/publish': { approvalId: id },
      '/chats/:id/terminal': { confirmed: true },
      '/repositories': { name: 'owner/repo', confirmed: true },
    };
    for (const route of h.routes) {
      const response = await route.handler({ params: { id }, query: { path: 'file.ts' }, body: bodies[route.path] ?? {} });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
    }
    expect(h.routes).toHaveLength(14);
    expect(h.service.publish).toHaveBeenCalledWith(id, id);
    expect(h.service.importRepository).toHaveBeenCalledWith('owner/repo');
    expect(h.service.diff).toHaveBeenCalledWith(id, 'file.ts');
    expect(h.routes.find((route) => route.path.endsWith('apply-plan'))?.method).toBe('put');
  });
  it('rejects invalid IDs, unconfirmed operations, unknown fields and missing paths', async () => {
    const h = harness();
    for (const path of ['/chats', '/chats/:id/messages', '/chats/:id/apply-plan',
      '/chats/:id/implement', '/chats/:id/publish', '/chats/:id/terminal', '/repositories']) {
      const route = h.routes.find((item) => item.path === path)!;
      await expect(Promise.resolve().then(() => route.handler({ params: { id }, query: {}, body: { confirmed: false } }))).rejects.toThrow('Invalid mobile');
    }
    const get = h.routes.find((route) => route.path === '/chats/:id')!;
    expect(() => get.handler({ params: { id: 'bad' }, query: {}, body: null })).toThrow('Invalid mobile');
    const diff = h.routes.find((route) => route.path.endsWith('/diff'))!;
    await expect(diff.handler({ params: { id }, query: {}, body: null })).rejects.toThrow('Invalid mobile');
  });
});
