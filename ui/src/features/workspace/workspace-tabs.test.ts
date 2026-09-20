import { describe, expect, it } from 'vitest';
import type { Feature, Repository, Session } from '../../lib/types.js';
import {
  closeWorkspaceTab,
  emptyWorkspaceTabsState,
  normalizeWorkspaceTabsState,
  openWorkspaceTab,
  reconcileWorkspaceTabsState,
  removeFeatureWorkspaceTabs,
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
