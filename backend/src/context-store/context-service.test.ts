import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../kernel/clock.js';
import { contextDefaults } from './config.js';
import type { ContextDocument, ContextScope } from './context-contract.js';
import { createContextService } from './context-service.js';
import type { ContextStore } from './context-store-port.js';

function fakeStore(): ContextStore & { rows: Map<string, ContextDocument> } {
  const rows = new Map<string, ContextDocument>();
  const key = (scope: ContextScope, scopeId: string) => `${scope}:${scopeId}`;
  return {
    rows,
    get: (scope, scopeId) => rows.get(key(scope, scopeId)) ?? null,
    save: (doc) => {
      rows.set(key(doc.scope, doc.scopeId), doc);
    },
    delete: (scope, scopeId) => {
      rows.delete(key(scope, scopeId));
    },
  };
}

const clock: Clock = {
  now: () => new Date('2026-09-01T00:00:00.000Z'),
  isoNow: () => '2026-09-01T00:00:00.000Z',
};

function makeService(overrides: Partial<typeof contextDefaults> = {}) {
  const store = fakeStore();
  const onUpdated = vi.fn();
  const service = createContextService({
    store,
    clock,
    config: { ...contextDefaults, ...overrides },
    onUpdated,
  });
  return { store, onUpdated, service };
}

describe('context-service', () => {
  it('get delegates to the store', () => {
    const { store, service } = makeService();
    expect(service.get('feature', 'f1')).toBeNull();
    store.save({
      scope: 'feature',
      scopeId: 'f1',
      content: 'x',
      updatedAt: 't',
      updatedBy: 'manual',
    });
    expect(service.get('feature', 'f1')?.content).toBe('x');
  });

  it('setContent clamps, stamps time, saves and notifies', () => {
    const { store, onUpdated, service } = makeService({ maxDocChars: 5 });
    const doc = service.setContent({
      scope: 'feature',
      scopeId: 'f1',
      content: '   abcdefgh   ',
      updatedBy: 'import',
    });
    expect(doc).toEqual({
      scope: 'feature',
      scopeId: 'f1',
      content: 'abcde…',
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'import',
    });
    expect(store.get('feature', 'f1')).toEqual(doc);
    expect(onUpdated).toHaveBeenCalledWith(doc);
  });

  it('remember starts a bullet list when empty and prefixes plain text', () => {
    const { service } = makeService();
    const doc = service.remember({
      scope: 'workspace',
      scopeId: '',
      text: 'use tabs',
    });
    expect(doc.content).toBe('- use tabs');
    expect(doc.updatedBy).toBe('manual');
  });

  it('remember appends to existing content and keeps pre-bulleted text', () => {
    const { service } = makeService();
    service.setContent({
      scope: 'feature',
      scopeId: 'f1',
      content: '- first',
      updatedBy: 'merge',
    });
    const doc = service.remember({
      scope: 'feature',
      scopeId: 'f1',
      text: '- second',
    });
    expect(doc.content).toBe('- first\n- second');
  });

  it('composeLayered gathers workspace, repo and feature layers', () => {
    const { service } = makeService();
    service.setContent({
      scope: 'workspace',
      scopeId: '',
      content: '- w',
      updatedBy: 'manual',
    });
    service.setContent({
      scope: 'repo',
      scopeId: 'r1',
      content: '- r',
      updatedBy: 'manual',
    });
    service.setContent({
      scope: 'feature',
      scopeId: 'f1',
      content: '- f',
      updatedBy: 'manual',
    });
    const out = service.composeLayered({ repoId: 'r1', featureId: 'f1' });
    expect(out).toContain('### Workspace');
    expect(out).toContain('- w');
    expect(out).toContain('### Repository');
    expect(out).toContain('### Feature');
  });

  it('composeLayered omits repo and feature layers when ids are absent', () => {
    const { service } = makeService();
    service.setContent({
      scope: 'workspace',
      scopeId: '',
      content: '- w',
      updatedBy: 'manual',
    });
    const out = service.composeLayered({});
    expect(out).toContain('### Workspace');
    expect(out).not.toContain('### Repository');
    expect(out).not.toContain('### Feature');
  });

  it('composeLayered falls back to empty content for absent documents', () => {
    const { service } = makeService();
    expect(service.composeLayered({ repoId: 'r1', featureId: 'f1' })).toBe('');
  });

  it('remove deletes without notifying', () => {
    const { store, onUpdated, service } = makeService();
    service.setContent({
      scope: 'repo',
      scopeId: 'r1',
      content: '- r',
      updatedBy: 'manual',
    });
    onUpdated.mockClear();
    service.remove('repo', 'r1');
    expect(store.get('repo', 'r1')).toBeNull();
    expect(onUpdated).not.toHaveBeenCalled();
  });
});
