import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider, useApi } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { initialLiveState, type LiveState } from '../../lib/stream.js';
import type { AttachedAgent, Feature, PrReview, Repository, Session } from '../../lib/types.js';
import { reviewBoardRunStore } from '../review-board-page/review-board-run-store.js';
import { featureDeletionStore } from '../../lib/feature-deletion-store.js';
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
      <button onClick={() => featureDeletionStore.enqueue(root, () => props.onDeleteFeature(root))}>Queue feature deletion</button>
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
  TerminalView: ({ sessionId, diagnosticsOpen }: { sessionId: string; diagnosticsOpen?: boolean }) =>
    <div data-diagnostics-open={diagnosticsOpen}>Terminal {sessionId}</div>,
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
    component: ({ ctx }: { ctx: { openSession?: (session: Session, label: string) => void } }) => (
      <div>
        Agent view
        <button onClick={() => ctx.openSession?.(childSession, 'Agent opened')}>Open from agent</button>
      </div>
    ),
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
    getProviderBootstrap: vi.fn(async () => ({
      defaultProvider: 'copilot', selectionRequired: false, providers: [{ id: 'copilot', installed: true }],
    })),
    createTerminalSession: vi.fn(async (_featureId: string, input: { providerId: string }) => {
      const session = { ...childSession, id: 'new-compatible', provider: input.providerId };
      sessions.push(session);
      return session;
    }),
    listFeatures: vi.fn(async () => features),
    listRepos: vi.fn(async () => repos),
    listSessions: vi.fn(async (featureId: string) => sessions.filter((s) => s.featureId === featureId)),
    listSessionPrompts: vi.fn(async () => []),
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

it('covers workspace restoration and enables the terminal when authoritative sessions load', async () => {
  const client = createClient();
  let finish!: (sessions: Session[]) => void;
  client.listSessions.mockImplementation(() => new Promise<Session[]>((resolve) => { finish = resolve; }));
  const view = mount({ tabs: [sessionTab], activeId: sessionTab.id, splitId: null }, client);
  expect(screen.getByText('Loading Explorer')).toBeVisible();
  expect(view.container.querySelector('.editor')).toHaveAttribute('inert');
  expect(screen.getByRole('progressbar', { name: 'Loading Explorer' })).toHaveAttribute('aria-valuenow', '0');
  await act(async () => {});
  expect(screen.getByRole('progressbar', { name: 'Loading Explorer' })).toHaveAttribute('aria-valuenow', '33');
  await act(async () => finish([childSession]));
  await waitFor(() => expect(screen.queryByText('Loading Explorer')).not.toBeInTheDocument());
  expect(screen.getByText('Terminal session')).toBeVisible();
  expect(view.container.querySelector('.editor')).not.toHaveAttribute('inert');
});

it('opens a Planner launch immediately despite slow saved tabs and retains it against an older session list', async () => {
  const client = createClient();
  const pending: ((sessions: Session[]) => void)[] = [];
  client.listSessions.mockImplementation(() => new Promise<Session[]>((resolve) => pending.push(resolve)));
  const created = { ...childSession, id: 'planner-new', name: 'Planner task session' };
  window.localStorage.setItem('cw-workspace-tabs', JSON.stringify({
    tabs: [sessionTab], activeId: sessionTab.id, splitId: null,
  }));
  const view = render(<ApiProvider value={client as unknown as ApiClient}>
    <WorkspaceView live={initialLiveState} sidebarOpen onToggleSidebar={() => {}}
      launch={{ nonce: 1, intent: { kind: 'session', session: created, label: created.name! } }} />
  </ApiProvider>);
  expect(await screen.findByText('Terminal planner-new')).toBeVisible();
  expect(screen.queryByText('Loading Explorer')).not.toBeInTheDocument();
  expect(view.container.querySelector('.editor')).not.toHaveAttribute('inert');
  await act(async () => pending.forEach((resolve) => resolve([childSession])));
  expect(screen.getByText('Terminal planner-new')).toBeVisible();
  expect(stored().activeId).toBe(created.id);
  expect(stored().tabs.map((tab) => tab.id)).toEqual([sessionTab.id, created.id]);
});

