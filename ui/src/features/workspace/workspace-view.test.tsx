import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider, useApi } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { initialLiveState, type LiveState } from '../../lib/stream.js';
import type { AttachedAgent, Feature, PrReview, Repository, Session } from '../../lib/types.js';
import { reviewBoardRunStore } from '../review-board-page/review-board-run-store.js';
import { WorkspaceView } from './workspace-view.js';
import type { WorkspaceTab, WorkspaceTabsState } from './workspace-tabs.js';

vi.mock('./explorer.js', () => ({
  Explorer: (props: {
    onDeleteFeature: (feature: Feature) => Promise<void>;
    onDeleteSession: (session: Session) => Promise<void>;
    onOpenPrReview: (feature: Feature) => void;
    onOpenBulkPrReview: (
      parent: Feature,
      items: { feature: Feature; number: number; title: string }[],
    ) => void;
  }) => {
    const api = useApi();
    return <div>
      <button onClick={() => void props.onDeleteFeature(root).catch(() => {})}>Delete feature</button>
      <button onClick={() => void props.onDeleteSession(childSession).catch(() => {})}>Delete session</button>
      <button onClick={() => void api.deleteRepo(repository.id).catch(() => {})}>Delete repo</button>
      <button onClick={() => void api.detachAgent('attachment').catch(() => {})}>Detach agent</button>
      <button onClick={() => void api.deleteGroup('group').catch(() => {})}>Delete group</button>
      <button onClick={() => props.onOpenPrReview(leaf)}>Open imported PR</button>
      <button onClick={() => props.onOpenBulkPrReview(root, [importedFirst])}>Import first PR</button>
      <button onClick={() => props.onOpenBulkPrReview(root, [importedFirst, importedSecond])}>Import second PR</button>
    </div>;
  },
}));
vi.mock('../../components/terminal-view.js', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => <div>Terminal {sessionId}</div>,
}));
vi.mock('../feature-dashboard/feature-dashboard.js', () => ({
  FeatureDashboard: ({ featureId }: { featureId: string }) => <div>Dashboard {featureId}</div>,
}));
vi.mock('../repo-dashboard/repo-dashboard.js', () => ({
  RepoDashboard: () => <div>Repository dashboard</div>,
}));
vi.mock('./bulk-review-tracker.js', () => ({
  BulkReviewTracker: ({ prs, live }: { prs: { featureId: string; title: string }[]; live: LiveState }) =>
    <div>
      {prs.map((pr) => <span key={pr.featureId}>{pr.title}</span>)}
      {Object.values(live.reviewBoardActivity).flatMap((activity) => activity.lines).join('\n')}
    </div>,
}));
vi.mock('../review-board-page/review-board-run-store.js', () => ({
  reviewBoardRunStore: { remove: vi.fn() },
}));
vi.mock('../../agent-host/agent-registry.js', () => ({
  getAgentModule: () => ({
    title: 'Review Board',
    component: () => <div>Agent view</div>,
  }),
}));

