import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { initialLiveState, type LiveState } from '../../lib/stream.js';
import type { Feature, Repository, RepositoryContext } from '../../lib/types.js';
import { Explorer } from './explorer.js';

const repo: Repository = {
  id: 'r1',
  provider: 'github',
  remoteUrl: 'https://github.com/acme/app',
  name: 'acme/app',
  localPath: 'C:\\repos\\app',
  defaultBranch: 'main',
  createdAt: '2025-01-01T00:00:00Z',
};

const feature: Feature = {
  id: 'f1',
  name: 'Context UI',
  description: '',
  createdAt: '2025-01-01T00:00:00Z',
  summary: null,
  repoId: 'r1',
  checkoutPath: null,
};

function context(status: RepositoryContext['status'], updatedAt: string): RepositoryContext {
  return {
    repositoryId: 'r1',
    status,
    content: status === 'ready' ? 'summary' : null,
    sourceRevision: 'abc',
    timestamps: {
      createdAt: repo.createdAt,
      updatedAt,
      generationStartedAt: null,
      generatedAt: status === 'ready' ? updatedAt : null,
    },
    steps: [],
    failure: null,
  };
}

function api(contextValue: RepositoryContext): ApiClient {
  return {
    listRepos: vi.fn().mockResolvedValue([repo]),
    listFeatures: vi.fn().mockResolvedValue([feature]),
    getRepositoryContext: vi.fn().mockResolvedValue(contextValue),
    getRepoInsights: vi.fn().mockResolvedValue(null),
    listFeatureSkills: vi.fn().mockResolvedValue([]),
    getGithubStatus: vi.fn().mockResolvedValue({ authenticated: false, login: null }),
    getAzureStatus: vi.fn().mockResolvedValue({ authenticated: false, account: null }),
  } as unknown as ApiClient;
}

const callbacks = {
  onOpenSession: vi.fn(),
  onOpenFeature: vi.fn(),
  onOpenRepo: vi.fn(),
  onRenameSession: vi.fn(),
  onRenameFeature: vi.fn(),
  onDeleteFeature: vi.fn(),
  onDeleteSession: vi.fn(),
  onCollapse: vi.fn(),
};

describe('Explorer repository context gating', () => {
  it('disables new sessions until an SSE update marks context ready', async () => {
    const client = api(context('pending', '2025-01-01T00:00:01Z'));
    const { rerender } = render(
      <ApiProvider value={client}>
        <Explorer
          live={initialLiveState}
          activeSessionId={null}
          names={{}}
          {...callbacks}
        />
      </ApiProvider>,
    );

    const newSession = await screen.findByRole('button', {
      name: 'New session in Context UI',
    });
    expect(newSession).toBeDisabled();
    expect(screen.getByText(/pending analysis/i)).toBeInTheDocument();

    const live: LiveState = {
      ...initialLiveState,
      repositoryContexts: {
        r1: context('ready', '2025-01-01T00:00:02Z'),
      },
    };
    rerender(
      <ApiProvider value={client}>
        <Explorer live={live} activeSessionId={null} names={{}} {...callbacks} />
      </ApiProvider>,
    );
    await waitFor(() => expect(newSession).toBeEnabled());
    expect(screen.queryByText(/pending analysis/i)).not.toBeInTheDocument();
  });

  it('keeps repository-less feature session creation enabled', async () => {
    const client = {
      ...api(context('pending', '2025-01-01T00:00:01Z')),
      listRepos: vi.fn().mockResolvedValue([]),
      listFeatures: vi.fn().mockResolvedValue([{ ...feature, repoId: null }]),
    } as ApiClient;
    render(
      <ApiProvider value={client}>
        <Explorer
          live={initialLiveState}
          activeSessionId={null}
          names={{}}
          {...callbacks}
        />
      </ApiProvider>,
    );
    expect(
      await screen.findByRole('button', { name: 'New session in Context UI' }),
    ).toBeEnabled();
  });
});
