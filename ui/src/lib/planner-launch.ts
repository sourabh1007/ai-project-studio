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
  | 'listFeatures'
  | 'createFeature'
  | 'attachAgent'
  | 'getAgent'
  | 'createTerminalSession'
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

/** Reports a human-readable phase label as a launch progresses, for live UI. */
export type LaunchPhaseReporter = (phase: string) => void;

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
 * Derives a concise, tidy workspace name from a planner task title: the first
 * non-empty line (so multi-line tasks still yield a single-line name), trimmed,
 * stripped of a trailing full stop, sentence-cased, and length-capped.
 */
export function featureNameForTask(task: PlannerTask): string {
  const firstLine =
    task.title
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const cleaned = firstLine.replace(/[.\s]+$/, '');
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
 * The name of the dated parent feature a launch is nested under: simply the
 * task's calendar day (e.g. `2026-02-10`). Grouping every launch for a task
 * beneath one dated parent keeps the workspace tree organized by day; the
 * parent is a lightweight date bucket, so it carries no task name — the task's
 * own child feature/session underneath it holds the title. Once the user moves
 * a session out of this bucket, the workspace's own naming rules take over.
 */
export function datedFeatureName(task: PlannerTask): string {
  return task.date;
}

/**
 * Creates (or reuses, when the task was already launched once) the dated parent
 * feature that a task's launches nest under, returning its id. Reuse avoids a
 * second parent when a task is launched into more than one surface.
 *
 * Launches of *different* tasks that fall on the same calendar day must share a
 * single dated bucket rather than piling up duplicate same-named folders, so
 * when the task carries no parent yet we first look for an existing top-level
 * feature with the dated name in the same repository and reuse it. Only when no
 * such bucket exists is a fresh one created.
 */
async function resolveParentFeatureId(
  api: PlannerLaunchApi,
  task: PlannerTask,
  repoId: string | null,
  onPhase?: LaunchPhaseReporter,
): Promise<string> {
  if (task.featureId) {
    return task.featureId;
  }
  onPhase?.('Preparing workspace…');
  const name = datedFeatureName(task);
  const targetRepoId = repoId;
  const existing = (await api.listFeatures()).find(
    (feature) =>
      feature.name === name &&
      feature.repoId === targetRepoId &&
      !feature.parentFeatureId &&
      !feature.parentGroupId,
  );
  if (existing) {
    return existing.id;
  }
  const parent = await api.createFeature({
    name,
    description: promptForTask(task),
    repoId: targetRepoId,
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
  onPhase?: LaunchPhaseReporter,
): Promise<WorkspaceLaunchIntent> {
  const parentFeatureId = await resolveParentFeatureId(api, task, repoId, onPhase);
  onPhase?.('Creating task…');
  const feature = await api.createFeature({
    name: featureNameForTask(task),
    description: promptForTask(task),
    repoId: repoId ?? null,
    parentFeatureId,
  });
  onPhase?.('Attaching New Task agent…');
  const attachment = await api.attachAgent(feature.id, NEW_TASK_AGENT_ID);
  const catalog = await api.getAgent(NEW_TASK_AGENT_ID);
  const attached: AttachedAgent = { attachment, manifest: catalog.manifest };
  return { kind: 'agent', feature, attached };
}

/**
 * Creates a feature for the task and an interactive CLI session preloaded with
 * the task text, naming the session after the task. The task prompt is
 * auto-sent the first time the session's terminal is opened, so the CLI starts
 * working on it immediately. Returns an intent that opens that session.
 */
export async function launchSession(
  api: PlannerLaunchApi,
  task: PlannerTask,
  repoId: string | null,
  onPhase?: LaunchPhaseReporter,
): Promise<WorkspaceLaunchIntent> {
  const name = featureNameForTask(task);
  const parentFeatureId = await resolveParentFeatureId(api, task, repoId, onPhase);
  onPhase?.('Creating session…');
  const feature = await api.createFeature({
    name,
    description: promptForTask(task),
    repoId: repoId ?? null,
    parentFeatureId,
  });
  onPhase?.('Starting session…');
  const started = await api.createTerminalSession(feature.id, {
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
  onPhase?: LaunchPhaseReporter,
): Promise<WorkspaceLaunchIntent> {
  if (!repoId) {
    throw new Error('Pick a repository before starting a review.');
  }
  const number = parsePullNumber(task.prUrl || task.title);
  if (number === null) {
    throw new Error('This task has no pull-request number to review.');
  }
  const parentFeatureId = await resolveParentFeatureId(api, task, repoId, onPhase);
  onPhase?.('Importing pull request…');
  const feature = await api.createPrFeature(repoId, number, parentFeatureId);
  return { kind: 'review-board', feature };
}

/**
 * Translates a raw launcher / back-end error into a concise, actionable
 * message. Launches run git against the selected repository's checkout, so the
 * most common failure is a raw `fatal: not a git repository` from an absent or
 * invalid local clone — unhelpful on its own, so it is mapped to concrete
 * guidance. Any other error falls back to its own message.
 */
export function humanizeLaunchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const trimmed = raw.trim();
  if (/not a git repository/i.test(trimmed)) {
    return (
      'The selected repository has no valid local git checkout. Add or re-open ' +
      'its repository in the workspace (or pick a different one) before ' +
      'starting this task.'
    );
  }
  return trimmed.length > 0 ? trimmed : 'Could not launch the task.';
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
