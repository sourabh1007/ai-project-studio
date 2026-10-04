import { describe, expect, it, vi } from 'vitest';
import type { ContextDocument } from './context-contract.js';
import type { ContextService } from './context-service.js';
import { contextDefaults } from './config.js';
import {
  seedWorkspaceContext,
  type WorkspaceContextSeederDeps,
} from './workspace-context-seed.js';

const DEFAULT = contextDefaults.defaultWorkspaceContext;

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
    content: overrides.content ?? DEFAULT,
  };
  return { deps, get, setContent };
}

describe('seedWorkspaceContext', () => {
  it('writes the configured default when no workspace document exists', () => {
    const { deps, get, setContent } = makeDeps();

    seedWorkspaceContext(deps);

    expect(get).toHaveBeenCalledWith('workspace', '');
    expect(setContent).toHaveBeenCalledWith({
      scope: 'workspace',
      scopeId: '',
      content: DEFAULT,
      updatedBy: 'import',
    });
  });

  it('does not overwrite a workspace document the user has filled in', () => {
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

  it('repopulates a blank workspace document from the configured default', () => {
    const existing: ContextDocument = {
      scope: 'workspace',
      scopeId: '',
      content: '   \n  ',
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: 'manual',
    };
    const { deps, setContent } = makeDeps({ existing });

    seedWorkspaceContext(deps);

    expect(setContent).toHaveBeenCalledWith({
      scope: 'workspace',
      scopeId: '',
      content: DEFAULT,
      updatedBy: 'import',
    });
  });

  it('does nothing when the configured default is blank (seeding disabled)', () => {
    const { deps, get, setContent } = makeDeps({ content: '   ' });

    seedWorkspaceContext(deps);

    expect(get).not.toHaveBeenCalled();
    expect(setContent).not.toHaveBeenCalled();
  });
});
