import { ApiError, type ApiClient, type OperationOptions } from './api';
import { isDefiniteRejection as isDefiniteKeyRejection, KEY_RESET_WARNING, releaseAfterOutcome, type OperationKeyStore } from './operation-keys';
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
  | 'listSessions'
  | 'listFeatureAgents'
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

/**
 * Records what a launch has already created so a user-initiated retry of the
 * same launch resumes after those records instead of creating duplicates. The
 * caller scopes it to one task/intent attempt; it holds no provider state.
 */
export interface LaunchRetention {
  feature?: Feature;
  session?: Session;
  attachment?: AttachedAgent['attachment'];
  /**
   * The create request marked before it was sent and not yet known to have
   * failed definitively. `answered` means the server replied (so the request is
   * no longer in flight); otherwise the request may still commit.
   */
  attempt?: { op: LaunchOperation; answered: boolean };
  /**
   * Durable operation keys for this intent. When present every create carries
   * its stage's key, so a retry (even after a full reload) is answered by the
   * backend with the original result and never needs reconciling.
   */
  keys?: LaunchKeys;
}

/** The durable keys of one launch intent, one per create stage. */
export interface LaunchKeys {
  keyFor(op: LaunchOperation | 'parent'): string;
  /** Forgets a stage's key once the backend says it belonged to different input. */
  discard(op: LaunchOperation | 'parent'): void;
  /** Forgets the intent's keys once the whole launch has completed. */
  release(): void;
}

/** Binds a durable key store to one task/intent/repository/content fingerprint. */
export function launchKeysFor(
  store: OperationKeyStore,
  task: PlannerTask,
  intent: string,
  repoId: string | null,
): LaunchKeys {
  const content = [intent, repoId ?? '', task.title, task.notes].join('\u0000');
  return {
    keyFor: (op) => store.keyFor(task.id, content, op),
    discard: (op) => store.discard(task.id, content, op),
    release: () => store.release(task.id, content),
  };
}

/** True when the backend refused to repeat an operation whose outcome is still unknown. */
export function isOperationPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'operation_pending';
}

function isOperationKeyConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'operation_key_conflict';
}

export type LaunchOperation = 'feature' | 'session' | 'attachment';

/**
 * Thrown instead of repeating a create request whose outcome is unknown and
 * cannot be reconciled unambiguously. Retrying automatically could duplicate
 * the feature, session or attachment, so the user must check first.
 */
export class UnknownLaunchOutcomeError extends Error {
  constructor(readonly op: LaunchOperation, message: string) {
    super(message);
    this.name = 'UnknownLaunchOutcomeError';
  }
}

const OPERATION_NOUN: Record<LaunchOperation, string> = {
  feature: 'task workspace',
  session: 'session',
  attachment: 'New Task agent',
};

/** A 4xx other than 408 means the server rejected the request before creating anything. */
function isDefiniteRejection(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  );
}

/**
 * Runs one create request, marking it as attempted first. A definite rejection
 * clears the mark so a retry may repeat it; any other failure leaves the mark so
 * the next launch reconciles before creating again.
 */
async function attempt<T>(
  keep: LaunchRetention,
  op: LaunchOperation,
  request: (operation?: OperationOptions) => Promise<T>,
): Promise<T> {
  const operationKey = keep.keys?.keyFor(op);
  const operation = operationKey === undefined ? undefined : { operationKey };
  keep.attempt = { op, answered: false };
  try {
    const result = await request(operation);
    keep.attempt = undefined;
    return result;
  } catch (error) {
    if (operation !== undefined) {
      // The same key replays or refuses a repeat, so nothing needs reconciling.
      keep.attempt = undefined;
      if (isOperationKeyConflict(error) || isDefiniteKeyRejection(error)) releaseAfterOutcome(() => keep.keys?.discard(op), KEY_RESET_WARNING);
      throw error;
    }
    keep.attempt =
      isDefiniteRejection(error)
        ? undefined
        : { op, answered: error instanceof ApiError };
    throw error;
  }
}

function unknownOutcome(op: LaunchOperation, detail: string): UnknownLaunchOutcomeError {
  return new UnknownLaunchOutcomeError(
    op,
    `The ${OPERATION_NOUN[op]} may already have been created, but the result was not received (${detail}). ` +
      'Check the workspace for it before launching again; editing the task or reloading the planner starts a new launch.',
  );
}