it('groups related reviews, reveals every review on click and preserves their individual selection and state', async () => {
  const second: WorkspaceTab = { kind: 'review-board', id: 'review:root', label: 'Review root', feature: root };
  const client = createClient();
  client.listFeatureAgents.mockImplementation(async (featureId: string) => [attached, {
    ...attached, attachment: { ...attached.attachment, id: 'root-review', featureId: root.id },
  }].filter((entry) => entry.attachment.featureId === featureId));
  await act(async () => {
    mount({ tabs: [agentTab, featureTab(other), second], activeId: agentTab.id, splitId: null }, client);
  });
  const strip = screen.getByRole('tablist', { name: 'Workspace tabs' });
  const group = within(strip).getByRole('button', { name: 'Reviews tabs (2)' });
  expect(group).toHaveAttribute('aria-expanded', 'false');
  expect(within(strip).getAllByRole('tab')).toHaveLength(2);
  const before = stored().activeId;
  fireEvent.click(group);
  expect(within(strip).getAllByRole('tab')).toHaveLength(3);
  expect(stored().activeId).toBe(before);
  const review = within(strip).getAllByRole('tab').find((tab) => tab.id.endsWith(second.id))!;
  await act(async () => { fireEvent.click(review); });
  expect(stored().activeId).toBe(second.id);
  fireEvent.click(group);
  expect(review).toHaveAttribute('aria-selected', 'true');
  expect(within(strip).getAllByRole('tab')).toHaveLength(2);
  expect(stored().tabs.map((tab) => tab.id)).toEqual([agentTab.id, 'feature:other', second.id]);
  fireEvent.click(group);
  fireEvent.contextMenu(review);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Close tabs to the left' }));
  expect(stored().tabs.map((tab) => tab.id)).toEqual([second.id, 'feature:other']);
  expect(stored().activeId).toBe(second.id);
});

it('reveals collapsed review siblings during keyboard navigation and preserves the active tab focus', async () => {
  const second: WorkspaceTab = { kind: 'review-board', id: 'review:root', label: 'Review root', feature: root };
  mount({ tabs: [agentTab, featureTab(other), second], activeId: agentTab.id, splitId: null });
  const strip = screen.getByRole('tablist', { name: 'Workspace tabs' });
  const selected = within(strip).getByRole('tab', { selected: true });
  selected.focus();
  fireEvent.keyDown(selected, { key: 'ArrowRight' });
  expect(stored().activeId).toBe(second.id);
  expect(within(strip).getByRole('button', { name: 'Reviews tabs (2)' })).toHaveAttribute('aria-expanded', 'true');
  await waitFor(() => expect(within(strip).getByRole('tab', { selected: true })).toHaveFocus());
});

