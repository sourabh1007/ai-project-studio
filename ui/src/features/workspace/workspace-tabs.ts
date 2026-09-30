import type { AgentAttachment, AttachedAgent, Feature, PrReview, Repository, Session } from '../../lib/types.js';

/** One PR tracked inside a bulk review tracker tab. */
export interface TrackedPr {
  featureId: string;
  number: number;
  title: string;
}

export type WorkspaceTab =
  | { kind: 'session'; id: string; label: string; session: Session }
  | { kind: 'feature'; id: string; label: string; feature: Feature }
  | { kind: 'review-board'; id: string; label: string; feature: Feature }
  | {
      kind: 'pr-review-tracker';
      id: string;
      label: string;
      feature: Feature;
      prs: TrackedPr[];
    }
  | {
      kind: 'agent';
      id: string;
      label: string;
      agentId: string;
      attachmentId: string;
      feature: Feature;
    }
  | { kind: 'repo'; id: string; label: string; repo: Repository };

export interface WorkspaceTabsState {
  tabs: WorkspaceTab[];
  activeId: string | null;
  /**
   * Tab shown in the secondary (side-by-side) pane, or null for a single pane.
   * Always references an existing tab distinct from {@link activeId}.
   */
  splitId: string | null;
}

export interface WorkspaceTabReconcileSources {
  features?: Map<string, Feature> | null;
  repos?: Map<string, Repository> | null;
  sessionsByFeature?: Map<string, Map<string, Session> | null>;
  agentsByFeature?: Map<string, AttachedAgent[] | null>;
  prReviews?: Map<string, Pick<PrReview, 'pull'> | null>;
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

function isTrackedPr(value: unknown): value is TrackedPr {
  return (
    isObject(value) &&
    isString(value.featureId) &&
    typeof value.number === 'number' &&
    isString(value.title)
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
    case 'pr-review-tracker':
      return (
        isFeature(value.feature) &&
        Array.isArray(value.prs) &&
        value.prs.every((pr) => isTrackedPr(pr))
      );
    case 'agent':
      return (
        isString(value.agentId) &&
        isString(value.attachmentId) &&
        isFeature(value.feature)
      );
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
    (value.activeId === null || isString(value.activeId)) &&
    // splitId was added later; tolerate persisted state that predates it.
    (value.splitId === undefined ||
      value.splitId === null ||
      isString(value.splitId))
  );
}

export function emptyWorkspaceTabsState(): WorkspaceTabsState {
  return { tabs: [], activeId: null, splitId: null };
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

/**
 * The split pane must reference a live tab that is distinct from the active
 * tab; anything else collapses back to a single pane.
 */
function normalizeSplitId(
  tabs: readonly WorkspaceTab[],
  activeId: string | null,
  splitId: string | null | undefined,
): string | null {
  if (splitId && splitId !== activeId && tabs.some((tab) => tab.id === splitId)) {
    return splitId;
  }
  return null;
}

function buildState(
  tabs: readonly WorkspaceTab[],
  activeId: string | null,
  splitId: string | null | undefined,
): WorkspaceTabsState {
  const nextActive = normalizeActiveId(tabs, activeId);
  return {
    tabs: tabs as WorkspaceTab[],
    activeId: nextActive,
    splitId: normalizeSplitId(tabs, nextActive, splitId),
  };
}

export function normalizeWorkspaceTabsState(
  state: WorkspaceTabsState,
): WorkspaceTabsState {
  const tabs = withUniqueTabs(state.tabs);
  const activeId = normalizeActiveId(tabs, state.activeId);
  const splitId = normalizeSplitId(tabs, activeId, state.splitId);
  if (
    tabs === state.tabs &&
    activeId === state.activeId &&
    splitId === (state.splitId ?? null)
  ) {
    return state;
  }
  return { tabs, activeId, splitId };
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
  return buildState(tabs, tab.id, state.splitId);
}

/**
 * Show a tab in the secondary pane (side by side with the active tab), or pass
 * null to collapse back to a single pane. A tab can only be split against a
 * different active tab.
 */
export function setWorkspaceSplit(
  state: WorkspaceTabsState,
  splitId: string | null,
): WorkspaceTabsState {
  return buildState(state.tabs, state.activeId, splitId);
}

export function closeWorkspaceTab(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  return buildState(
    tabs,
    state.activeId === id ? null : state.activeId,
    state.splitId === id ? null : state.splitId,
  );
}

/** Closes every workspace tab, returning the empty state. */
export function closeAllWorkspaceTabs(
  _state: WorkspaceTabsState,
): WorkspaceTabsState {
  return emptyWorkspaceTabsState();
}

/**
 * Closes the tabs positioned to the left of `id` (lower index), keeping the
 * target tab and everything to its right. A no-op when `id` is unknown or
 * already the leftmost tab.
 */
export function closeWorkspaceTabsToLeft(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index <= 0) {
    return state;
  }
  return buildState(state.tabs.slice(index), state.activeId, state.splitId);
}

/**
 * Closes the tabs positioned to the right of `id` (higher index), keeping the
 * target tab and everything to its left. A no-op when `id` is unknown or
 * already the rightmost tab.
 */
export function closeWorkspaceTabsToRight(
  state: WorkspaceTabsState,
  id: string,
): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0 || index === state.tabs.length - 1) {
    return state;
  }
  return buildState(state.tabs.slice(0, index + 1), state.activeId, state.splitId);
}

