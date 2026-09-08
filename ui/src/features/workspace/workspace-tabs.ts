import type { Feature, Repository, Session } from '../../lib/types.js';

export type WorkspaceTab =
  | { kind: 'session'; id: string; label: string; session: Session }
  | { kind: 'feature'; id: string; label: string; feature: Feature }
  | { kind: 'review-board'; id: string; label: string; feature: Feature }
  | { kind: 'repo'; id: string; label: string; repo: Repository };

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeId: string | null;
}

export interface WorkspaceTabReconcileSources {
  features?: Map<string, Feature> | null;
  repos?: Map<string, Repository> | null;
  sessionsByFeature?: Map<string, Map<string, Session> | null>;
}

type PersistedObject = Record<string, unknown>;

function isObject(value: unknown): value is PersistedObject {
  return Boolean(value) && typeof value === 'object';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function hasKeys(
  value: unknown,
  keys: readonly string[],
): value is PersistedObject {
  return isObject(value) && keys.every((key) => key in value);
}

function isFeature(value: unknown): value is Feature {
  return (
    hasKeys(value, [
      'id',
      'name',
      'description',
      'createdAt',
      'summary',
      'repoId',
      'checkoutPath',
    ]) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.description) &&
    isString(value.createdAt) &&
    (value.summary === null || isString(value.summary)) &&
    isNullableString(value.repoId) &&
    isNullableString(value.checkoutPath) &&
    (value.parentFeatureId === undefined ||
      value.parentFeatureId === null ||
      isString(value.parentFeatureId)) &&
    (value.orderIndex === undefined || typeof value.orderIndex === 'number')
  );
}

function isSession(value: unknown): value is Session {
  return (
    hasKeys(value, [
      'id',
      'featureId',
      'name',
      'provider',
      'requestedModel',
      'resolvedModel',
      'status',
      'kind',
      'prompt',
      'usageFilePath',
      'createdAt',
      'startedAt',
      'endedAt',
      'exitCode',
    ]) &&
    isString(value.id) &&
    isString(value.featureId) &&
    isNullableString(value.name) &&
    isString(value.provider) &&
    isString(value.requestedModel) &&
    isNullableString(value.resolvedModel) &&
    isString(value.status) &&
    isString(value.kind) &&
    isString(value.prompt) &&
    isString(value.usageFilePath) &&
    isString(value.createdAt) &&
    isNullableString(value.startedAt) &&
    isNullableString(value.endedAt) &&
    (value.exitCode === null || typeof value.exitCode === 'number') &&
    (value.groupId === undefined ||
      value.groupId === null ||
      isString(value.groupId)) &&
    (value.orderIndex === undefined || typeof value.orderIndex === 'number')
  );
}

function isRepository(value: unknown): value is Repository {
  return (
    hasKeys(value, [
      'id',
      'provider',
      'remoteUrl',
      'name',
      'localPath',
      'defaultBranch',
      'createdAt',
    ]) &&
    isString(value.id) &&
    isString(value.provider) &&
    isString(value.remoteUrl) &&
    isString(value.name) &&
    isString(value.localPath) &&
    isNullableString(value.defaultBranch) &&
    isString(value.createdAt)
  );
}

function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  if (!hasKeys(value, ['kind', 'id', 'label'])) {
    return false;
  }
  if (!isString(value.kind) || !isString(value.id) || !isString(value.label)) {
    return false;
  }
  switch (value.kind) {
    case 'session':
      return isSession(value.session);
    case 'feature':
    case 'review-board':
      return isFeature(value.feature);
    case 'repo':
      return isRepository(value.repo);
    default:
      return false;
  }
}

export function isWorkspaceTabsState(value: unknown): value is WorkspaceTabsState {
  return (
    hasKeys(value, ['tabs', 'activeId']) &&
    Array.isArray(value.tabs) &&
    value.tabs.every((tab) => isWorkspaceTab(tab)) &&
    (value.activeId === null || isString(value.activeId))
  );
}