function mount(state: WorkspaceTabsState, client = createClient(), providerSwitch: { providerId: string; nonce: number } | null = null) {
  window.localStorage.setItem('cw-workspace-tabs', JSON.stringify(state));
  const view = render(
    <ApiProvider value={client as unknown as ApiClient}>
      <WorkspaceView live={initialLiveState} sidebarOpen onToggleSidebar={() => {}} providerSwitch={providerSwitch} />
    </ApiProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

it('resumes a compatible provider session in the current feature without changing other sessions or replaying prompts', async () => {
  const client = createClient();
  const existing = { ...childSession, id: 'claude-existing', provider: 'claude', status: 'completed' as const, startedAt: '2026-10-01', prompt: 'already delivered' };
  client.listSessions.mockResolvedValue([childSession, existing]);
  mount({ tabs: [sessionTab], activeId: sessionTab.id, splitId: null }, client, { providerId: 'claude', nonce: 1 });
  await screen.findByText('Terminal claude-existing');
  await waitFor(() => expect(screen.getByRole('tab', { selected: true })).toHaveFocus());
  expect(client.createTerminalSession).not.toHaveBeenCalled();
  expect(stored().tabs.some((tab) => tab.id === sessionTab.id)).toBe(true);
  expect(stored().tabs.find((tab) => tab.id === sessionTab.id)).toMatchObject({ session: { provider: 'copilot' } });
  expect(client.deleteSession).not.toHaveBeenCalled();
});

it('creates an empty compatible session when no matching native conversation exists', async () => {
  const client = createClient();
  mount({ tabs: [sessionTab], activeId: sessionTab.id, splitId: null }, client, { providerId: 'claude', nonce: 2 });
  await screen.findByText('Terminal new-compatible');
  expect(client.createTerminalSession).toHaveBeenCalledWith(
    leaf.id, { providerId: 'claude', kind: 'dev' }, expect.any(Object),
  );
  expect(client.createTerminalSession).toHaveBeenCalledTimes(1);
  expect(client.deleteSession).not.toHaveBeenCalled();
});

it('defers session creation without a current feature and preserves inactive provider tabs as history', async () => {
  const client = createClient();
  mount({ tabs: [repoTab], activeId: repoTab.id, splitId: null }, client, { providerId: 'claude', nonce: 3 });
  await screen.findByText('Repository dashboard');
  expect(client.createTerminalSession).not.toHaveBeenCalled();
});

it('persists sidebar and split sizing without changing the active tabs', async () => {
  const state = { tabs: [sessionTab, featureTab(other)], activeId: sessionTab.id, splitId: 'feature:other' };
  const view = mount(state);
  const sidebar = screen.getByRole('separator', { name: 'Resize sidebar' });
  fireEvent.keyDown(sidebar, { key: 'ArrowRight' });
  expect(localStorage.getItem('cw-explorer-width')).toBe('270');
  const split = screen.getByRole('separator', { name: 'Resize split view' });
  fireEvent.keyDown(split, { key: 'ArrowRight', shiftKey: true });
  expect(localStorage.getItem('cw-workspace-split-ratio')).toBe('60');
  expect(view.container.querySelector('.editor-pane')).toHaveStyle({ flexGrow: '60' });
  expect(view.container.querySelector('.editor-pane-secondary')).toHaveStyle({ flexGrow: '40' });
  expect(stored().activeId).toBe(sessionTab.id);
  fireEvent.keyDown(split, { key: 'Enter' });
  expect(localStorage.getItem('cw-workspace-split-ratio')).toBe('50');
  await screen.findByText('Terminal session');
});

it('lets a hosted agent open a created session as the active workspace tab', async () => {
  mount({ tabs: [agentTab], activeId: agentTab.id, splitId: null });
  await act(async () => {});
  fireEvent.click(await screen.findByRole('button', { name: 'Open from agent' }));
  await screen.findByText('Terminal session');
  const state = stored();
  expect(state.activeId).toBe(childSession.id);
});

it('shows recorded session details on demand without inventing model or exit information', async () => {
  const view = mount({ tabs: [sessionTab], activeId: sessionTab.id, splitId: null });
  await screen.findByText('Terminal session');
  expect(view.container.querySelector('.session-record-details')).toBeNull();
  expect(screen.queryByText('Session details')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Child session' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Session details' }));
  const details = screen.getByRole('dialog', { name: 'Session details' });
  expect(details).toHaveTextContent('Provider default');
  expect(details).toHaveTextContent('Not reported');
  expect(details).toHaveTextContent('copilot');
  expect(details).toHaveTextContent('Recorded status');
});

it('fullscreens a tab without remounting its console, toggles both panels and restores the normal layout', async () => {
  localStorage.setItem('cw-history-pane-open', 'true');
  const view = mount({ tabs: [sessionTab, featureTab(other)], activeId: sessionTab.id, splitId: 'feature:other' });
  const terminal = await screen.findByText('Terminal session');
  const workspace = view.container.querySelector('.workspace')!;
  const enter = vi.fn(async () => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: workspace });
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  const exit = vi.fn(async () => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  Object.defineProperty(workspace, 'requestFullscreen', { configurable: true, value: enter });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Child session' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fullscreen tab' }));
    await waitFor(() => expect(workspace).toHaveClass('is-fullscreen', 'is-collapsed'));
    expect(enter).toHaveBeenCalledOnce();
    expect(view.container.querySelector('.workspace-explorer')).toHaveAttribute('aria-hidden', 'true');
    expect(view.container.querySelector('.history-pane')).toBeNull();
    expect(screen.queryByText('Dashboard other')).not.toBeInTheDocument();
    expect(screen.getByText('Terminal session')).toBe(terminal);
    fireEvent.click(screen.getByRole('button', { name: 'Show explorer' }));
    expect(view.container.querySelector('.workspace-explorer')).not.toHaveAttribute('aria-hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Hide explorer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show prompt history' }));
    expect(screen.getByRole('button', { name: 'Collapse prompt history' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse prompt history' }));
    expect(view.container.querySelector('.history-pane')).toBeNull();
    expect(localStorage.getItem('cw-history-pane-open')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Child session' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Session details' }));
    expect(workspace.contains(screen.getByRole('dialog', { name: 'Session details' }))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    await waitFor(() => expect(workspace).not.toHaveClass('is-fullscreen'));
    expect(exit).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Collapse prompt history' })).toBeVisible();
    expect(view.container.querySelector('.workspace-explorer')).not.toHaveAttribute('aria-hidden');
    expect(await screen.findByText('Dashboard other')).toBeInTheDocument();
    expect(stored().splitId).toBe('feature:other');
    expect(screen.getByText('Terminal session')).toBe(terminal);
  } finally {
    Reflect.deleteProperty(document, 'fullscreenElement');
    Reflect.deleteProperty(document, 'exitFullscreen');
  }
});

