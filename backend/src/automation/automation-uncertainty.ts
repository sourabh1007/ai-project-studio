import type {
  Automation,
  AutomationRun,
  AutomationUncertainty,
} from './automation-contract.js';

function isResolvedByLaterSuccess(
  run: AutomationRun,
  runs: readonly AutomationRun[],
): boolean {
  if (run.occurrenceKey === null) {
    return false;
  }
  return runs.some(
    (candidate) =>
      candidate.phase === 'finished' &&
      candidate.triggered &&
      candidate.status === 'ok' &&
      candidate.occurrenceKey === run.occurrenceKey &&
      candidate.id !== run.id &&
      candidate.startedAt >= run.startedAt,
  );
}

export function pendingUncertainRuns(
  runs: readonly AutomationRun[],
): AutomationRun[] {
  return runs.filter(
    (run) =>
      run.phase === 'uncertain' &&
      run.triggered &&
      run.resolvedByRunId == null &&
      !isResolvedByLaterSuccess(run, runs),
  );
}

function summarizeKnownOccurrences(runs: readonly AutomationRun[]): string {
  const sample = [...new Set(runs.map((run) => run.occurrenceKey).filter(Boolean))]
    .slice(0, 2)
    .join(', ');
  return runs.length === 1
    ? `A previous action may already have executed for occurrence "${runs[0]!.occurrenceKey}".`
    : `Previous actions may already have executed for ${runs.length} unresolved occurrences${sample ? ` (${sample})` : ''}.`;
}

export function summarizeAutomationUncertainty(
  runs: readonly AutomationRun[],
): AutomationUncertainty | null {
  const pending = pendingUncertainRuns(runs);
  if (pending.length === 0) {
    return null;
  }
  const unknownCount = pending.filter((run) => run.occurrenceKey === null).length;
  const summary =
    unknownCount > 0
      ? pending.length === 1
        ? 'A previous action may already have executed, and its occurrence identity is unknown. Automatic retries stay blocked until you explicitly confirm a retry.'
        : `Previous actions may already have executed for ${pending.length} unresolved attempts, including at least one with an unknown occurrence identity. Automatic retries stay blocked until you explicitly confirm a retry.`
      : `${summarizeKnownOccurrences(pending)} Automatic retries stay blocked until you explicitly confirm a retry.`;
  return {
    summary,
    unresolvedRunIds: pending.map((run) => run.id),
  };
}

export function decorateAutomationWithUncertainty(
  automation: Automation,
  runs: readonly AutomationRun[],
): Automation {
  const uncertainty = summarizeAutomationUncertainty(runs);
  if (uncertainty === null) {
    if (automation.uncertainty === undefined) {
      return automation;
    }
    const { uncertainty: _ignored, ...rest } = automation;
    return rest;
  }
  return {
    ...automation,
    uncertainty,
  };
}
