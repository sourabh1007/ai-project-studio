import { describe, expect, it } from 'vitest';
import type { AttachedAgent, Feature, Repository, Session } from '../../lib/types.js';
import {
  closeWorkspaceTab,
  emptyWorkspaceTabsState,
  featureSubtreeIds,
  normalizeWorkspaceTabsState,
  openWorkspaceTab,
  reconcileWorkspaceTabsState,
  removeFeatureWorkspaceTabs,
  removeSessionWorkspaceTabs,
  removeRepoWorkspaceTabs,
  removeAgentWorkspaceTabs,
  setWorkspaceSplit,
  type WorkspaceTab,
} from './workspace-tabs.js';

function feature(overrides: Partial<Feature> & { id: string }): Feature {
  return {
    name: 'Feature',
    description: 'desc',
    createdAt: '2026-01-01T00:00:00.000Z',
    summary: null,
    repoId: 'r1',
    checkoutPath: null,
    parentFeatureId: null,
    orderIndex: 0,
    ...overrides,
  };
}

function session(overrides: Partial<Session> & { id: string }): Session {
  return {
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'gpt-5.5',
    resolvedModel: null,
    status: 'created',
    kind: 'dev',
    prompt: 'prompt',
    usageFilePath: 'C:\\usage.json',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    groupId: null,
    orderIndex: 0,
    ...overrides,
  };
}

