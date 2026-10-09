import type { ApiClient } from './api';
import type {
  AttachedAgent,
  Feature,
  PlannerLaunchKind,
  PlannerTask,
  Session,
} from './types';

/**
 * A resolved request to open something in the workspace, produced by the
 * Planner after it has done the async API work. `App` carries it across to the
 * workspace view, which opens the matching tab and clears it.
 */
export type WorkspaceLaunchIntent =
  | { kind: 'session'; session: Session; label: string }
  | { kind: 'agent'; feature: Feature; attached: AttachedAgent }
  | { kind: 'review-board'; feature: Feature };

/** The subset of the API client the launch helpers depend on. */
export type PlannerLaunchApi = Pick<
  ApiClient,
  | 'createFeature'
  | 'attachAgent'
  | 'getAgent'
  | 'startSession'
  | 'renameSession'
  | 'createPrFeature'
>;

/** The subset of the API client the re-open helper depends on. */
export type PlannerReopenApi = Pick<
  ApiClient,
  'getSession' | 'getFeature' | 'listFeatureAgents'
>;

/** The persisted link recorded on a task after it is launched. */
export interface PlannerLaunchLink {
  launchKind: PlannerLaunchKind;
  featureId: string | null;
  sessionId: string | null;
  launchLabel: string;
}

/** The agent attached when launching a task with the New Task planner. */
const NEW_TASK_AGENT_ID = 'new-task';

/** How long a derived feature name may get before it is truncated. */
const MAX_FEATURE_NAME = 80;

/**
 * Parses a pull-request number from a stored PR reference, accepting a bare
 * number, a GitHub `/pull/<n>` URL, or an Azure DevOps `/pullrequest/<n>` URL.
 * Falls back to the last run of digits in the string. Returns `null` when no
 * number can be found.
 */
export function parsePullNumber(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const path = trimmed.match(/(?:pull|pullrequest|pull-request|pulls)\/(\d+)/i);
  if (path) {
    return Number(path[1]);
  }
  const digits = trimmed.match(/\d+/g);
  if (digits) {
    return Number(digits[digits.length - 1]);
  }
  return null;
}

/**
 * Derives a concise, tidy workspace name from a planner task title: trimmed,
 * stripped of a trailing full stop, sentence-cased, and length-capped.
 */
export function featureNameForTask(task: PlannerTask): string {
  const cleaned = task.title.trim().replace(/[.\s]+$/, '');
  if (!cleaned) {
    return 'Planner task';
  }
  const cased = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return cased.length > MAX_FEATURE_NAME
    ? `${cased.slice(0, MAX_FEATURE_NAME - 1).trimEnd()}…`
    : cased;
}

/** Builds the prompt text seeded into a session or planning agent. */
export function promptForTask(task: PlannerTask): string {
  const title = task.title.trim();
  const notes = task.notes.trim();
  return notes ? `${title}\n\n${notes}` : title;
}

/**
 * The name of the dated parent feature a launch is nested under: the task's
 * calendar day followed by the tidy task name (e.g. `2026-02-10 · Fix login`).
 * Grouping every launch for a task beneath one dated parent keeps the workspace
 * tree organized by day.
 */
export function datedFeatureName(task: PlannerTask): string {
  return `${task.date} · ${featureNameForTask(task)}`;
}

/**
 * Creates (or reuses, when the task was already launched once) the dated parent
 * feature that a task's launches nest under, returning its id. Reuse avoids a
 * second parent when a task is launched into more than one surface.
 */
async function resolveParentFeatureId(
  api: PlannerLaunchApi,
  task: PlannerTask,
  repoId: string | null,
): Promise<string> {
  if (task.featureId) {
    return task.featureId;
  }
  const parent = await api.createFeature({
    name: datedFeatureName(task),
    description: promptForTask(task),
    repoId: repoId ?? null,
  });
  return parent.id;
}

/**
 * Creates a feature for the task and attaches the New Task planning agent,
 * returning an intent that opens that agent in the workspace.
 */