const root: Feature = {
  id: 'root', name: 'Root', description: '', createdAt: '', summary: null,
  repoId: 'repo', checkoutPath: null, parentFeatureId: null,
};
const child: Feature = { ...root, id: 'child', name: 'Child', parentFeatureId: root.id };
const leaf: Feature = { ...child, id: 'leaf', name: 'Leaf', parentFeatureId: child.id };
const other: Feature = { ...root, id: 'other', name: 'Other', repoId: null };
const importedFirst = { feature: child, number: 41, title: 'First checkout succeeded' };
const importedSecond = {
  feature: { ...child, id: 'second', name: 'Second child' },
  number: 42, title: 'Second checkout succeeded',
};
const repository: Repository = {
  id: 'repo', provider: 'github', remoteUrl: '', name: 'Repository',
  localPath: 'C:\\repo', defaultBranch: null, createdAt: '',
};
const childSession: Session = {
  id: 'session', featureId: leaf.id, name: 'Child session', provider: 'copilot',
  requestedModel: '', resolvedModel: null, status: 'created', kind: 'dev',
  prompt: '', usageFilePath: '', createdAt: '', startedAt: null, endedAt: null,
  exitCode: null, groupId: 'group',
};
const attached: AttachedAgent = {
  attachment: { id: 'attachment', featureId: leaf.id, agentId: 'review-board', createdAt: '' },
  manifest: {
    id: 'review-board', title: 'Review Board', description: '', icon: '',
    allowMultiplePerFeature: false, prerequisiteLabel: '', usageLabel: '', promptFields: [],
  },
};
const featureTab = (feature: Feature): WorkspaceTab => ({
  kind: 'feature', id: `feature:${feature.id}`, label: feature.name, feature,
});
const sessionTab: WorkspaceTab = {
  kind: 'session', id: 'persisted-session', label: childSession.name!, session: childSession,
};
const agentTab: WorkspaceTab = {
  kind: 'agent', id: 'agent', label: 'Review Board · Leaf', feature: leaf,
  agentId: 'review-board', attachmentId: attached.attachment.id,
};
const repoTab: WorkspaceTab = {
  kind: 'repo', id: 'repo-view', label: repository.name, repo: repository,
};

function createClient() {
  let features = [root, child, leaf, other];
  let sessions = [childSession];
  let agents = [attached];
  let repos = [repository];
  return {
    listFeatures: vi.fn(async () => features),
    listRepos: vi.fn(async () => repos),
    listSessions: vi.fn(async (featureId: string) => sessions.filter((s) => s.featureId === featureId)),
    listFeatureAgents: vi.fn(async (featureId: string) => agents.filter((a) => a.attachment.featureId === featureId)),
    getPrReview: vi.fn(async (featureId: string) => ({
      featureId, pull: { number: 1, title: 'Actual PR title', url: '' },
    } as PrReview)),
    deleteFeature: vi.fn(async () => {
      features = [other];
      sessions = [];
      agents = [];
      return { id: root.id };
    }),
    deleteSession: vi.fn(async () => {
      sessions = [];
      return { id: childSession.id };
    }),
    deleteRepo: vi.fn(async () => {
      repos = [];
      features = features.map((f) => ({ ...f, repoId: null }));
      return { id: repository.id };
    }),
    detachAgent: vi.fn(async () => {
      agents = [];
      return { id: attached.attachment.id };
    }),
    deleteGroup: vi.fn(async () => {
      sessions = sessions.map((s) => ({ ...s, groupId: null }));
      return { id: 'group' };
    }),
  };
}

function stored(): WorkspaceTabsState {
  return JSON.parse(window.localStorage.getItem('cw-workspace-tabs')!);
}