it('keeps fullscreen failures actionable and opens terminal diagnostics from tab actions', async () => {
  const view = mount({ tabs: [sessionTab], activeId: sessionTab.id, splitId: null });
  const terminal = await screen.findByText('Terminal session');
  const workspace = view.container.querySelector('.workspace')!;
  Object.defineProperty(workspace, 'requestFullscreen', {
    configurable: true, value: vi.fn(async () => { throw new Error('Fullscreen permission denied'); }),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Child session' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Fullscreen tab' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fullscreen permission denied');
  expect(workspace).not.toHaveClass('is-fullscreen');
  expect(view.container.querySelector('.workspace-explorer')).not.toHaveAttribute('aria-hidden');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Child session' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal diagnostics' }));
  expect(terminal).toHaveAttribute('data-diagnostics-open', 'true');
});

it('keeps the visual selection on exactly the selected tab independently of hover and focus', async () => {
  const view = mount({
    tabs: [sessionTab, featureTab(other)], activeId: sessionTab.id, splitId: 'feature:other',
  });
  await screen.findByText('Terminal session');
  const selected = screen.getByRole('tab', { name: 'Child session', selected: true });
  const inactive = screen.getByRole('tab', { name: 'Other', selected: false });
  expect(selected.closest('.tab')).toHaveClass('tab-active');
  expect(inactive.closest('.tab')).not.toHaveClass('tab-active');

  fireEvent.mouseEnter(selected);
  act(() => inactive.focus());
  expect(inactive).toHaveFocus();
  expect(selected).toHaveAttribute('aria-selected', 'true');
  expect(selected.closest('.tab')).toHaveClass('tab-active');
  expect(inactive.closest('.tab')).not.toHaveClass('tab-active');

  fireEvent.click(inactive);
  expect(inactive).toHaveAttribute('aria-selected', 'true');
  expect(inactive.closest('.tab')).toHaveClass('tab-active');
  expect(selected).toHaveAttribute('aria-selected', 'false');
  expect(selected.closest('.tab')).not.toHaveClass('tab-active');
  expect(view.container.querySelectorAll('.tab-active')).toHaveLength(1);
});

it('supports roving tab focus, linked panels, arrow navigation and Delete with focus restoration', async () => {
  mount({ tabs: [sessionTab, featureTab(other), repoTab], activeId: sessionTab.id, splitId: null });
  await screen.findByText('Terminal session');
  const tabs = screen.getAllByRole('tab');
  expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
  expect(document.getElementById(tabs[0].getAttribute('aria-controls')!)).toHaveAttribute('aria-labelledby', tabs[0].id);
  act(() => tabs[0].focus());
  fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
  expect(tabs[1]).toHaveFocus();
  expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
  expect(tabs[1].closest('.tab')).toHaveClass('tab-active');
  expect(tabs[0].closest('.tab')).not.toHaveClass('tab-active');
  fireEvent.keyDown(tabs[1], { key: 'End' });
  expect(tabs[2]).toHaveFocus();
  fireEvent.keyDown(tabs[2], { key: 'ArrowRight' });
  expect(tabs[0]).toHaveFocus();
  fireEvent.keyDown(tabs[0], { key: 'Delete' });
  expect(screen.queryByRole('tab', { name: 'Child session' })).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { selected: true })).toHaveFocus();
  await screen.findByText('Repository dashboard');
});

it('offers keyboard-accessible tab actions with menu navigation and Escape focus restoration', async () => {
  mount({ tabs: [sessionTab, featureTab(other)], activeId: sessionTab.id, splitId: null });
  await screen.findByText('Terminal session');
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Child session' }));
  const menu = screen.getByRole('menu', { name: 'Tab actions' });
  expect(screen.getByRole('menuitem', { name: 'Fullscreen tab' })).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'End' });
  expect(screen.getByRole('menuitem', { name: 'Close all' })).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { selected: true })).toHaveFocus();
});