export async function launchNewTask(
  api: PlannerLaunchApi,
  task: PlannerTask,
  repoId: string | null,
): Promise<WorkspaceLaunchIntent> {
  const parentFeatureId = await resolveParentFeatureId(api, task, repoId);
  const feature = await api.createFeature({
    name: featureNameForTask(task),
    description: promptForTask(task),
    repoId: repoId ?? null,
    parentFeatureId,
  });
  const attachment = await api.attachAgent(feature.id, NEW_TASK_AGENT_ID);
  const catalog = await api.getAgent(NEW_TASK_AGENT_ID);
  const attached: AttachedAgent = { attachment, manifest: catalog.manifest };
  return { kind: 'agent', feature, attached };
}

/**
 * Creates a feature for the task and starts a CLI session seeded with the task
 * text, naming the session after the task. Returns an intent that opens that
 * session in the workspace.
 */
export async function launchSession(
  api: PlannerLaunchApi,
  task: PlannerTask,
  repoId: string | null,
): Promise<WorkspaceLaunchIntent> {
  const name = featureNameForTask(task);
  const parentFeatureId = await resolveParentFeatureId(api, task, repoId);
  const feature = await api.createFeature({
    name,
    description: promptForTask(task),
    repoId: repoId ?? null,
    parentFeatureId,
  });
  const started = await api.startSession(feature.id, {
    prompt: promptForTask(task),
  });
  const session = await api.renameSession(started.id, name);
  return { kind: 'session', session, label: name };
}

/**
 * Imports the task's pull request as a feature and returns an intent that opens
 * its Review Board. Requires a repository and a resolvable PR number.
 */
export async function launchReview(
  api: PlannerLaunchApi,
  task: PlannerTask,
  repoId: string | null,
): Promise<WorkspaceLaunchIntent> {
  if (!repoId) {
    throw new Error('Pick a repository before starting a review.');
  }
  const number = parsePullNumber(task.prUrl || task.title);
  if (number === null) {
    throw new Error('This task has no pull-request number to review.');
  }
  const parentFeatureId = await resolveParentFeatureId(api, task, repoId);
  const feature = await api.createPrFeature(repoId, number, parentFeatureId);
  return { kind: 'review-board', feature };
}

/** Maps an intent returned by a launch into the link persisted on the task. */
export function linkFromIntent(intent: WorkspaceLaunchIntent): PlannerLaunchLink {
  if (intent.kind === 'session') {
    return {
      launchKind: 'session',
      featureId: intent.session.featureId,
      sessionId: intent.session.id,
      launchLabel: intent.label,
    };
  }
  if (intent.kind === 'agent') {
    return {
      launchKind: 'agent',
      featureId: intent.feature.id,
      sessionId: null,
      launchLabel: intent.feature.name,
    };
  }
  return {
    launchKind: 'review',
    featureId: intent.feature.id,
    sessionId: null,
    launchLabel: intent.feature.name,
  };
}

/**
 * Rebuilds the launch intent for an already-launched task so it can be
 * re-opened in the workspace. Throws when the underlying session/feature/agent
 * no longer exists, so the caller can offer to recreate it.
 */
export async function reopenTask(
  api: PlannerReopenApi,
  task: PlannerTask,
): Promise<WorkspaceLaunchIntent> {
  if (task.launchKind === 'session') {
    if (!task.sessionId) {
      throw new Error('This task has no session to open.');
    }
    const session = await api.getSession(task.sessionId);
    return {
      kind: 'session',
      session,
      label: task.launchLabel ?? session.featureId,
    };
  }
  if (!task.featureId) {
    throw new Error('This task has nothing to open.');
  }
  const feature = await api.getFeature(task.featureId);
  if (task.launchKind === 'review') {
    return { kind: 'review-board', feature };
  }
  const agents = await api.listFeatureAgents(feature.id);
  const attached = agents.find(
    (candidate) => candidate.attachment.agentId === NEW_TASK_AGENT_ID,
  );
  if (!attached) {
    throw new Error('The planning agent is no longer attached.');
  }
  return { kind: 'agent', feature, attached };
}