function mount(state: WorkspaceTabsState, client = createClient()) {
  window.localStorage.setItem('cw-workspace-tabs', JSON.stringify(state));
  const view = render(
    <ApiProvider value={client as unknown as ApiClient}>
      <WorkspaceView live={initialLiveState} sidebarOpen onToggleSidebar={() => {}} />
    </ApiProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('WorkspaceView deletion reconciliation', () => {
  it('retains each successful checkout and its new tracker against pre-import feature snapshots', async () => {
    const client = createClient();
    let resolveOldSnapshot!: (features: Feature[]) => void;
    client.listFeatures.mockResolvedValue([other]);
    client.listFeatures.mockImplementationOnce(() => new Promise((resolve) => { resolveOldSnapshot = resolve; }));
    client.getPrReview.mockRejectedValue(new Error('Review metadata has not refreshed'));
    mount({ tabs: [featureTab(other)], activeId: 'feature:other', splitId: null }, client);

    fireEvent.click(screen.getByText('Import first PR'));
    await act(async () => resolveOldSnapshot([other]));
    await waitFor(() => expect(client.listFeatures).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(importedFirst.title)).toBeInTheDocument());
    expect(stored().tabs.find((tab) => tab.kind === 'pr-review-tracker')).toMatchObject({
      feature: { id: root.id },
      prs: [{ featureId: child.id, number: 41, title: importedFirst.title }],
    });

    fireEvent.click(screen.getByText('Import second PR'));
    await waitFor(() => expect(client.listFeatures).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(screen.getByText(importedFirst.title)).toBeInTheDocument();
    expect(screen.getByText(importedSecond.title)).toBeInTheDocument();

    // A later checkout can fail: the final reload confirms only the successful
    // imports, without a final "whole batch succeeded" callback.
    client.listFeatures.mockResolvedValue([other, root, child, importedSecond.feature]);
    fireEvent.click(screen.getByText('Delete group'));
    await waitFor(() => expect(client.listFeatures.mock.calls.length).toBeGreaterThanOrEqual(4));
    await act(async () => {});
    expect(stored().tabs.find((tab) => tab.kind === 'pr-review-tracker')).toMatchObject({
      prs: [
        { featureId: child.id, number: 41, title: importedFirst.title },
        { featureId: importedSecond.feature.id, number: 42, title: importedSecond.title },
      ],
    });

    // Confirmed imports are no longer protected from real feature deletion.
    fireEvent.click(screen.getByText('Delete feature'));
    await waitFor(() => expect(stored().tabs).toEqual([featureTab(other)]));
  });

  it('still deletes a freshly imported parent before any list snapshot confirms it', async () => {
    const client = createClient();
    client.listFeatures.mockResolvedValue([other]);
    client.getPrReview.mockRejectedValue(new Error('Still refreshing'));
    mount({ tabs: [featureTab(other)], activeId: 'feature:other', splitId: null }, client);
    fireEvent.click(screen.getByText('Import first PR'));
    await waitFor(() => expect(screen.getByText(importedFirst.title)).toBeInTheDocument());
    fireEvent.click(screen.getByText('Delete feature'));
    await waitFor(() => expect(stored().tabs).toEqual([featureTab(other)]));
    expect(vi.mocked(reviewBoardRunStore.remove).mock.calls.map(([id]) => id)).toEqual(['root', 'child']);
  });

  it('opens a single imported PR in the Review Board agent view', async () => {
    mount({ tabs: [], activeId: null, splitId: null });
    fireEvent.click(screen.getByText('Open imported PR'));
    await waitFor(() => expect(screen.getByText('Agent view')).toBeInTheDocument());
    await waitFor(() => expect(stored()).toMatchObject({
      tabs: [{
        kind: 'agent', id: 'agent:review-board:leaf', agentId: 'review-board',
        attachmentId: attached.attachment.id, feature: { id: leaf.id },
      }],
      activeId: 'agent:review-board:leaf',
    }));
  });

  it('closes all descendant views, normalizes both panes, and persists removal across remounts', async () => {
    const tracker: WorkspaceTab = {
      kind: 'pr-review-tracker', id: 'tracker', label: 'Bulk Review · Root',
      feature: root, prs: [{ featureId: child.id, number: 1, title: 'PR' }],
    };
    const legacy: WorkspaceTab = {
      kind: 'review-board', id: 'legacy', label: 'Review Board · Leaf', feature: leaf,
    };
    const view = mount({
      tabs: [featureTab(other), tracker, legacy, agentTab, sessionTab],
      activeId: sessionTab.id, splitId: agentTab.id,
    });
    await screen.findByText('Terminal session');
    fireEvent.click(screen.getByText('Delete feature'));
    await waitFor(() => expect(stored()).toEqual({
      tabs: [featureTab(other)], activeId: 'feature:other', splitId: null,
    }));
    expect(screen.queryByText('Terminal session')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent view')).not.toBeInTheDocument();
    expect(vi.mocked(reviewBoardRunStore.remove).mock.calls.map(([id]) => id)).toEqual(['root', 'child', 'leaf']);
    view.unmount();
    mount(stored(), view.client);
    expect(await screen.findByText('Dashboard other')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('closes sessions by entity ID, leaving feature and agent tabs open', async () => {
    mount({
      tabs: [featureTab(leaf), agentTab, sessionTab],
      activeId: sessionTab.id, splitId: agentTab.id,
    });
    await screen.findByText('Terminal session');
    fireEvent.click(screen.getByText('Delete session'));
    await waitFor(() => expect(stored().tabs.map((tab) => tab.id)).toEqual(['feature:leaf', 'agent']));
    expect(stored().activeId).toBe('agent');
    expect(stored().splitId).toBeNull();
  });

  it('closes only the removed repo dashboard, retaining surviving orphaned feature/session views', async () => {
    mount({
      tabs: [featureTab(leaf), sessionTab, repoTab],
      activeId: sessionTab.id, splitId: repoTab.id,
    });
    await screen.findByText('Repository dashboard');
    fireEvent.click(screen.getByText('Delete repo'));
    await waitFor(() => expect(stored().tabs.map((tab) => tab.id)).toEqual(['feature:leaf', sessionTab.id]));
    await waitFor(() => expect(stored().tabs[0]).toMatchObject({ feature: { repoId: null } }));
    expect(stored().activeId).toBe(sessionTab.id);
    expect(stored().splitId).toBeNull();
  });

  it('closes detached agent aliases and legacy boards even when no tab initially matches the attachment ID', async () => {
    const legacy: WorkspaceTab = {
      kind: 'review-board', id: 'legacy', label: 'Review Board · Leaf', feature: leaf,
    };
    const client = createClient();
    // Keep initial attachment reconciliation in flight until deletion wins.
    let finishInitial!: (value: AttachedAgent[]) => void;
    client.listFeatureAgents.mockImplementationOnce(() => new Promise((resolve) => { finishInitial = resolve; }));
    mount({
      tabs: [featureTab(other), legacy, { ...agentTab, attachmentId: 'review-board:leaf' }],
      activeId: agentTab.id, splitId: legacy.id,
    }, client);
    fireEvent.click(screen.getByText('Detach agent'));
    await waitFor(() => expect(stored().tabs.map((tab) => tab.id)).toEqual(['feature:other']));
    await act(async () => finishInitial([attached]));
    expect(stored().tabs.map((tab) => tab.id)).toEqual(['feature:other']);
  });

  it('keeps sessions when deleting a group merely ungroups its children', async () => {
    mount({ tabs: [sessionTab], activeId: sessionTab.id, splitId: null });
    await screen.findByText('Terminal session');
    fireEvent.click(screen.getByText('Delete group'));
    await waitFor(() => expect(stored().tabs[0]).toMatchObject({ session: { groupId: null } }));
    expect(stored().activeId).toBe(sessionTab.id);
  });

  it('closes a legacy-only agent view from cached attachments when the post-detach refresh fails', async () => {
    const client = createClient();
    const legacy: WorkspaceTab = {
      kind: 'review-board', id: 'legacy', label: 'Review Board · Leaf', feature: leaf,
    };
    mount({
      tabs: [legacy, featureTab(other)], activeId: 'feature:other', splitId: legacy.id,
    }, client);
    await screen.findByText('Dashboard other');
    await act(async () => {});
    client.detachAgent.mockImplementationOnce(async () => {
      client.listFeatureAgents.mockRejectedValue(new Error('Offline'));
      return { id: attached.attachment.id };
    });
    fireEvent.click(screen.getByText('Detach agent'));
    await waitFor(() => expect(stored()).toEqual({
      tabs: [featureTab(other)], activeId: 'feature:other', splitId: null,
    }));
  });

  it.each([
    ['Delete feature', 'deleteFeature'],
    ['Delete session', 'deleteSession'],
    ['Delete repo', 'deleteRepo'],
    ['Detach agent', 'detachAgent'],
  ] as const)('does not close views when %s fails', async (button, method) => {
    const client = createClient();
    client[method].mockRejectedValue(new Error('Deletion failed'));
    const state = {
      tabs: [featureTab(root), agentTab, sessionTab, repoTab],
      activeId: sessionTab.id, splitId: agentTab.id,
    };
    mount(state, client);
    await screen.findByText('Terminal session');
    await act(async () => fireEvent.click(screen.getByText(button)));
    expect(client[method]).toHaveBeenCalledOnce();
    expect(stored()).toEqual(state);
    expect(reviewBoardRunStore.remove).not.toHaveBeenCalled();
  });

  it('closes known descendants even if the follow-up feature refresh fails', async () => {
    const client = createClient();
    mount({ tabs: [sessionTab, featureTab(other)], activeId: sessionTab.id, splitId: null }, client);
    await screen.findByText('Terminal session');
    client.deleteFeature.mockImplementationOnce(async () => {
      client.listFeatures.mockRejectedValue(new Error('Offline'));
      return { id: root.id };
    });
    fireEvent.click(screen.getByText('Delete feature'));
    await waitFor(() => expect(stored().tabs).toEqual([featureTab(other)]));
  });

  it('refreshes a restored tracker with live imported PRs and authoritative titles', async () => {
    const client = createClient();
    const tracker: WorkspaceTab = {
      kind: 'pr-review-tracker', id: 'tracker', label: 'Bulk Review · Root', feature: root,
      prs: [{ featureId: child.id, number: 1, title: 'Saved title' }],
    };
    const view = mount({ tabs: [tracker], activeId: tracker.id, splitId: null }, client);
    expect(await screen.findByText('Actual PR title')).toBeInTheDocument();
    const imported = { ...child, id: 'imported', name: 'Do not infer a title from this name' };
    client.listFeatures.mockResolvedValue([root, child, imported, other]);
    const review = {
      featureId: imported.id, pull: { number: 42, title: 'Live imported PR title', url: '' },
    } as PrReview;
    view.rerender(
      <ApiProvider value={client as unknown as ApiClient}>
        <WorkspaceView live={{
          ...initialLiveState,
          prReviews: { [imported.id]: review },
          reviewBoardActivity: {
            'imported:correctness': { sessionId: 'analysis', lines: ['Reading current PR changes'] },
          },
        }} sidebarOpen onToggleSidebar={() => {}} />
      </ApiProvider>,
    );
    expect(await screen.findByText('Live imported PR title')).toBeInTheDocument();
    expect(screen.getByText('Reading current PR changes')).toBeInTheDocument();
    expect(stored().tabs[0]).toMatchObject({
      prs: [
        { featureId: child.id, number: 1, title: 'Actual PR title' },
        { featureId: imported.id, number: 42, title: 'Live imported PR title' },
      ],
    });
    expect(client.getPrReview).not.toHaveBeenCalledWith(imported.id);
  });
});

describe('WorkspaceView tab context menu', () => {
  it('bulk-closes tabs from the right-click menu', async () => {
    mount({
      tabs: [featureTab(root), featureTab(child), featureTab(other)],
      activeId: 'feature:other',
      splitId: null,
    });
    await screen.findByRole('tab', { name: /Root/ });

    // Right-clicking the middle tab opens the bulk-close menu.
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Child/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    // Close everything to the right of Child — Other disappears.
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Close tabs to the right' }),
    );
    await waitFor(() =>
      expect(stored().tabs.map((tab) => tab.id)).toEqual([
        'feature:root',
        'feature:child',
      ]),
    );
    // The menu closes after acting.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('disables edge actions and closes all tabs', async () => {
    mount({
      tabs: [featureTab(root), featureTab(other)],
      activeId: 'feature:root',
      splitId: null,
    });
    await screen.findByRole('tab', { name: /Root/ });

    // On the leftmost tab, "Close tabs to the left" is disabled.
    fireEvent.contextMenu(screen.getByRole('tab', { name: /Root/ }));
    expect(
      screen.getByRole('menuitem', { name: 'Close tabs to the left' }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Close all' }));
    await waitFor(() => expect(stored().tabs).toEqual([]));
  });

  it('dismisses the menu on Escape without closing tabs', async () => {
    mount({
      tabs: [featureTab(root), featureTab(other)],
      activeId: 'feature:root',
      splitId: null,
    });
    await screen.findByRole('tab', { name: /Root/ });

    fireEvent.contextMenu(screen.getByRole('tab', { name: /Other/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(stored().tabs).toHaveLength(2);
  });
});
