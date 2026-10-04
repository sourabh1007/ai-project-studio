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
  overrides: { existing?: ContextDocument | null; content?: string } = {},
): {
  deps: WorkspaceContextSeederDeps;
  get: ReturnType<typeof vi.fn>;
  setContent: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn(() => overrides.existing ?? null);
  const setContent = vi.fn();
  const contexts: Contexts = {
    get: get as unknown as Contexts['get'],
    setContent: setContent as unknown as Contexts['setContent'],
  };
  const deps: WorkspaceContextSeederDeps = {
    contexts,
    content: overrides.content ?? DEFAULT_WORKSPACE_CONTEXT,
  };
  return { deps, get, setContent };
}

describe('seedWorkspaceContext', () => {
  it('writes the default content when no workspace document exists', () => {
    const { deps, get, setContent } = makeDeps();

    seedWorkspaceContext(deps);

    expect(get).toHaveBeenCalledWith('workspace', '');
    expect(setContent).toHaveBeenCalledWith({
      scope: 'workspace',
      scopeId: '',
      content: DEFAULT_WORKSPACE_CONTEXT,
      updatedBy: 'import',
    });
  });

  it('does not overwrite an existing workspace document', () => {
    const existing: ContextDocument = {
      scope: 'workspace',
      scopeId: '',
      content: 'My own notes',
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'manual',
    };
    const { deps, setContent } = makeDeps({ existing });

    seedWorkspaceContext(deps);

    expect(setContent).not.toHaveBeenCalled();
  });

  it('does not resurrect a document the user cleared to blank', () => {
    const existing: ContextDocument = {
      scope: 'workspace',
      scopeId: '',
      content: '',
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'manual',
    };
    const { deps, setContent } = makeDeps({ existing });

    seedWorkspaceContext(deps);

    expect(setContent).not.toHaveBeenCalled();
  });
});
