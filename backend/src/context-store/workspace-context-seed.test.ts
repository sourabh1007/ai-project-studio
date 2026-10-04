import { describe, expect, it, vi } from 'vitest';
import type { ContextDocument } from './context-contract.js';
import type { ContextService } from './context-service.js';
import {
  DEFAULT_WORKSPACE_CONTEXT,
  seedWorkspaceContext,
  type WorkspaceContextSeederDeps,
} from './workspace-context-seed.js';

type Contexts = Pick<ContextService, 'get' | 'setContent'>;

function makeDeps(
  overrides: Partial<WorkspaceContextSeederDeps> & {
    existing?: ContextDocument | null;
    seeded?: boolean;
  } = {},
): {
  deps: WorkspaceContextSeederDeps;
  get: ReturnType<typeof vi.fn>;
  setContent: ReturnType<typeof vi.fn>;
  markSeeded: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(() => overrides.existing ?? null);
  const setContent = vi.fn();
  const markSeeded = vi.fn();
  const contexts: Contexts = {
    get: get as unknown as Contexts['get'],
    setContent: setContent as unknown as Contexts['setContent'],
  };
  const deps: WorkspaceContextSeederDeps = {
    contexts,
    hasSeeded: () => overrides.seeded ?? false,
    markSeeded,
    content: overrides.content ?? DEFAULT_WORKSPACE_CONTEXT,
  };
  return { deps, get, setContent, markSeeded };
}

describe('seedWorkspaceContext', () => {
  it('writes the default content into an empty workspace document once', () => {
    const { deps, get, setContent, markSeeded } = makeDeps();

    seedWorkspaceContext(deps);

    expect(get).toHaveBeenCalledWith('workspace', '');
    expect(setContent).toHaveBeenCalledWith({
      scope: 'workspace',
      scopeId: '',
      content: DEFAULT_WORKSPACE_CONTEXT,
      updatedBy: 'import',
    });
    expect(markSeeded).toHaveBeenCalledTimes(1);
  });

  it('never runs again once the one-time seed is marked', () => {
    const { deps, get, setContent, markSeeded } = makeDeps({ seeded: true });

    seedWorkspaceContext(deps);

    expect(get).not.toHaveBeenCalled();
    expect(setContent).not.toHaveBeenCalled();
    expect(markSeeded).not.toHaveBeenCalled();
  });

  it('does not overwrite a workspace document the user already curated', () => {
    const existing: ContextDocument = {
      scope: 'workspace',
      scopeId: '',
      content: 'My own notes',
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'manual',
    };
    const { deps, setContent, markSeeded } = makeDeps({ existing });

    seedWorkspaceContext(deps);

    expect(setContent).not.toHaveBeenCalled();
    expect(markSeeded).toHaveBeenCalledTimes(1);
  });

  it('treats a blank existing document as empty and seeds it', () => {
    const existing: ContextDocument = {
      scope: 'workspace',
      scopeId: '',
      content: '   \n  ',
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'manual',
    };
    const { deps, setContent, markSeeded } = makeDeps({
      existing,
      content: 'seed me',
    });

    seedWorkspaceContext(deps);

    expect(setContent).toHaveBeenCalledWith({
      scope: 'workspace',
      scopeId: '',
      content: 'seed me',
      updatedBy: 'import',
    });
    expect(markSeeded).toHaveBeenCalledTimes(1);
  });
});