/**
 * Resolves an unknown create outcome from the server before any create is
 * repeated. Only the feature this launch created is inspected, so a match is
 * unambiguous; anything else stays blocked with guidance.
 */
async function reconcile(
  api: PlannerLaunchApi,
  task: PlannerTask,
  keep: LaunchRetention,
): Promise<void> {
  const pending = keep.attempt;
  if (!pending) {
    return;
  }
  const { op, answered } = pending;
  const feature = keep.feature;
  if (op === 'feature' || !feature) {
    throw unknownOutcome(op, 'no identifier to look it up');
  }
  if (op === 'session') {
    const sessions = await api.listSessions(feature.id, { includeInternal: true });
    if (sessions.length === 1 && sessions[0].prompt === promptForTask(task)) {
      keep.session = sessions[0];
    } else if (sessions.length > 0 || !answered) {
      throw unknownOutcome(op, `${sessions.length} found, could not match`);
    }
  } else {
    const agents = (await api.listFeatureAgents(feature.id)).filter(
      (candidate) => candidate.attachment.agentId === NEW_TASK_AGENT_ID,
    );
    if (agents.length === 1) {
      keep.attachment = agents[0].attachment;
    } else if (agents.length > 1 || !answered) {
      throw unknownOutcome(op, `${agents.length} found, could not match`);
    }
  }
  keep.attempt = undefined;
}

/** Thrown when a launched task's target is known to no longer exist. */
export class MissingLaunchTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingLaunchTargetError';
  }
}

/** True only for proven-missing targets (HTTP 404 or an explicit missing link). */
export function isMissingLaunchTarget(error: unknown): boolean {
  return (
    error instanceof MissingLaunchTargetError ||
    (error instanceof ApiError && error.status === 404)
  );
}

/** How many retained launch records one backend connection may hold. */
export const MAX_RETAINED_LAUNCHES = 8;

/** What every mounted planner sees about the launch in progress. */
export interface LaunchSnapshot {
  active: { taskId: string; phase: string } | null;
  error: string | null;
  /** Increments each time a launch ends so mounted views refresh task links. */
  completions: number;
}

/**
 * Launch ownership that outlives any one planner view: the single launch slot,
 * the retained identity of unfinished launches, and the last launch error.
 * It is keyed by API client (see `launchRegistryFor`), so a view that is
 * unmounted and remounted mid-launch sees the same slot and records.
 */
export interface LaunchRegistry {
  readonly retained: Map<string, LaunchRetention>;
  getSnapshot(): LaunchSnapshot;
  subscribe(listener: () => void): () => void;
}

interface LaunchRegistryInternal extends LaunchRegistry {
  snapshot: LaunchSnapshot;
  listeners: Set<() => void>;
}

const registries = new WeakMap<object, LaunchRegistryInternal>();

/** Returns the registry for one API client, creating it on first use. */
export function launchRegistryFor(owner: object): LaunchRegistry {
  let registry = registries.get(owner);
  if (!registry) {
    const created: LaunchRegistryInternal = {
      retained: new Map(),
      snapshot: { active: null, error: null, completions: 0 },
      listeners: new Set(),
      getSnapshot: () => created.snapshot,
      subscribe(listener) {
        created.listeners.add(listener);
        return () => created.listeners.delete(listener);
      },
    };
    registry = created;
    registries.set(owner, registry);
  }
  return registry;
}

function publish(registry: LaunchRegistry, patch: Partial<LaunchSnapshot>): void {
  const internal = registry as LaunchRegistryInternal;
  internal.snapshot = { ...internal.snapshot, ...patch };
  internal.listeners.forEach((listener) => listener());
}

/** Takes the single launch slot; false when any launch is already running. */
export function claimLaunchSlot(registry: LaunchRegistry, taskId: string): boolean {
  if (registry.getSnapshot().active) {
    return false;
  }
  publish(registry, { active: { taskId, phase: '' }, error: null });
  return true;
}

/** Reports the running launch's phase to every mounted view. */
export function setLaunchPhase(registry: LaunchRegistry, phase: string): void {
  const active = registry.getSnapshot().active;
  if (active) {
    publish(registry, { active: { ...active, phase } });
  }
}

/** Records the launch error shown to whichever view is mounted. */
export function setLaunchError(registry: LaunchRegistry, error: string | null): void {
  publish(registry, { error });
}

/** Frees the launch slot and tells mounted views to refresh task links. */
export function releaseLaunchSlot(registry: LaunchRegistry): void {
  publish(registry, {
    active: null,
    completions: registry.getSnapshot().completions + 1,
  });
}

