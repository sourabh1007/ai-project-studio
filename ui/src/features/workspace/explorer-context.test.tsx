import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    listFeatureAgents: vi.fn().mockResolvedValue([]),
    listAvailableAgents: vi.fn().mockResolvedValue([]),
    getGithubStatus: vi.fn().mockResolvedValue({ authenticated: false, login: null }),
    getAzureStatus: vi.fn().mockResolvedValue({ authenticated: false, account: null }),
  } as unknown as ApiClient;
}

const callbacks = {
  onOpenSession: vi.fn(),
  onOpenFeature: vi.fn(),
  onOpenPrReview: vi.fn(),
  onOpenBulkPrReview: vi.fn(),
  onOpenAgent: vi.fn(),
  onOpenRepo: vi.fn(),
  onRenameSession: vi.fn(),
  onRenameFeature: vi.fn(),
  onDeleteFeature: vi.fn(),
  onDeleteSession: vi.fn(),
  onCollapse: vi.fn(),
};

describe('Explorer repository context gating', () => {
  it('keeps sessions on one row and loads files only through the session disclosure', async () => {
    const session: Session = {
      id: 's1', featureId: feature.id, name: 'Compact session', provider: 'copilot',
      requestedModel: 'gpt-5', resolvedModel: null, status: 'completed', kind: 'dev',
      prompt: '', usageFilePath: '', createdAt: feature.createdAt, startedAt: null,
      endedAt: null, exitCode: 0, groupId: null,
    };
    const client = {
      ...api(context('ready', 't')),
      listSessions: vi.fn().mockResolvedValue([session]),
      listGroups: vi.fn().mockResolvedValue([]),
      listSessionSkills: vi.fn().mockResolvedValue([]),
      listSessionFiles: vi.fn().mockResolvedValue([
        { path: 'C:\\repo\\app.ts', name: 'app.ts', dir: 'C:\\repo', tool: 'edit' },
      ]),
      getFeatureUsage: vi.fn().mockResolvedValue(null),
    };
    const onOpenSession = vi.fn();
    render(
      <ApiProvider value={client}>
        <Explorer live={initialLiveState} activeSessionId={session.id} names={{}}
          {...callbacks} onOpenSession={onOpenSession} />
      </ApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: `Expand ${feature.name}` }));
    const row = await screen.findByRole('button', { name: session.name! });
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveAttribute('title', expect.stringContaining('Model: gpt-5'));
    expect(row).toHaveAttribute('title', expect.stringContaining('Status: completed'));
    expect(screen.queryByText('gpt-5')).toBeNull();
    expect(client.listSessionFiles).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onOpenSession).toHaveBeenCalledWith(session, 'Session #1');
    const expand = screen.getByRole('button', { name: 'Expand files for Compact session' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);
    expect(await screen.findByText('app.ts')).toBeInTheDocument();
    expect(client.listSessionFiles).toHaveBeenCalledWith(session.id);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse files for Compact session' }));
    expect(screen.queryByText('app.ts')).toBeNull();
    expect(screen.getByText('Accounts').parentElement).not.toHaveAttribute('open');
  });

  it('renders attached agents as ordinary child rows with working open and detach actions', async () => {
    const entry = {
      attachment: { id: 'a1', featureId: feature.id, agentId: 'review-board' },
      manifest: { id: 'review-board', title: 'Review Board', icon: 'scan-search' },
    };
    const client = {
      ...api(context('ready', 't')),
      listSessions: vi.fn().mockResolvedValue([]),
      listGroups: vi.fn().mockResolvedValue([]),
      getFeatureUsage: vi.fn().mockResolvedValue(null),
      listFeatureAgents: vi.fn().mockResolvedValue([entry]),
      detachAgent: vi.fn().mockResolvedValue(undefined),
    };
    const onOpenAgent = vi.fn();
    render(
      <ApiProvider value={client}>
        <Explorer live={initialLiveState} activeSessionId={null} names={{}}
          {...callbacks} onOpenAgent={onOpenAgent} />
      </ApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: `Expand ${feature.name}` }));
    const group = await screen.findByRole('group', { name: `Agents for ${feature.name}` });
    expect(group.querySelector('.attached-agents-label')).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Review Board' }));
    expect(onOpenAgent).toHaveBeenCalledWith(feature, entry);
    fireEvent.click(within(group).getByRole('button', { name: 'Detach Review Board' }));
    await waitFor(() => expect(client.detachAgent).toHaveBeenCalledWith('a1'));
  });

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
    expect(await screen.findByRole('button', { name: 'Quota session' }))
      .toHaveAttribute('title', expect.stringContaining('Usage pending'));
    const totals = {
      sessions: 1, inputTokens: 123, outputTokens: 456, reasoningOutputTokens: 0,
      cost: 1, credits: 987, nanoAiu: 987000000000,
    };
    await act(async () => resolveUsage({
      totals, groups: [], byModel: [], byProvider: [], byDay: [], byMcpServer: [], timing: { totalActiveMs: 0 },
      bySession: [{
        ...totals, sessionId: session.id, groupId: null, origin: 'user',
        provider: session.provider, kind: session.kind, status: session.status,
        startedAt: null, endedAt: null, activeMs: 0,
      }],
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Quota session' }))
      .not.toHaveAttribute('title', expect.stringContaining('Usage pending')));
    expect(screen.getByRole('button', { name: 'Usage breakdown for Quota session' }))
      .toHaveAttribute('title', expect.stringContaining(formatAic(totals.nanoAiu)));
    expect(document.querySelector('.session-summary-row')).toBeNull();
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

  it('labels unnamed sessions by their stable creation sequence, not tree position', async () => {
    // Two sessions returned in an order that does not match their creation
    // sequence: positional numbering would render "#1"/"#2", but the stable
    // seq must drive the fallback label so a move/reorder never renames them.
    const base = {
      featureId: feature.id, name: null, provider: 'copilot', requestedModel: 'auto',
      resolvedModel: null, status: 'completed' as const, kind: 'dev' as const,
      prompt: '', usageFilePath: '', createdAt: feature.createdAt, startedAt: null,
      endedAt: null, exitCode: 0, groupId: null,
    };
    const sessions: Session[] = [
      { ...base, id: 'sa', seq: 7 },
      { ...base, id: 'sb', seq: 3 },
    ];
    const client = {
      ...api(context('ready', 't')),
      listSessions: vi.fn().mockResolvedValue(sessions),
      listGroups: vi.fn().mockResolvedValue([]),
      listSessionSkills: vi.fn().mockResolvedValue([]),
      getFeatureUsage: vi.fn().mockResolvedValue(null),
    };
    render(
      <ApiProvider value={client}>
        <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks} />
      </ApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: `Expand ${feature.name}` }));
    expect(await screen.findByText('Session #7')).toBeInTheDocument();
    expect(screen.getByText('Session #3')).toBeInTheDocument();
    expect(screen.queryByText('Session #1')).toBeNull();
    expect(screen.queryByText('Session #2')).toBeNull();
  });

  it('restores expanded features after the Explorer unmounts and remounts', async () => {
    const client = {
      ...api(context('ready', 't')),
      listSessions: vi.fn().mockResolvedValue([]),
      listGroups: vi.fn().mockResolvedValue([]),
      listSessionSkills: vi.fn().mockResolvedValue([]),
      getFeatureUsage: vi.fn().mockResolvedValue(null),
    };
    const tree = (
      <ApiProvider value={client}>
        <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks} />
      </ApiProvider>
    );
    const first = render(tree);
    fireEvent.click(await screen.findByRole('button', { name: `Expand ${feature.name}` }));
    // Expanding persists, so the collapse affordance is now present.
    await screen.findByRole('button', { name: `Collapse ${feature.name}` });
    // Navigating away unmounts the Explorer; navigating back remounts it fresh.
    first.unmount();
    render(tree);
    // The feature is expanded again from persisted state, not collapsed.
    expect(
      await screen.findByRole('button', { name: `Collapse ${feature.name}` }),
    ).toBeInTheDocument();
  });

  it('removes the repository-less Scratchpad group and its orphan features', async () => {
    const orphan = { ...feature, repoId: null };
    const client = {
      ...api(context('pending', '2025-01-01T00:00:01Z')),
      listRepos: vi.fn().mockResolvedValue([]),
      listFeatures: vi.fn().mockResolvedValue([orphan]),
    } as ApiClient;
    const onDeleteFeature = vi.fn().mockResolvedValue(undefined);
    render(
      <ApiProvider value={client}>
        <Explorer
          live={initialLiveState}
          activeSessionId={null}
          names={{}}
          {...callbacks}
          onDeleteFeature={onDeleteFeature}
        />
      </ApiProvider>,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for Scratchpad' }),
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove Scratchpad' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm remove Scratchpad' }),
    );

    await waitFor(() => expect(onDeleteFeature).toHaveBeenCalledWith(orphan));
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