export function emptyWorkspaceTabsState(): WorkspaceTabsState {
  return { tabs: [], activeId: null };
}

function withUniqueTabs(tabs: readonly WorkspaceTab[]): WorkspaceTab[] {
  const seen = new Set<string>();
  const unique: WorkspaceTab[] = [];
  for (const tab of tabs) {
    if (seen.has(tab.id)) {
      continue;
    }
    seen.add(tab.id);
    unique.push(tab);
  }
  return unique;
}

function normalizeActiveId(
  tabs: readonly WorkspaceTab[],
  activeId: string | null,
): string | null {
  if (activeId && tabs.some((tab) => tab.id === activeId)) {
    return activeId;
  }
  return tabs[tabs.length - 1]?.id ?? null;
}

export function normalizeWorkspaceTabsState(
  state: WorkspaceTabsState,
): WorkspaceTabsState {
  const tabs = withUniqueTabs(state.tabs);
  const activeId = normalizeActiveId(tabs, state.activeId);
  if (tabs === state.tabs && activeId === state.activeId) {
    return state;
  }
  return { tabs, activeId };
}

export function openWorkspaceTab(
  state: WorkspaceTabsState,
  tab: WorkspaceTab,
): WorkspaceTabsState {
  const existingIndex = state.tabs.findIndex((candidate) => candidate.id === tab.id);
  const tabs =
    existingIndex >= 0
      ? state.tabs.map((candidate, index) =>
          index === existingIndex ? tab : candidate,
        )
      : [...state.tabs, tab];
  return { tabs, activeId: tab.id };
}

export function closeWorkspaceTab(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  return { tabs, activeId: normalizeActiveId(tabs, state.activeId === id ? null : state.activeId) };
}

export function removeFeatureWorkspaceTabs(
  state: WorkspaceTabsState,
  featureId: string,
): WorkspaceTabsState {
  const tabs = state.tabs.filter(
    (tab) =>
      !(tab.kind === 'feature' && tab.feature.id === featureId) &&
      !(tab.kind === 'review-board' && tab.feature.id === featureId) &&
      !(tab.kind === 'session' && tab.session.featureId === featureId),
  );
  return { tabs, activeId: normalizeActiveId(tabs, state.activeId) };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reconcileTab(
  tab: WorkspaceTab,
  sources: WorkspaceTabReconcileSources,
): WorkspaceTab | null {
  if (tab.kind === 'feature' || tab.kind === 'review-board') {
    if (!sources.features) {
      return tab;
    }
    const feature = sources.features.get(tab.feature.id);
    if (!feature) {
      return null;
    }
    const label =
      tab.kind === 'review-board'
        ? `Review Board · ${feature.name}`
        : feature.name;
    return { ...tab, feature, label };
  }
  if (tab.kind === 'repo') {
    if (!sources.repos) {
      return tab;
    }
    const repo = sources.repos.get(tab.repo.id);
    if (!repo) {
      return null;
    }
    return { ...tab, repo, label: repo.name };
  }
  if (sources.features && !sources.features.has(tab.session.featureId)) {
    return null;
  }
  const sessions = sources.sessionsByFeature?.get(tab.session.featureId);
  if (!sessions) {
    return tab;
  }
  const session = sessions.get(tab.session.id);
  if (!session) {
    return null;
  }
  return {
    ...tab,
    session,
    label: session.name?.trim() || tab.label,
  };
}

export function reconcileWorkspaceTabsState(
  state: WorkspaceTabsState,
  sources: WorkspaceTabReconcileSources,
): WorkspaceTabsState {
  const tabs = withUniqueTabs(
    state.tabs
      .map((tab) => reconcileTab(tab, sources))
      .filter((tab): tab is WorkspaceTab => tab !== null),
  );
  const activeId = normalizeActiveId(tabs, state.activeId);
  if (
    state.tabs.length === tabs.length &&
    state.activeId === activeId &&
    state.tabs.every((tab, index) => sameJsonValue(tab, tabs[index]))
  ) {
    return state;
  }
  return { tabs, activeId };
}