export function featureSubtreeIds(
  featureId: string,
  features: readonly Feature[],
): Set<string> {
  const children = new Map<string, string[]>();
  for (const feature of new Map(features.map((item) => [item.id, item])).values()) {
    if (!feature.parentFeatureId) continue;
    const siblings = children.get(feature.parentFeatureId) ?? [];
    siblings.push(feature.id);
    children.set(feature.parentFeatureId, siblings);
  }
  const deleted = new Set([featureId]);
  for (const id of deleted) {
    for (const child of children.get(id) ?? []) {
      deleted.add(child);
    }
  }
  return deleted;
}

export function removeFeatureWorkspaceTabs(
  state: WorkspaceTabsState,
  featureId: string,
  features: readonly Feature[] = [],
): WorkspaceTabsState {
  const knownFeatures = new Map(
    state.tabs.flatMap((tab) =>
      'feature' in tab ? [[tab.feature.id, tab.feature] as const] : [],
    ),
  );
  for (const feature of features) knownFeatures.set(feature.id, feature);
  const deleted = featureSubtreeIds(featureId, [...knownFeatures.values()]);
  const tabs = state.tabs
    .filter((tab) =>
      tab.kind === 'repo' ||
      !deleted.has(tab.kind === 'session' ? tab.session.featureId : tab.feature.id),
    )
    .map((tab) => tab.kind === 'pr-review-tracker'
      ? { ...tab, prs: tab.prs.filter((pr) => !deleted.has(pr.featureId)) }
      : tab);
  return buildState(tabs, state.activeId, state.splitId);
}

export function removeSessionWorkspaceTabs(
  state: WorkspaceTabsState,
  sessionId: string,
): WorkspaceTabsState {
  return buildState(
    state.tabs.filter((tab) => tab.kind !== 'session' || tab.session.id !== sessionId),
    state.activeId,
    state.splitId,
  );
}

export function removeRepoWorkspaceTabs(
  state: WorkspaceTabsState,
  repoId: string,
): WorkspaceTabsState {
  return buildState(
    state.tabs.filter((tab) => tab.kind !== 'repo' || tab.repo.id !== repoId),
    state.activeId,
    state.splitId,
  );
}

export function removeAgentWorkspaceTabs(
  state: WorkspaceTabsState,
  attachmentId: string,
  attachment?: Pick<AgentAttachment, 'agentId' | 'featureId'>,
): WorkspaceTabsState {
  const matching = state.tabs.find(
    (tab) => tab.kind === 'agent' && tab.attachmentId === attachmentId,
  );
  const owner = attachment ?? (matching?.kind === 'agent'
    ? { agentId: matching.agentId, featureId: matching.feature.id }
    : undefined);
  return buildState(
    state.tabs.filter((tab) => {
      if (tab.kind === 'review-board') {
        return owner?.agentId !== 'review-board' || owner.featureId !== tab.feature.id;
      }
      if (tab.kind !== 'agent') return true;
      if (tab.attachmentId === attachmentId) return false;
      return !owner ||
        tab.agentId !== owner.agentId ||
        tab.feature.id !== owner.featureId ||
        tab.attachmentId !== `${owner.agentId}:${owner.featureId}`;
    }),
    state.activeId,
    state.splitId,
  );
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reconcileTab(
  tab: WorkspaceTab,
  sources: WorkspaceTabReconcileSources,
): WorkspaceTab | null {
  if (
    tab.kind === 'feature' ||
    tab.kind === 'review-board' ||
    tab.kind === 'pr-review-tracker' ||
    tab.kind === 'agent'
  ) {
    const feature = sources.features ? sources.features.get(tab.feature.id) : tab.feature;
    if (!feature) {
      return null;
    }
    const agents = sources.agentsByFeature?.get(feature.id);
    if (
      tab.kind === 'review-board' &&
      agents &&
      !agents.some((entry) => entry.attachment.agentId === 'review-board')
    ) {
      return null;
    }
    if (tab.kind === 'agent') {
      const attached = agents?.find((entry) =>
        entry.attachment.id === tab.attachmentId ||
        // PR shortcuts historically opened a single-instance agent before its
        // actual attachment ID was loaded. Resolve that alias, not other IDs.
        (tab.attachmentId === `${tab.agentId}:${feature.id}` &&
          !entry.manifest.allowMultiplePerFeature &&
          entry.attachment.agentId === tab.agentId),
      );
      if (agents && !attached) return null;
      const prefix = tab.label.split(' · ')[0];
      return {
        ...tab,
        feature,
        attachmentId: attached?.attachment.id ?? tab.attachmentId,
        label: `${prefix} · ${feature.name}`,
      };
    }
    if (tab.kind === 'pr-review-tracker') {
      const prs = new Map(
        tab.prs
          .filter((pr) => !sources.features ||
            sources.features.get(pr.featureId)?.parentFeatureId === feature.id)
          .map((pr) => [pr.featureId, pr]),
      );
      for (const child of sources.features?.values() ?? []) {
        if (child.parentFeatureId !== feature.id) continue;
        const review = sources.prReviews?.get(child.id);
        if (review) {
          prs.set(child.id, {
            featureId: child.id,
            number: review.pull.number,
            title: review.pull.title,
          });
        }
      }
      return {
        ...tab,
        feature,
        label: `Bulk Review · ${feature.name}`,
        prs: [...prs.values()],
      };
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
  const splitId = normalizeSplitId(tabs, activeId, state.splitId);
  if (
    state.tabs.length === tabs.length &&
    state.activeId === activeId &&
    (state.splitId ?? null) === splitId &&
    state.tabs.every((tab, index) => sameJsonValue(tab, tabs[index]))
  ) {
    return state;
  }
  return { tabs, activeId, splitId };
}