function repo(overrides: Partial<Repository> & { id: string }): Repository {
  return {
    provider: 'github',
    remoteUrl: 'https://github.com/acme/app',
    name: 'acme/app',
    localPath: 'C:\\repo',
    defaultBranch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function featureTab(value: Feature): WorkspaceTab {
  return {
    kind: 'feature',
    id: `feature:${value.id}`,
    label: value.name,
    feature: value,
  };
}

function sessionTab(value: Session, label = 'Session 1'): WorkspaceTab {
  return { kind: 'session', id: value.id, label, session: value };
}

describe('workspace-tabs', () => {
  it('opens, dedupes, closes and re-selects tabs predictably', () => {
    const f1 = feature({ id: 'f1', name: 'One' });
    const s1 = session({ id: 's1' });
    let state = emptyWorkspaceTabsState();
    state = openWorkspaceTab(state, featureTab(f1));
    state = openWorkspaceTab(state, sessionTab(s1));
    state = openWorkspaceTab(state, featureTab({ ...f1, name: 'One v2' }));
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0].label).toBe('One v2');
    expect(state.activeId).toBe('feature:f1');

    state = closeWorkspaceTab(state, 'feature:f1');
    expect(state.tabs.map((tab) => tab.id)).toEqual(['s1']);
    expect(state.activeId).toBe('s1');
  });

  it('prunes deleted tabs only when authoritative data is available', () => {
    const f1 = feature({ id: 'f1', name: 'One' });
    const f2 = feature({ id: 'f2', name: 'Two' });
    const s1 = session({ id: 's1', featureId: 'f1' });
    const state = normalizeWorkspaceTabsState({
      tabs: [featureTab(f1), sessionTab(s1), featureTab(f2)],
      activeId: 'feature:f2',
      splitId: null,
    });

    expect(
      reconcileWorkspaceTabsState(state, {
        features: null,
        sessionsByFeature: new Map([['f1', null]]),
      }),
    ).toBe(state);

    const reconciled = reconcileWorkspaceTabsState(state, {
      features: new Map([[f1.id, f1]]),
      sessionsByFeature: new Map([
        ['f1', new Map()],
        ['f2', new Map()],
      ]),
    });
    expect(reconciled.tabs.map((tab) => tab.id)).toEqual(['feature:f1']);
    expect(reconciled.activeId).toBe('feature:f1');
  });

  it('updates restored repo and session payloads while pruning removed features', () => {
    const f1 = feature({ id: 'f1', name: 'Old feature' });
    const s1 = session({ id: 's1', featureId: 'f1', name: 'Old session' });
    const r1 = repo({ id: 'r1', name: 'old/repo' });
    const state = {
      tabs: [
        featureTab(f1),
        sessionTab(s1, 'Old session'),
        { kind: 'repo', id: 'repo:r1', label: r1.name, repo: r1 } as WorkspaceTab,
      ],
      activeId: 'repo:r1',
      splitId: null,
    };

    const next = reconcileWorkspaceTabsState(state, {
      features: new Map([[f1.id, feature({ id: 'f1', name: 'New feature' })]]),
      repos: new Map([[r1.id, repo({ id: 'r1', name: 'new/repo' })]]),
      sessionsByFeature: new Map([
        [
          'f1',
          new Map([
            ['s1', session({ id: 's1', featureId: 'f1', name: 'New session' })],
          ]),
        ],
      ]),
    });

    expect(next.tabs.map((tab) => tab.label)).toEqual([
      'New feature',
      'New session',
      'new/repo',
    ]);
    expect(next.activeId).toBe('repo:r1');
  });

  it('removes all tabs for a deleted feature', () => {
    const f1 = feature({ id: 'f1' });
    const tabs = {
      tabs: [
        featureTab(f1),
        { kind: 'review-board', id: 'review-board:f1', label: 'Review Board · Feature', feature: f1 } as WorkspaceTab,
        sessionTab(session({ id: 's1', featureId: 'f1' })),
      ],
      activeId: 'review-board:f1',
      splitId: null,
    };
    const next = removeFeatureWorkspaceTabs(tabs, 'f1');
    expect(next).toEqual({ tabs: [], activeId: null, splitId: null });
  });

  it('removes deep descendants even when their ancestors have no open tabs', () => {
    const root = feature({ id: 'root' });
    const child = feature({ id: 'child', parentFeatureId: root.id });
    const leaf = feature({ id: 'leaf', parentFeatureId: child.id });
    const other = feature({ id: 'other' });
    const tabs: WorkspaceTab[] = [
      featureTab(other),
      featureTab(leaf),
      { kind: 'review-board', id: 'board', label: 'Review', feature: child },
      { kind: 'agent', id: 'agent', label: 'Agent', feature: leaf, agentId: 'a', attachmentId: 'attachment' },
      { kind: 'pr-review-tracker', id: 'tracker', label: 'Tracker', feature: root, prs: [] },
      sessionTab(session({ id: 's1', featureId: leaf.id })),
    ];
    expect(removeFeatureWorkspaceTabs({
      tabs, activeId: 's1', splitId: 'agent',
    }, root.id, [leaf, child, root])).toEqual({
      tabs: [featureTab(other)], activeId: 'feature:other', splitId: null,
    });
  });

  it('prunes deleted PRs from surviving trackers without closing the parent', () => {
    const parent = feature({ id: 'parent' });
    const tracker: WorkspaceTab = {
      kind: 'pr-review-tracker', id: 'tracker', label: 'Bulk Review · Feature',
      feature: parent,
      prs: [
        { featureId: 'removed', number: 1, title: 'One' },
        { featureId: 'kept', number: 2, title: 'Two' },
      ],
    };
    const state = { tabs: [tracker], activeId: tracker.id, splitId: null };
    const removed = removeFeatureWorkspaceTabs(state, 'removed');
    expect(removed.tabs).toEqual([{ ...tracker, prs: [tracker.prs[1]] }]);
    expect(removed.activeId).toBe(tracker.id);
    expect(reconcileWorkspaceTabsState(state, {
      features: new Map([
        [parent.id, parent],
        ['kept', feature({ id: 'kept', parentFeatureId: parent.id })],
      ]),
    })).toEqual(removed);
  });

  it('resolves subtree IDs from the newest placements and tolerates malformed cycles', () => {
    expect([...featureSubtreeIds('root', [
      feature({ id: 'child', parentFeatureId: 'root' }),
      feature({ id: 'root', parentFeatureId: 'leaf' }),
      feature({ id: 'leaf', parentFeatureId: 'root' }),
      feature({ id: 'child', parentFeatureId: 'elsewhere' }),
    ])]).toEqual(['root', 'leaf']);
  });

  it('refreshes tracker membership and titles from feature placement and actual PR metadata', () => {
    const parent = feature({ id: 'parent' });
    const existing = feature({ id: 'existing', name: 'PR #999: Not the actual title', parentFeatureId: parent.id });
    const imported = feature({ id: 'imported', name: 'Another display name', parentFeatureId: parent.id });
    const ordinary = feature({ id: 'ordinary', name: 'PR #100: Not a PR', parentFeatureId: parent.id });
    const moved = feature({ id: 'moved', parentFeatureId: 'another-parent' });
    const tracker: WorkspaceTab = {
      kind: 'pr-review-tracker', id: 'tracker', label: 'Bulk Review · Feature', feature: parent,
      prs: [
        { featureId: 'existing', number: 1, title: 'Old PR title' },
        { featureId: 'moved', number: 3, title: 'Moved PR' },
      ],
    };
    const state = { tabs: [tracker], activeId: tracker.id, splitId: null };
    const features = new Map([parent, existing, imported, ordinary, moved].map((f) => [f.id, f]));
    const next = reconcileWorkspaceTabsState(state, {
      features,
      prReviews: new Map([
        ['existing', { pull: { number: 1, title: 'Actual updated title', url: '' } }],
        ['imported', { pull: { number: 2, title: 'Actual imported title', url: '' } }],
        ['ordinary', null],
      ]),
    });
    expect(next.tabs[0]).toMatchObject({
      prs: [
        { featureId: 'existing', number: 1, title: 'Actual updated title' },
        { featureId: 'imported', number: 2, title: 'Actual imported title' },
      ],
    });
    expect(reconcileWorkspaceTabsState(state, { features }).tabs[0]).toMatchObject({
      prs: [{ featureId: 'existing', number: 1, title: 'Old PR title' }],
    });
  });

  it('matches deleted entity payloads, not overlapping tab IDs or kinds', () => {
    const f = feature({ id: 'same' });
    const r = repo({ id: 'same' });
    const featureView = { ...featureTab(f), id: 'same' };
    const sessionView = sessionTab(session({ id: 'same' }));
    sessionView.id = 'persisted-session-alias';
    const repoView: WorkspaceTab = { kind: 'repo', id: 'repo-view', label: r.name, repo: r };
    const agentView: WorkspaceTab = {
      kind: 'agent', id: 'agent-view', label: 'Agent', feature: f,
      agentId: 'a', attachmentId: 'same',
    };
    const state = {
      tabs: [featureView, sessionView, repoView, agentView],
      activeId: sessionView.id, splitId: repoView.id,
    };
    expect(removeSessionWorkspaceTabs(state, 'same').tabs).toEqual([featureView, repoView, agentView]);
    expect(removeRepoWorkspaceTabs(state, 'same').tabs).toEqual([featureView, sessionView, agentView]);
    expect(removeRepoWorkspaceTabs(state, 'same').splitId).toBeNull();
    expect(removeAgentWorkspaceTabs(state, 'same').tabs).toEqual([featureView, sessionView, repoView]);
  });

  it('closes every alias for a session while retaining unrelated active and split tabs', () => {
    const active = featureTab(feature({ id: 'active' }));
    const split = featureTab(feature({ id: 'split' }));
    const deleted = sessionTab(session({ id: 'deleted' }));
    const state = {
      tabs: [active, deleted, split, { ...deleted, id: 'legacy-session' }],
      activeId: active.id, splitId: split.id,
    };
    expect(removeSessionWorkspaceTabs(state, 'deleted')).toEqual({
      tabs: [active, split], activeId: active.id, splitId: split.id,
    });
  });

  it('removes matching agent aliases and legacy boards but preserves other attachments', () => {
    const f = feature({ id: 'f1' });
    const agent: WorkspaceTab = {
      kind: 'agent', id: 'agent', label: 'Review', feature: f,
      agentId: 'review-board', attachmentId: 'attachment',
    };
    const alias = { ...agent, id: 'alias', attachmentId: 'review-board:f1' };
    const other = { ...agent, id: 'other', attachmentId: 'another-attachment' };
    const legacy: WorkspaceTab = { kind: 'review-board', id: 'legacy', label: 'Review', feature: f };
    const state = {
      tabs: [agent, alias, legacy, other],
      activeId: agent.id, splitId: alias.id,
    };
    expect(removeAgentWorkspaceTabs(state, 'attachment')).toEqual({
      tabs: [other], activeId: other.id, splitId: null,
    });
    expect(removeAgentWorkspaceTabs({
      tabs: [legacy, featureTab(f)], activeId: legacy.id, splitId: null,
    }, 'attachment', { featureId: f.id, agentId: 'review-board' }).tabs).toEqual([featureTab(f)]);
  });

  it('reconciles detached agents and legacy Review Boards only from authoritative attachment lists', () => {
    const f = feature({ id: 'f1' });
    const agent: WorkspaceTab = {
      kind: 'agent', id: 'agent', label: 'Review Board · Feature', feature: f,
      agentId: 'review-board', attachmentId: 'review-board:f1',
    };
    const legacy: WorkspaceTab = { kind: 'review-board', id: 'legacy', label: 'Review Board · Feature', feature: f };
    const state = { tabs: [agent, legacy, featureTab(f)], activeId: agent.id, splitId: legacy.id };
    expect(reconcileWorkspaceTabsState(state, {
      agentsByFeature: new Map([[f.id, null]]),
    })).toBe(state);
    const attached = {
      attachment: { id: 'real-id', featureId: f.id, agentId: 'review-board' },
      manifest: { allowMultiplePerFeature: false },
    } as AttachedAgent;
    const resolved = reconcileWorkspaceTabsState(state, {
      agentsByFeature: new Map([[f.id, [attached]]]),
    });
    expect(resolved.tabs[0]).toMatchObject({ attachmentId: 'real-id' });
    const removed = reconcileWorkspaceTabsState(resolved, {
      agentsByFeature: new Map([[f.id, []]]),
    });
    expect(removed).toEqual({ tabs: [featureTab(f)], activeId: 'feature:f1', splitId: null });
    // A newly attached instance must not revive a tab for a deleted attachment.
    expect(reconcileWorkspaceTabsState(resolved, {
      agentsByFeature: new Map([[f.id, [{
        ...attached, attachment: { ...attached.attachment, id: 'replacement' },
      }]]]),
    }).tabs.map((tab) => tab.id)).toEqual(['legacy', 'feature:f1']);
  });

  it('opens a tab in the split pane and keeps it distinct from the active tab', () => {
    const s1 = session({ id: 's1' });
    const s2 = session({ id: 's2' });
    let state = emptyWorkspaceTabsState();
    state = openWorkspaceTab(state, sessionTab(s1));
    state = openWorkspaceTab(state, sessionTab(s2));
    // s2 is active; split s1 into the side pane.
    state = setWorkspaceSplit(state, 's1');
    expect(state.activeId).toBe('s2');
    expect(state.splitId).toBe('s1');

    // Splitting the active tab against itself collapses to a single pane.
    expect(setWorkspaceSplit(state, 's2').splitId).toBe(null);
    // Splitting an unknown tab is ignored.
    expect(setWorkspaceSplit(state, 'missing').splitId).toBe(null);
    // Passing null collapses back to a single pane.
    expect(setWorkspaceSplit(state, null).splitId).toBe(null);
  });

  it('clears the split when the split tab is closed or promoted to active', () => {
    const s1 = session({ id: 's1' });
    const s2 = session({ id: 's2' });
    let state = openWorkspaceTab(emptyWorkspaceTabsState(), sessionTab(s1));
    state = openWorkspaceTab(state, sessionTab(s2));
    state = setWorkspaceSplit(state, 's1');
    expect(state.splitId).toBe('s1');

    // Closing the side tab collapses the split.
    const closed = closeWorkspaceTab(state, 's1');
    expect(closed.splitId).toBe(null);
    expect(closed.tabs.map((t) => t.id)).toEqual(['s2']);

    // Re-opening the split tab as the active tab also clears the split.
    const promoted = openWorkspaceTab(state, sessionTab(s1));
    expect(promoted.activeId).toBe('s1');
    expect(promoted.splitId).toBe(null);
  });

  it('drops the split when its feature is removed', () => {
    const s1 = session({ id: 's1', featureId: 'f1' });
    const f2 = feature({ id: 'f2', name: 'Two' });
    let state = openWorkspaceTab(emptyWorkspaceTabsState(), featureTab(f2));
    state = openWorkspaceTab(state, sessionTab(s1));
    state = setWorkspaceSplit(state, 'feature:f2');
    expect(state.splitId).toBe('feature:f2');
    const removed = removeFeatureWorkspaceTabs(state, 'f2');
    expect(removed.splitId).toBe(null);
  });

  it('accepts persisted state that predates the split field', () => {
    // Legacy persisted payloads have no splitId; they must still validate and
    // normalize to a single-pane layout.
    const legacy = { tabs: [], activeId: null };
    const normalized = normalizeWorkspaceTabsState(
      legacy as unknown as Parameters<typeof normalizeWorkspaceTabsState>[0],
    );
    expect(normalized.splitId).toBe(null);
  });
});
