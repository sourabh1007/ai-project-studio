import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../kernel/error-types.js';
import type { ContextService } from '../context-store/context-service.js';
import type { ContextDocument } from '../context-store/context-contract.js';
import { createContextRoutes } from './context-controller.js';
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

const doc: ContextDocument = {
  scope: 'feature',
  scopeId: 'f1',
  content: '- fact',
  updatedAt: '2026-09-01T00:00:00.000Z',
  updatedBy: 'manual',
};

function harness(existing: ContextDocument | null = null) {
  const get = vi.fn(() => existing);
  const setContent = vi.fn(() => doc);
  const remember = vi.fn(() => doc);
  const context = { get, setContent, remember } as unknown as ContextService;
  return { routes: createContextRoutes({ context }), get, setContent, remember };
}

describe('context-controller', () => {
  it('reads a document, defaulting the workspace scopeId to empty', () => {
    const h = harness(doc);
    const result = pick(h.routes, 'get', '/context/:scope')(
      req({ params: { scope: 'workspace' } }),
    );
    expect(result).toEqual({ status: 200, body: doc });
    expect(h.get).toHaveBeenCalledWith('workspace', '');
  });

  it('reads a document using the scopeId query parameter', () => {
    const h = harness(doc);
    pick(h.routes, 'get', '/context/:scope')(
      req({ params: { scope: 'feature' }, query: { scopeId: 'f1' } }),
    );
    expect(h.get).toHaveBeenCalledWith('feature', 'f1');
  });

  it('returns 404 when the document is absent', async () => {
    const h = harness(null);
    const result = await pick(h.routes, 'get', '/context/:scope')(
      req({ params: { scope: 'repo' }, query: { scopeId: 'r1' } }),
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: { kind: 'not_found', message: 'No context yet' },
    });
  });

  it('rejects an unknown scope', () => {
    const h = harness();
    expect(() =>
      pick(h.routes, 'get', '/context/:scope')(req({ params: { scope: 'nope' } })),
    ).toThrow(ValidationError);
  });

  it('sets content as a manual edit on PUT', () => {
    const h = harness();
    const result = pick(h.routes, 'put', '/context/:scope')(
      req({ params: { scope: 'repo' }, body: { scopeId: 'r1', content: 'new' } }),
    );
    expect(result).toEqual({ status: 200, body: doc });
    expect(h.setContent).toHaveBeenCalledWith({
      scope: 'repo',
      scopeId: 'r1',
      content: 'new',
      updatedBy: 'manual',
    });
  });

  it('rejects a malformed PUT body', () => {
    const h = harness();
    expect(() =>
      pick(h.routes, 'put', '/context/:scope')(
        req({ params: { scope: 'repo' }, body: { scopeId: 'r1' } }),
      ),
    ).toThrow(ValidationError);
  });

  it('appends a fact on remember', () => {
    const h = harness();
    const result = pick(h.routes, 'post', '/context/:scope/remember')(
      req({ params: { scope: 'feature' }, body: { scopeId: 'f1', text: 'be nice' } }),
    );
    expect(result).toEqual({ status: 200, body: doc });
    expect(h.remember).toHaveBeenCalledWith({
      scope: 'feature',
      scopeId: 'f1',
      text: 'be nice',
    });
  });

  it('rejects an empty remember text', () => {
    const h = harness();
    expect(() =>
      pick(h.routes, 'post', '/context/:scope/remember')(
        req({ params: { scope: 'feature' }, body: { scopeId: 'f1', text: '  ' } }),
      ),
    ).toThrow(ValidationError);
  });
});
