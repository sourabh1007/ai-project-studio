import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { initialLiveState, type LiveState } from '../../lib/stream.js';
import type { Feature, FeatureUsage, Repository, RepositoryContext, Session } from '../../lib/types.js';
import { formatAic } from '../../lib/format.js';
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
  onOpenPrReview: vi.fn(),
  onOpenReviewBoard: vi.fn(),
  onOpenRepo: vi.fn(),
  onRenameSession: vi.fn(),
  onRenameFeature: vi.fn(),
  onDeleteFeature: vi.fn(),
  onDeleteSession: vi.fn(),
  onCollapse: vi.fn(),
};

describe('Explorer repository context gating', () => {
  it('shows unknown live-only usage until the complete persisted rollup arrives', async () => {
    const session: Session = {
      id: 's1', featureId: feature.id, name: 'Quota session', provider: 'copilot',
      requestedModel: 'auto', resolvedModel: null, status: 'completed', kind: 'dev',
      prompt: '', usageFilePath: '', createdAt: feature.createdAt, startedAt: null,
      endedAt: null, exitCode: 0, groupId: null,
    };
    let resolveUsage!: (value: FeatureUsage) => void;
    const savedUsage = new Promise<FeatureUsage>((resolve) => { resolveUsage = resolve; });
    const client = {
      ...api(context('ready', 't')),
      listSessions: vi.fn().mockResolvedValue([session]),
      listGroups: vi.fn().mockResolvedValue([]),
      listSessionSkills: vi.fn().mockResolvedValue([]),
      getFeatureUsage: vi.fn().mockReturnValue(savedUsage),
    };
    render(
      <ApiProvider value={client}>
        <Explorer live={{ ...initialLiveState, usageHistoryTruncated: true }}
          activeSessionId={null} names={{}} {...callbacks} />
      </ApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: `Expand ${feature.name}` }));
    expect(await screen.findByText('Usage pending')).toBeInTheDocument();
    const totals = {
      sessions: 1, inputTokens: 123, outputTokens: 456, reasoningOutputTokens: 0,
      cost: 1, credits: 987, nanoAiu: 987000000000,
    };
    await act(async () => resolveUsage({
      totals, groups: [], byModel: [], byProvider: [], byDay: [], timing: { totalActiveMs: 0 },
      bySession: [{
        ...totals, sessionId: session.id, groupId: null, origin: 'user',
        provider: session.provider, kind: session.kind, status: session.status,
        startedAt: null, endedAt: null, activeMs: 0,
      }],
    }));
    await waitFor(() => expect(screen.queryByText('Usage pending')).toBeNull());
    expect(screen.getByRole('button', { name: 'Usage breakdown for Quota session' }))
      .toHaveTextContent(formatAic(totals.nanoAiu));
  });

  it('keeps new sessions enabled while context is still analyzing', async () => {
    const client = api(context('pending', '2025-01-01T00:00:01Z'));
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

    const newSession = await screen.findByRole('button', {
      name: 'New session in Context UI',
    });
    // Session launch never blocks on repository context (the backend composes
    // it lazily and omits it when not ready), and the analysis status lives on
    // the repo page — so the feature row shows neither a disabled + nor an
    // inline notice.
    expect(newSession).toBeEnabled();
    expect(newSession).toHaveAttribute('title', 'New session');
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

  it('never shows an inline context-failure notice under a feature', async () => {
    const failed: RepositoryContext = {
      ...context('failed', '2025-01-01T00:00:01Z'),
      failure: { message: 'clone failed' } as RepositoryContext['failure'],
    };
    const live: LiveState = {
      ...initialLiveState,
      repositoryContexts: { r1: failed },
    };
    render(
      <ApiProvider value={api(context('pending', '2025-01-01T00:00:01Z'))}>
        <Explorer
          live={live}
          activeSessionId={null}
          names={{}}
          {...callbacks}
        />
      </ApiProvider>,
    );
    const newSession = await screen.findByRole('button', {
      name: 'New session in Context UI',
    });
    // The failure is surfaced on the repo page (with Rescan / Sign in), not
    // repeated under every feature, and it must not disable session creation.
    expect(newSession).toBeEnabled();
    expect(screen.queryByText(/failed: clone failed/i)).not.toBeInTheDocument();
  });
});