describe('Explorer row action trail', () => {
  function fullClient(status: RepositoryContext['status'] = 'ready'): ApiClient {
    return {
      ...api(context(status, 't')),
      listSessions: vi.fn().mockResolvedValue([]),
      listGroups: vi.fn().mockResolvedValue([]),
      listSessionSkills: vi.fn().mockResolvedValue([]),
      getFeatureUsage: vi.fn().mockResolvedValue(null),
    } as unknown as ApiClient;
  }

  it('groups the repository row actions in a collapsible hover trail', async () => {
    render(
      <ApiProvider value={fullClient()}>
        <Explorer
          live={initialLiveState}
          activeSessionId={null}
          names={{}}
          {...callbacks}
        />
      </ApiProvider>,
    );
    const repoTitle = await screen.findByRole('button', { name: 'acme/app' });
    const branch = repoTitle.closest('.repo-branch') as HTMLElement;
    expect(branch).toBeTruthy();

    // The title stays outside the trail so it always gets the full row width.
    expect(repoTitle.closest('.tree-branch-trail')).toBeNull();

    // Provider chip, add menu and overflow all share the one hover trail.
    const trail = branch.querySelector('.tree-branch-trail') as HTMLElement;
    expect(trail).toBeTruthy();
    expect(within(trail).getByText('GitHub')).toBeInTheDocument();
    expect(
      within(trail).getByRole('button', { name: 'Add to acme/app' }),
    ).toBeInTheDocument();
    expect(
      within(trail).getByRole('button', { name: 'Actions for acme/app' }),
    ).toBeInTheDocument();

    // The status badge stays in-flow (a glanceable dot), never in the trail.
    const badge = screen.getByRole('button', {
      name: /View repository context/,
    });
    expect(badge.closest('.tree-branch-trail')).toBeNull();
    // Its label text is present in the DOM (revealed by CSS on hover/focus).
    expect(within(badge).getByText('Ready')).toBeInTheDocument();
  });

  it('groups the feature row actions in the hover trail', async () => {
    render(
      <ApiProvider value={fullClient()}>
        <Explorer
          live={initialLiveState}
          activeSessionId={null}
          names={{}}
          {...callbacks}
        />
      </ApiProvider>,
    );
    const add = await screen.findByRole('button', {
      name: 'New session in Context UI',
    });
    const overflow = screen.getByRole('button', {
      name: 'Actions for Context UI',
    });
    const trail = add.closest('.tree-branch-trail');
    expect(trail).not.toBeNull();
    expect(overflow.closest('.tree-branch-trail')).toBe(trail);

    // The feature label sits outside the trail and is never collapsed.
    expect(
      screen
        .getByRole('button', { name: 'Context UI' })
        .closest('.tree-branch-trail'),
    ).toBeNull();
  });
});
