import type {
  Automation,
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
  active: Automation[];
  finished: Automation[];
}

/**
 * Splits monitors into the still-running group (active/paused) and the terminal
 * group (completed/failed/cancelled), each sorted newest-updated first.
 */
export function groupAutomations(list: Automation[]): AutomationGroups {
  const active: Automation[] = [];
  const finished: Automation[] = [];
  for (const automation of list) {
    if (isActiveStatus(automation.status)) {
      active.push(automation);
    } else {
      finished.push(automation);
    }
  }
  return {
    active: sortByUpdatedDesc(active),
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
