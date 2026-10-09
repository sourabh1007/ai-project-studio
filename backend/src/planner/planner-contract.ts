/**
 * Contracts for the Planner — a standalone, dated task checklist independent of
 * the workspace feature tree. Each task carries a priority and an editable date
 * (freely backdatable) and can be launched into a New Task plan, a Review Board
 * (for PR tasks), or a plain session.
 */

/** Priority buckets, highest (`p0`) to lowest (`p3`). */
export type PlannerPriority = 'p0' | 'p1' | 'p2' | 'p3';

/** Whether a task is still open or has been checked off. */
export type PlannerTaskStatus = 'open' | 'done';

/**
 * A task's nature. `pr` tasks carry a pull-request URL and can be launched into
 * the Review Board; `task` tasks are generic work items.
 */
export type PlannerTaskKind = 'task' | 'pr';

/**
 * What a task was launched into, so the Planner can re-open it later (and
 * re-create it if the underlying feature/session was deleted):
 * - `session` — a plain CLI session (tracked by `sessionId` + `featureId`);
 * - `agent` — the New Task planning agent attached to `featureId`;
 * - `review` — a PR imported into the Review Board under `featureId`.
 */
export type PlannerLaunchKind = 'session' | 'agent' | 'review';

export interface PlannerTask {
  id: string;
  title: string;
  /** Free-form notes/description shown under the title. */
  notes: string;
  priority: PlannerPriority;
  status: PlannerTaskStatus;
  kind: PlannerTaskKind;
  /** Pull-request URL for `pr` tasks; empty for generic tasks. */
  prUrl: string;
  /**
   * The task's date as a `YYYY-MM-DD` calendar day. Defaults to today on the
   * client but is freely editable, including to past dates.
   */
  date: string;
  /** Repository the task's launches target; `null` when none was chosen. */
  repoId: string | null;
  /** What the task was launched into, or `null` if it hasn't been launched. */
  launchKind: PlannerLaunchKind | null;
  /** The workspace feature created for the launch, if any. */
  featureId: string | null;
  /** The session created for a `session` launch, if any. */
  sessionId: string | null;
  /** Editable display name of the launched session/feature. */
  launchLabel: string | null;
  /**
   * When set to a `YYYY-MM-DD` day, the task has been deferred to the backlog
   * and is hidden from the day view until restored. The value records the day
   * it was moved to the backlog. `null` for an active (non-backlogged) task.
   */
  backloggedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlannerTaskInput {
  title: string;
  notes?: string;
  priority?: PlannerPriority;
  kind?: PlannerTaskKind;
  prUrl?: string;
  /** `YYYY-MM-DD`; defaults to the server's current day when omitted. */
  date?: string;
  /** Repository the task's launches should target. */
  repoId?: string | null;
}

export interface UpdatePlannerTaskInput {
  title?: string;
  notes?: string;
  priority?: PlannerPriority;
  kind?: PlannerTaskKind;
  prUrl?: string;
  date?: string;
  status?: PlannerTaskStatus;
  repoId?: string | null;
  launchKind?: PlannerLaunchKind | null;
  featureId?: string | null;
  sessionId?: string | null;
  launchLabel?: string | null;
  /** `YYYY-MM-DD` to defer the task to the backlog, or `null` to restore it. */
  backloggedAt?: string | null;
}
