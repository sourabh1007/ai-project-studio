import type {
  Automation,
  AutomationRun,
  AutomationStatus,
  Subagent,
} from './types.js';

/**
 * Pure grouping and derived-state helpers for the Automations view. Kept free of
 * React and IO so every branch is exhaustively unit-tested (coverage-gated).
 */

/** Whether a monitor is still doing work (schedulable) vs. terminal. */
export function isActiveStatus(status: AutomationStatus): boolean {
  return (
    status === 'active' || status === 'paused' || status === 'needs-auth'
  );
}

/**
 * The visual motion state that drives a monitor's status indicator: `running`
 * pulses, `paused` is held steady, `stopped` is dimmed. Awaiting sign-in counts
 * as paused (it is not actively polling).
 */
export function monitorMotion(
  status: AutomationStatus,
): 'running' | 'paused' | 'stopped' {
  if (status === 'active') {
    return 'running';
  }
  if (status === 'paused' || status === 'needs-auth') {
    return 'paused';
  }
  return 'stopped';
}

/** A human label for a monitor's lifecycle status. */
export function statusLabel(status: AutomationStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'paused':
      return 'Paused';
    case 'needs-auth':
      return 'Sign-in required';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** A short badge label for a monitor's mode. */
export function modeLabel(mode: Automation['mode']): string {
  return mode === 'short' ? 'One-time monitor' : 'Continuous monitor';
}

/** A human label for a subagent's status. */
export function subagentStatusLabel(status: Subagent['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
  }
}

export interface AutomationGroups {
  /** Actively polling monitors (status `active`). */
  running: Automation[];
  /** Manually paused monitors (status `paused`). */
  paused: Automation[];
  /** Monitors parked awaiting the user to authenticate (status `needs-auth`). */
  attention: Automation[];
  /** Terminal monitors (completed/failed/cancelled). */
  finished: Automation[];
}

/**
 * Segregates monitors into clearly-labelled lifecycle buckets so the page never
 * lumps running and stopped monitors under one heading. Each bucket is sorted
 * newest-updated first.
 */
export function groupAutomations(list: Automation[]): AutomationGroups {
  const running: Automation[] = [];
  const paused: Automation[] = [];
  const attention: Automation[] = [];
  const finished: Automation[] = [];
  for (const automation of list) {
    switch (automation.status) {
      case 'active':
        running.push(automation);
        break;
      case 'paused':
        paused.push(automation);
        break;
      case 'needs-auth':
        attention.push(automation);
        break;
      default:
        finished.push(automation);
        break;
    }
  }
  return {
    running: sortByUpdatedDesc(running),
    paused: sortByUpdatedDesc(paused),
    attention: sortByUpdatedDesc(attention),
    finished: sortByUpdatedDesc(finished),
  };
}

function sortByUpdatedDesc<T extends { updatedAt: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Subagents sorted newest-updated first. */
export function sortSubagents(list: Subagent[]): Subagent[] {
  return sortByUpdatedDesc(list);
}

/**
 * A short one-line summary of a monitor's check target for card display, without
 * leaking the full spec. Falls back to the check type when nothing is set.
 */
export function describeCheck(check: Automation['check']): string {
  switch (check.type) {
    case 'shell':
      if (typeof check.command !== 'string' || !check.command) {
        return 'Shell check';
      }
      return /\bpowershell(?:\.exe)?\b/i.test(check.command)
        ? 'Shell check · PowerShell'
        : 'Shell check';
    case 'http':
      return typeof check.url === 'string' && check.url
        ? check.url
        : 'HTTP endpoint';
    case 'ai':
      return typeof check.prompt === 'string' && check.prompt
        ? check.prompt
        : 'AI check';
    case 'ci-pipeline':
      return typeof check.repo === 'string' && check.repo
        ? `CI · ${check.repo}`
        : 'CI pipeline';
    default:
      return check.type;
  }
}

/** A human interval label for monitor cards. */
export function intervalLabel(intervalMs: number): string {
  const seconds = Math.max(1, Math.round(intervalMs / 1000));
  if (seconds < 60) {
    return seconds === 1 ? 'Every 1 second' : `Every ${seconds} seconds`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? 'Every 1 minute' : `Every ${minutes} minutes`;
  }
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'Every 1 hour' : `Every ${hours} hours`;
}

/**
 * A countdown label for when a monitor next runs, given "now". Returns null when
 * there is no scheduled next run (paused/terminal/no timestamp).
 */
export function nextRunLabel(
  automation: Automation,
  nowMs: number,
): string | null {
  if (!automation.nextRunAt) {
    return null;
  }
  const nextMs = Date.parse(automation.nextRunAt);
  if (Number.isNaN(nextMs)) {
    return null;
  }
  const deltaMs = nextMs - nowMs;
  if (deltaMs <= 0) {
    return 'due now';
  }
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) {
    return `in ${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  return `in ${hours}h`;
}

/** A run-count label, respecting an optional cap. */
export function runCountLabel(automation: Automation): string {
  if (automation.maxRuns !== null) {
    return `${automation.runCount}/${automation.maxRuns} triggers`;
  }
  return automation.runCount === 1
    ? '1 trigger'
    : `${automation.runCount} triggers`;
}

/** The origin label for a card: feature, session, or Studio-level monitor. */
export function originLabel(origin: Automation['origin']): string {
  if (origin.featureId) {
    return `Feature ${origin.featureId}`;
  }
  if (origin.sessionId) {
    return `Session ${origin.sessionId}`;
  }
  return 'Studio monitor';
}

/** Whether a monitor can be paused (only while active). */
export function canPause(status: AutomationStatus): boolean {
  return status === 'active';
}

/** Whether a monitor can be resumed (while paused or awaiting sign-in). */
export function canResume(status: AutomationStatus): boolean {
  return status === 'paused' || status === 'needs-auth';
}

/** Whether a monitor is parked awaiting the user to authenticate. */
export function needsAuth(status: AutomationStatus): boolean {
  return status === 'needs-auth';
}

/** Whether a monitor can be cancelled (while still non-terminal). */
export function canCancel(status: AutomationStatus): boolean {
  return isActiveStatus(status);
}

/**
 * Completion percentage (0–100) for a capped monitor, from triggers fired vs.
 * the cap. Returns null for uncapped monitors (no meaningful denominator).
 */
export function progressPercent(automation: Automation): number | null {
  if (automation.maxRuns === null || automation.maxRuns <= 0) {
    return null;
  }
  const ratio = automation.runCount / automation.maxRuns;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

/** Formats a millisecond duration into a compact human label (e.g. `1h 5m`). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * An estimated "time to finish" label for a capped, still-running monitor, based
 * on the remaining triggers times the poll interval. Returns null when the
 * monitor is uncapped, already at its cap, or terminal.
 */
export function etaLabel(automation: Automation): string | null {
  if (automation.maxRuns === null || automation.status !== 'active') {
    return null;
  }
  const remaining = automation.maxRuns - automation.runCount;
  if (remaining <= 0) {
    return null;
  }
  return `~${formatDuration(remaining * automation.intervalMs)} left`;
}

/**
 * The label of the currently-active planned step ("what call it is making"),
 * or null when no step is active.
 */
export function activeStepLabel(automation: Automation): string | null {
  const active = automation.plannedSteps.find(
    (step) => step.status === 'active',
  );
  return active ? active.label : null;
}

/** A curated set of selectable poll frequencies for the frequency picker. */
export interface IntervalOption {
  label: string;
  ms: number;
}

export const intervalOptions: readonly IntervalOption[] = [
  { label: 'Every 30 seconds', ms: 30_000 },
  { label: 'Every 1 minute', ms: 60_000 },
  { label: 'Every 2 minutes', ms: 120_000 },
  { label: 'Every 5 minutes', ms: 300_000 },
  { label: 'Every 10 minutes', ms: 600_000 },
  { label: 'Every 15 minutes', ms: 900_000 },
  { label: 'Every 30 minutes', ms: 1_800_000 },
  { label: 'Every 1 hour', ms: 3_600_000 },
];

/**
 * Snaps an arbitrary interval to the nearest preset option so the frequency
 * `<select>` always has a matching value to show.
 */
export function snapIntervalMs(intervalMs: number): number {
  let best = intervalOptions[0];
  for (const option of intervalOptions) {
    if (
      Math.abs(option.ms - intervalMs) < Math.abs(best.ms - intervalMs)
    ) {
      best = option;
    }
  }
  return best.ms;
}

/** A human label for one detailed-log run outcome. */
export function runStatusLabel(status: AutomationRun['status']): string {
  switch (status) {
    case 'ok':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
  }
}

/** A one-line summary of a single run for the detailed-log timeline. */
export function runSummary(run: AutomationRun): string {
  const outcome = run.triggered ? 'Triggered' : 'Checked';
  return run.detail ? `${outcome} · ${run.detail}` : outcome;
}
