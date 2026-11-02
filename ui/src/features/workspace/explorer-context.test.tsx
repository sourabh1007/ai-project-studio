import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { initialLiveState, type LiveState } from '../../lib/stream.js';
import type { Feature, FeatureUsage, Repository, RepositoryContext, Session, UsageSummary, UsageSummaryNode } from '../../lib/types.js';
import { formatAic } from '../../lib/format.js';
import { Explorer } from './explorer.js';
import { prImportStore } from '../../lib/pr-import-store.js';
import { reviewBoardRunStore } from '../review-board-page/review-board-run-store.js';
import { AutomationReadinessProvider } from '../../app/automation-readiness.js';

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
    getUsageSummary: vi.fn().mockResolvedValue({ features: {}, unattributed: null }),
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

describe('Explorer background PR imports', () => {
  it('does not auto-enqueue a review after an import when the selected CLI is interactive-only', async () => {
    const client = {
      ...api(context('ready', 't')),
      getProviderBootstrap: vi.fn().mockResolvedValue({
        defaultProvider: 'interactive-cli', providers: [{ id: 'interactive-cli', installed: true,
          automation: { supported: false, reason: 'Choose another CLI for automated reviews.' } }],
      }),
      createPrFeatureStreamed: vi.fn().mockResolvedValue({
        feature: { ...feature, id: 'imported-interactive' }, alreadyImported: false,
      }),
    };
    const queueReview = vi.spyOn(reviewBoardRunStore, 'enqueueBulk').mockImplementation(() => {});
    render(<ApiProvider value={client}><AutomationReadinessProvider>
      <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks} />
    </AutomationReadinessProvider></ApiProvider>);
    await screen.findByRole('button', { name: feature.name });
    await act(async () => {
      prImportStore.enqueue(client, { repo: { id: repo.id, name: repo.name },
        pulls: [{ number: 42, title: 'Import without automation' }], parentFeatureId: null, batchName: 'Batch' });
    });
    expect(await screen.findByText('Choose another CLI for automated reviews.')).toBeInTheDocument();
    expect(queueReview).not.toHaveBeenCalled();
    expect(client.createPrFeatureStreamed).toHaveBeenCalledOnce();
  });
  beforeEach(() => prImportStore.reset());
  afterEach(() => {
    act(() => prImportStore.reset());
    vi.restoreAllMocks();
  });

  it('keeps the picker and its selection when the background queue is full', async () => {
    const client = {
      ...api(context('ready', 't')),
      listRepoPulls: vi.fn().mockResolvedValue([{
        provider: 'github', number: 42, title: 'Queue regression', author: 'octocat',
        url: 'https://github.com/acme/app/pull/42', sourceBranch: 'feature/42',
      }]),
    };
    vi.spyOn(prImportStore, 'enqueue').mockReturnValue({
      accepted: [], skipped: [{ number: 42, reason: 'queue-full' }],
    });
    render(<ApiProvider value={client}>
      <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks} />
    </ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: `Add to ${repo.name}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Pull Request' }));
    fireEvent.click(await screen.findByRole('button', { name: /^#42\D/ }));
    fireEvent.click(screen.getByRole('button', { name: /Start review/ }));
    expect(await screen.findByText(/The import queue is full.*#42/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^#42\D/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Start review/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps navigation usable during checkout and queues the review without stealing focus', async () => {
    let finish!: (value: { feature: Feature; alreadyImported: boolean }) => void;
    const checkout = new Promise<{ feature: Feature; alreadyImported: boolean }>((resolve) => { finish = resolve; });
    const client = {
      ...api(context('ready', 't')),
      createPrFeatureStreamed: vi.fn().mockReturnValue(checkout),
    };
    const onOpenFeature = vi.fn();
    const onOpenPrReview = vi.fn();
    const queueReview = vi.spyOn(reviewBoardRunStore, 'enqueueBulk').mockImplementation(() => {});
    render(<ApiProvider value={client}>
      <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks}
        onOpenFeature={onOpenFeature} onOpenPrReview={onOpenPrReview} />
    </ApiProvider>);
    await screen.findByRole('button', { name: feature.name });
    await act(async () => {
      prImportStore.enqueue(client, {
        repo: { id: repo.id, name: repo.name },
        pulls: [{ number: 42, title: 'Background checkout' }],
        parentFeatureId: null,
        batchName: 'Import batch',
      });
    });
    expect(await screen.findByText(/Background checkout/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: feature.name }));
    expect(onOpenFeature).toHaveBeenCalledWith(feature);
    const imported = { ...feature, id: 'imported', name: 'Imported review' };
    await act(async () => finish({ feature: imported, alreadyImported: false }));
    await waitFor(() => expect(queueReview).toHaveBeenCalledWith([imported.id], client));
    expect(onOpenPrReview).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Explorer hierarchical usage', () => {
  const totals = {
    sessions: 1, inputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5,
    credits: 0, cost: 0, nanoAiu: 0,
  };

  it('uses one authoritative summary for feature, subcategory and nested-feature badges', async () => {
    const child = { ...feature, id: 'f2', name: 'Child feature', parentGroupId: 'g1' };
    const nestedTotals = { ...totals, nanoAiu: 4e9 };
    const summary: UsageSummary = {
      features: {
        f1: { featureId: 'f1', state: 'complete', sessionsWithoutUsage: 0,
          totals: { ...totals, nanoAiu: 9e9 },
          groups: { g1: { state: 'complete', sessionsWithoutUsage: 0, totals: nestedTotals } } },
        f2: { featureId: 'f2', state: 'complete', sessionsWithoutUsage: 0, totals: nestedTotals, groups: {} },
      },
      unattributed: null,
    };
    const client = {
      ...api(context('ready', 't')),
      listFeatures: vi.fn().mockResolvedValue([feature, child]),
      getUsageSummary: vi.fn().mockResolvedValue(summary),
      listGroups: vi.fn().mockResolvedValue([{
        id: 'g1', featureId: feature.id, parentGroupId: null, kind: 'subcategory',
        name: 'Child group', orderIndex: 0, createdAt: feature.createdAt, prNumber: null, prUrl: null,
      }]),
      listSessions: vi.fn().mockResolvedValue([]),
      getFeatureUsage: vi.fn().mockResolvedValue(null),
    };
    render(<ApiProvider value={client}>
      <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks} />
    </ApiProvider>);
    expect(await screen.findByRole('button', { name: `View ${feature.name} usage` }))
      .toHaveTextContent(formatAic(9e9));
    fireEvent.click(screen.getByRole('button', { name: `Expand ${feature.name}` }));
    expect(await screen.findByRole('button', { name: 'View Child group usage' }))
      .toHaveTextContent(formatAic(4e9));
    expect(await screen.findByRole('button', { name: 'View Child feature usage' }))
      .toHaveTextContent(formatAic(4e9));
    expect(client.getFeatureUsage).toHaveBeenCalledTimes(1);
    expect(client.getFeatureUsage).toHaveBeenCalledWith(feature.id);
  });

  it.each<{
    state: UsageSummaryNode['state'];
    charges: Partial<UsageSummaryNode['totals']>;
    expected: string;
  }>([
    { state: 'complete', charges: {}, expected: formatAic(0) },
    { state: 'partial', charges: { credits: null, cost: null, nanoAiu: null, knownNanoAiu: 3e9, unavailableCharges: 1 }, expected: `>= ${formatAic(3e9)}` },
    { state: 'unavailable', charges: { credits: null, cost: null, nanoAiu: null }, expected: 'n/a' },
    { state: 'empty', charges: {}, expected: 'n/a' },
  ])('shows $state charges and tokens even while the feature is collapsed', async ({ state, charges, expected }) => {
    const summary: UsageSummary = {
      features: { f1: { featureId: 'f1', groups: {}, state, totals: { ...totals, ...charges }, sessionsWithoutUsage: state === 'empty' ? 1 : 0 } },
      unattributed: null,
    };
    const client = {
      ...api(context('ready', 't')),
      getUsageSummary: vi.fn().mockResolvedValue(summary),
      getFeatureUsage: vi.fn(),
    };
    render(<ApiProvider value={client}>
      <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks} />
    </ApiProvider>);
    const badge = await screen.findByRole('button', { name: `View ${feature.name} usage` });
    expect(badge).toHaveTextContent(expected);
    expect(badge).toHaveAttribute('title', expect.stringContaining('120 tokens'));
    expect(client.getFeatureUsage).not.toHaveBeenCalled();
    fireEvent.click(badge);
    const detail = await screen.findByRole('dialog', { name: `${feature.name} usage` });
    expect(within(detail).getByText('Input tokens').nextElementSibling).toHaveTextContent('100');
    expect(within(detail).getByText('Output tokens').nextElementSibling).toHaveTextContent('20');
  });

  it('refreshes ancestor totals after feature reparenting without needing another usage event', async () => {
    const destination = { ...feature, id: 'f2', name: 'Destination' };
    const listFeatures = vi.fn().mockResolvedValue([feature, destination]);
    const client = {
      ...api(context('ready', 't')),
      listFeatures,
      getUsageSummary: vi.fn().mockResolvedValue({ features: {}, unattributed: null }),
      moveFeature: vi.fn().mockImplementation(async () => {
        listFeatures.mockResolvedValue([{ ...feature, parentFeatureId: destination.id }, destination]);
      }),
    };
    render(<ApiProvider value={client}>
      <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks} />
    </ApiProvider>);
    const sourceRow = await screen.findByRole('button', { name: feature.name });
    await waitFor(() => expect(client.getUsageSummary).toHaveBeenCalledTimes(2), { timeout: 2_500 });
    const callsBeforeMove = client.getUsageSummary.mock.calls.length;
    fireEvent.dragStart(sourceRow.closest('.tree-branch')!);
    fireEvent.drop(screen.getByRole('button', { name: destination.name }).closest('.tree-branch')!);
    await waitFor(() => expect(client.moveFeature).toHaveBeenCalledWith(
      expect.objectContaining({ id: feature.id, targetParentFeatureId: destination.id }),
    ));
    await waitFor(() => expect(client.getUsageSummary.mock.calls.length).toBeGreaterThan(callsBeforeMove), { timeout: 2_500 });
  });
});

describe('Explorer repository context gating', () => {
  it('reloads feature usage after a stream gap even without a new usage event', async () => {
    const client = {
      ...api(context('ready', 't')),
      listSessions: vi.fn().mockResolvedValue([]),
      listGroups: vi.fn().mockResolvedValue([]),
      getFeatureUsage: vi.fn().mockResolvedValue(null),
    };
    const view = (live: LiveState) => <ApiProvider value={client}>
      <Explorer live={live} activeSessionId={null} names={{}} {...callbacks} />
    </ApiProvider>;
    const { rerender } = render(view(initialLiveState));
    fireEvent.click(await screen.findByRole('button', { name: `Expand ${feature.name}` }));
    await waitFor(() => expect(client.getFeatureUsage).toHaveBeenCalledTimes(1));
    rerender(view({ ...initialLiveState, streamEpoch: 1 }));
    await waitFor(() => expect(client.getFeatureUsage).toHaveBeenCalledTimes(2));
  });

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
    expect(onOpenSession).toHaveBeenCalledWith(session, 'Compact session');
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

  it.each(['confirm', 'cancel'] as const)('requires an explicit destination task checkout before a cross-feature session move (%s)', async (action) => {
    const source: Session = {
      id: 's1', featureId: 'f1', name: 'Task session', provider: 'copilot', requestedModel: 'auto',
      resolvedModel: null, status: 'completed', kind: 'dev', prompt: '', usageFilePath: '',
      createdAt: '', startedAt: null, endedAt: null, exitCode: null,
      worktreePath: 'C:\\original', branch: 'original-task',
    };
    const destination = { ...feature, id: 'f2', name: 'Destination feature' };
    const client = {
      ...fullClient(),
      listFeatures: vi.fn().mockResolvedValue([feature, destination]),
      listSessions: vi.fn(async (id: string) => id === 'f1' ? [source] : []),
      getSession: vi.fn().mockResolvedValue(source),
      getFeatureEnvironment: vi.fn(async (id: string) => id === 'f1'
        ? { cwd: null, branch: null }
        : { cwd: null, branch: null, worktrees: [
          { id: 't1', checkoutPath: 'C:\\task1', ref: 'task1' },
          { id: 't2', checkoutPath: 'C:\\task2', ref: 'task2' },
        ] }),
      moveNode: vi.fn().mockResolvedValue(undefined),
      relaunchSession: vi.fn().mockResolvedValue(source),
    };
    render(<ApiProvider value={client}>
      <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks} />
    </ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: `Expand ${feature.name}` }));
    const sessionRow = await screen.findByRole('button', { name: 'Task session' });
    fireEvent.dragStart(sessionRow.closest('.tree-draggable')!);
    fireEvent.drop(screen.getByRole('button', { name: destination.name }).closest('.tree-branch')!);
    const dialog = await screen.findByRole('dialog', { name: 'Switch branch?' });
    expect(dialog).toHaveTextContent('original-task');
    expect(client.moveNode).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move and switch branch' }));
    expect(await within(dialog).findByText('Choose a destination task worktree.')).toBeInTheDocument();
    expect(client.moveNode).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Destination task worktree' }), { target: { value: 't2' } });
    if (action === 'cancel') {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(client.moveNode).not.toHaveBeenCalled();
      expect(client.relaunchSession).not.toHaveBeenCalled();
    } else {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move and switch branch' }));
      await waitFor(() => expect(client.relaunchSession).toHaveBeenCalledWith('s1', 't2'));
      expect(client.moveNode).toHaveBeenCalledWith(expect.objectContaining({ type: 'session', id: 's1', targetFeatureId: 'f2' }));
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

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

describe('Explorer durable operation keys', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  const keyOf = (spy: ReturnType<typeof vi.fn>, index: number) =>
    (spy.mock.calls[index][1] as { operationKey: string }).operationKey;

  async function renderExplorer(client: ApiClient) {
    render(<ApiProvider value={client}>
      <Explorer live={initialLiveState} activeSessionId={null} names={{}} {...callbacks} />
    </ApiProvider>);
    await screen.findByRole('button', { name: feature.name });
  }

  it('keeps existing subcategories with their owner when creating a feature inside a folder', async () => {
    const existing = [
      { id: 'folder', featureId: feature.id, parentGroupId: null, name: 'Work' },
      { id: 'nested-folder', featureId: feature.id, parentGroupId: 'folder', name: 'Nested work' },
      { id: 'other-folder', featureId: feature.id, parentGroupId: null, name: 'Other work' },
    ].map((group) => ({
      ...group, kind: 'subcategory' as const, prNumber: null, prUrl: null,
      orderIndex: 0, createdAt: feature.createdAt,
    }));
    const created = { ...feature, id: 'new-feature', name: 'New child', parentGroupId: 'folder' };
    const saved = [feature];
    const client = {
      ...api(context('ready', 't')),
      listFeatures: vi.fn(async () => [...saved]),
      listGroups: vi.fn(async (id: string) => existing.filter((group) => group.featureId === id)),
      listSessions: vi.fn().mockResolvedValue([]),
      getFeatureUsage: vi.fn().mockResolvedValue(null),
      moveNode: vi.fn(),
      moveFeature: vi.fn(),
      createFeature: vi.fn(async () => { saved.push(created); return created; }),
    };
    await renderExplorer(client as unknown as ApiClient);
    fireEvent.click(screen.getByRole('button', { name: `Expand ${feature.name}` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Work' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New feature' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: created.name } });
    fireEvent.click(screen.getByRole('button', { name: 'Create feature' }));
    await screen.findByRole('button', { name: created.name });
    fireEvent.click(screen.getByRole('button', { name: `Expand ${created.name}` }));
    await waitFor(() => expect(client.listGroups).toHaveBeenCalledWith(created.id));
    const owner = screen.getByRole('button', { name: feature.name }).closest('.tree-node')!;
    const child = screen.getByRole('button', { name: created.name }).closest('.tree-node')!;
    for (const name of ['Work', 'Nested work', 'Other work']) {
      expect(within(owner as HTMLElement).getByRole('button', { name }).closest('.tree-node')).toBe(owner);
      expect(within(child as HTMLElement).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(client.createFeature).toHaveBeenCalledWith(
      { name: created.name, description: '', repoId: repo.id, parentGroupId: 'folder' },
      { operationKey: expect.any(String) },
    );
    expect(client.moveNode).not.toHaveBeenCalled();
    expect(client.moveFeature).not.toHaveBeenCalled();
  });

  it.each([
    { insertion: 'before', orderIndex: 0, failed: false, duplicate: false, nested: false },
    { insertion: 'after', orderIndex: 4, failed: false, duplicate: false, nested: false },
    { insertion: 'same index', orderIndex: 3, failed: false, duplicate: false, nested: false },
    { insertion: 'before with failed load', orderIndex: 0, failed: true, duplicate: false, nested: false },
    { insertion: 'after with failed load', orderIndex: 4, failed: true, duplicate: false, nested: false },
    { insertion: 'duplicate name', orderIndex: 0, failed: false, duplicate: true, nested: false },
    { insertion: 'nested folder', orderIndex: 0, failed: false, duplicate: false, nested: true },
  ])('does not transfer a nested feature\'s loaded folders on $insertion insertion', async ({ orderIndex, failed, duplicate, nested }) => {
    const sibling = { ...feature, id: 'existing-child', name: 'Existing child', parentGroupId: 'folder', orderIndex: 3 };
    const created = { ...feature, id: 'new-child', name: duplicate ? sibling.name : 'New child', parentGroupId: 'folder', orderIndex };
    const saved = [feature, sibling];
    const makeGroup = (id: string, featureId: string, name: string) => ({
      id, featureId, name, parentGroupId: null, kind: 'subcategory' as const,
      prNumber: null, prUrl: null, orderIndex: 0, createdAt: feature.createdAt,
    });
    const oldGroups = [
      makeGroup('old-folder', sibling.id, 'Existing tasks'),
      { ...makeGroup('nested-old-folder', sibling.id, 'Nested existing tasks'), parentGroupId: 'old-folder' },
    ];
    const folder = { ...makeGroup('folder', feature.id, 'Work'), parentGroupId: nested ? 'holder' : null };
    const ownerGroups = nested ? [makeGroup('holder', feature.id, 'Holder'), folder] : [folder];
    let complete!: (groups: typeof oldGroups) => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<typeof oldGroups>((resolve, reject) => { complete = resolve; fail = reject; });
    const client = {
      ...api(context('ready', 't')),
      listFeatures: vi.fn(async () => [...saved]),
      listGroups: vi.fn((id: string) => id === feature.id
        ? Promise.resolve(ownerGroups)
        : id === sibling.id ? Promise.resolve(oldGroups) : pending),
      listSessions: vi.fn().mockResolvedValue([]),
      getFeatureUsage: vi.fn().mockResolvedValue(null),
      createFeature: vi.fn(async () => { saved.push(created); return created; }),
    };
    await renderExplorer(client as unknown as ApiClient);
    fireEvent.click(screen.getByRole('button', { name: `Expand ${feature.name}` }));
    fireEvent.click(await screen.findByRole('button', { name: `Expand ${sibling.name}` }));
    await screen.findByRole('button', { name: 'Existing tasks' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Work' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New feature' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: created.name } });
    fireEvent.click(screen.getByRole('button', { name: 'Create feature' }));
    const newLabel = await waitFor(() => {
      const labels = screen.getAllByRole('button', { name: created.name });
      expect(labels).toHaveLength(duplicate ? 2 : 1);
      return labels[0]!;
    });
    const newNode = newLabel.closest('.tree-node') as HTMLElement;
    expect(within(newNode).queryByRole('button', { name: 'Existing tasks' })).not.toBeInTheDocument();
    const oldLabel = screen.getAllByRole('button', { name: sibling.name })[duplicate ? 1 : 0]!;
    const oldNode = oldLabel.closest('.tree-node') as HTMLElement;
    const expectOwnership = () => {
      for (const group of oldGroups) {
        expect(within(oldNode).getByRole('button', { name: group.name })).toBeInTheDocument();
        expect(within(newNode).queryByRole('button', { name: group.name })).not.toBeInTheDocument();
      }
    };
    expectOwnership();
    fireEvent.click(screen.getByRole('button', { name: `Expand ${created.name}` }));
    await waitFor(() => expect(client.listGroups).toHaveBeenCalledWith(created.id));
    expect(within(newNode).queryByRole('button', { name: 'Existing tasks' })).not.toBeInTheDocument();
    await act(async () => failed ? fail(new Error('Folder lookup failed')) : complete([]));
    if (failed) expect(within(newNode).getByText('Folder lookup failed')).toBeInTheDocument();
    expectOwnership();
  });

  it('retries a lost feature create with the same key and keys a later genuine create anew', async () => {
    const createFeature = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ...feature, id: 'f2' });
    await renderExplorer({ ...api(context('ready', 't')), createFeature } as unknown as ApiClient);
    const openForm = async () => {
      fireEvent.click(await screen.findByRole('button', { name: `Add to ${repo.name}` }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New feature' }));
    };
    await openForm();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Checkout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create feature' }));
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create feature' }));
    await waitFor(() => expect(createFeature).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await openForm();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Checkout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create feature' }));
    await waitFor(() => expect(createFeature).toHaveBeenCalledTimes(3));
    expect(keyOf(createFeature, 1)).toBe(keyOf(createFeature, 0));
    expect(keyOf(createFeature, 2)).not.toBe(keyOf(createFeature, 0));
  });

  it('shows a storage failure and creates nothing', async () => {
    const createFeature = vi.fn();
    await renderExplorer({ ...api(context('ready', 't')), createFeature } as unknown as ApiClient);
    fireEvent.click(await screen.findByRole('button', { name: `Add to ${repo.name}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New feature' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Checkout' } });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    fireEvent.click(screen.getByRole('button', { name: 'Create feature' }));
    expect(await screen.findByText(/nothing was created/)).toBeInTheDocument();
    expect(createFeature).not.toHaveBeenCalled();
  });

  it('retries a lost agent attach with the same key', async () => {
    const attachAgent = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({});
    const listAvailableAgents = vi.fn().mockResolvedValue([{
      manifest: { id: 'new-task', title: 'New Task', description: 'd', icon: 'add', prerequisiteLabel: 'x' },
      attachable: true,
    }]);
    await renderExplorer({ ...api(context('ready', 't')), attachAgent, listAvailableAgents } as unknown as ApiClient);
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${feature.name}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add agent' }));
    fireEvent.click(await screen.findByRole('button', { name: `Add New Task to ${feature.name}` }));
    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Add New Task to ${feature.name}` }));
    await waitFor(() => expect(attachAgent).toHaveBeenCalledTimes(2));
    expect(attachAgent.mock.calls[1][2]).toEqual(attachAgent.mock.calls[0][2]);
    expect(attachAgent.mock.calls[0][2]).toEqual({ operationKey: expect.stringMatching(/^op-/) });
  });
});