describe('WorkspaceView deletion reconciliation', () => {
  it('keeps unrelated editors interactive without refetching their sessions throughout a queued deletion', async () => {
    const client = createClient();
    const unrelated = { ...childSession, id: 'unrelated', featureId: other.id, name: 'Unrelated session' };
    client.listSessions.mockImplementation(async (id: string) => id === other.id ? [unrelated] : [childSession]);
    let finish!: () => void;
    const remove = client.deleteFeature.getMockImplementation()!;
    client.deleteFeature.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return remove();
    });
    const view = mount({
      tabs: [sessionTab, { kind: 'session', id: unrelated.id, label: unrelated.name!, session: unrelated }],
      activeId: unrelated.id, splitId: null,
    }, client);
    await waitFor(() => expect(screen.queryByText('Loading Explorer')).not.toBeInTheDocument());
    client.listSessions.mockClear();
    fireEvent.click(screen.getByText('Queue feature deletion'));
    await waitFor(() => expect(client.deleteFeature).toHaveBeenCalledOnce());
    expect(screen.queryByText('Loading Explorer')).not.toBeInTheDocument();
    expect(view.container.querySelector('.editor')).not.toHaveAttribute('inert');
    expect(screen.getByRole('tab', { name: 'Unrelated session' })).toBeEnabled();
    expect(client.listSessions).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(stored().tabs.map((tab) => tab.id)).toEqual([unrelated.id]));
    expect(client.listSessions).not.toHaveBeenCalled();
    expect(screen.queryByText('Loading Explorer')).not.toBeInTheDocument();
    act(() => featureDeletionStore.dismiss(root.id));
    expect(client.listSessions).not.toHaveBeenCalled();
  });

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

    // Unrelated group deletion must not trigger workspace-wide reconciliation
    // or discard successful imports while their list snapshot is still stale.
    client.listFeatures.mockResolvedValue([other, root, child, importedSecond.feature]);
    fireEvent.click(screen.getByText('Delete group'));
    await waitFor(() => expect(client.deleteGroup).toHaveBeenCalledOnce());
    expect(client.listFeatures).toHaveBeenCalledTimes(3);
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

  it('reconciles deletion completed by a previous workspace mount without closing unrelated tabs', async () => {
    const client = createClient();
    let finish!: () => void;
    const original = client.deleteFeature.getMockImplementation()!;
    client.deleteFeature.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return original();
    });
    const state = {
      tabs: [featureTab(other), featureTab(root), sessionTab],
      activeId: sessionTab.id, splitId: null,
    };
    const first = mount(state, client);
    await screen.findByText('Terminal session');
    fireEvent.click(screen.getByText('Queue feature deletion'));
    await waitFor(() => expect(client.deleteFeature).toHaveBeenCalledOnce());
    expect(stored()).toEqual(state);
    first.unmount();
    mount(stored(), client);
    await screen.findByText('Terminal session');
    await act(async () => finish());
    await waitFor(() => expect(stored().tabs).toEqual([featureTab(other)]));
    expect(screen.queryByText('Terminal session')).toBeNull();
    act(() => featureDeletionStore.dismiss(root.id));
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

  it('confirms an ambiguous deletion read-only and closes tabs only when the whole subtree is absent', async () => {
    const client = createClient();
    const remove = client.deleteFeature.getMockImplementation()!;
    client.deleteFeature.mockImplementationOnce(async () => {
      await remove();
      throw new Error('Response lost after deleting');
    });
    mount({
      tabs: [featureTab(root), agentTab, sessionTab, featureTab(other)],
      activeId: sessionTab.id, splitId: agentTab.id,
    }, client);
    await screen.findByText('Terminal session');
    fireEvent.click(screen.getByText('Queue feature deletion'));
    await waitFor(() => expect(stored().tabs).toEqual([featureTab(other)]));
    expect(client.deleteFeature).toHaveBeenCalledOnce();
    expect(featureDeletionStore.getSnapshot().find((job) => job.id === root.id)?.status).toBe('succeeded');
  });

  it.each(['descendant-remains', 'offline'] as const)(
    'does not claim ambiguous deletion succeeded when verification is %s', async (verification) => {
      const client = createClient();
      client.deleteFeature.mockImplementationOnce(async () => {
        if (verification === 'offline') client.listFeatures.mockRejectedValue(new Error('Offline'));
        else client.listFeatures.mockResolvedValue([leaf, other]);
        throw new Error('Deletion response failed');
      });
      const state = { tabs: [sessionTab, featureTab(other)], activeId: sessionTab.id, splitId: null };
      mount(state, client);
      await screen.findByText('Terminal session');
      await act(async () => fireEvent.click(screen.getByText('Queue feature deletion')));
      expect(featureDeletionStore.getSnapshot().find((job) => job.id === root.id)?.status).toBe('failed');
      expect(stored()).toEqual(state);
      expect(client.deleteFeature).toHaveBeenCalledOnce();
    },
  );

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