/**
 * Finds or starts the retained record for one task/intent/input fingerprint.
 * Changing a task's input drops its older records; records whose create outcome
 * is unknown are never evicted for space, so `null` means the registry is full
 * of unresolved launches and the caller must not start another.
 */
export function acquireRetention(
  registry: LaunchRegistry,
  task: PlannerTask,
  intent: string,
  repoId: string | null,
): { key: string; keep: LaunchRetention } | null {
  const key = [task.id, intent, repoId ?? '', task.title, task.notes].join('\u0000');
  const { retained } = registry;
  const existing = retained.get(key);
  if (existing) {
    return { key, keep: existing };
  }
  for (const other of [...retained.keys()]) {
    if (other.startsWith(`${task.id}\u0000`)) {
      retained.delete(other);
    }
  }
  for (const [other, record] of retained) {
    if (retained.size < MAX_RETAINED_LAUNCHES) {
      break;
    }
    if (!record.attempt) {
      retained.delete(other);
    }
  }
  if (retained.size >= MAX_RETAINED_LAUNCHES) {
    return null;
  }
  const keep: LaunchRetention = {};
  retained.set(key, keep);
  return { key, keep };
}

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
  keys?: LaunchKeys,
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
  const input = { name, description: promptForTask(task), repoId: targetRepoId };
  const operationKey = keys?.keyFor('parent');
  try {
    const parent = await (operationKey === undefined
      ? api.createFeature(input)
      : api.createFeature(input, { operationKey }));
    return parent.id;
  } catch (error) {
    if (isOperationKeyConflict(error) || isDefiniteKeyRejection(error)) releaseAfterOutcome(() => keys?.discard('parent'), KEY_RESET_WARNING);
    throw error;
  }
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
  retained?: LaunchRetention,
): Promise<WorkspaceLaunchIntent> {
  const keep = retained ?? {};
  await reconcile(api, task, keep);
  if (!keep.feature) {
    const parentFeatureId = await resolveParentFeatureId(api, task, repoId, onPhase, keep.keys);
    onPhase?.('Creating task…');
    keep.feature = await attempt(keep, 'feature', (operation) => {
        const input = {
          name: featureNameForTask(task),
          description: promptForTask(task),
          repoId: repoId ?? null,
          parentFeatureId,
        };
        return operation ? api.createFeature(input, operation) : api.createFeature(input);
      },
    );
  }
  const feature = keep.feature;
  onPhase?.('Attaching New Task agent…');
  if (!keep.attachment) {
    const created = feature;
    keep.attachment = await attempt(keep, 'attachment', (operation) => operation
        ? api.attachAgent(created.id, NEW_TASK_AGENT_ID, operation)
        : api.attachAgent(created.id, NEW_TASK_AGENT_ID),
    );
  }
  const attachment = keep.attachment;
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
  retained?: LaunchRetention,
): Promise<WorkspaceLaunchIntent> {
  const name = featureNameForTask(task);
  const keep = retained ?? {};
  await reconcile(api, task, keep);
  if (!keep.feature) {
    const parentFeatureId = await resolveParentFeatureId(api, task, repoId, onPhase, keep.keys);
    onPhase?.('Creating session…');
    keep.feature = await attempt(keep, 'feature', (operation) => {
        const input = {
          name,
          description: promptForTask(task),
          repoId: repoId ?? null,
          parentFeatureId,
        };
        return operation ? api.createFeature(input, operation) : api.createFeature(input);
      },
    );
  }
  const feature = keep.feature;
  if (!keep.session) {
    onPhase?.('Starting session…');
    keep.session = await attempt(keep, 'session', (operation) => {
        const input = { prompt: promptForTask(task) };
        return operation
          ? api.createTerminalSession(feature.id, input, operation)
          : api.createTerminalSession(feature.id, input);
      },
    );
  }
  const started = keep.session;
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
      throw new MissingLaunchTargetError('This task has no session to open.');
    }
    const session = await api.getSession(task.sessionId);
    return {
      kind: 'session',
      session,
      label: task.launchLabel ?? session.featureId,
    };
  }
  if (!task.featureId) {
    throw new MissingLaunchTargetError('This task has nothing to open.');
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
    throw new MissingLaunchTargetError('The planning agent is no longer attached.');
  }
  return { kind: 'agent', feature, attached };
}
