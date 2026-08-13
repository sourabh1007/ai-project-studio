import type { CheckResult, ConditionSpec } from './automation-contract.js';

/**
 * Pure evaluation of a {@link ConditionSpec} against a {@link CheckResult}.
 * Returns whether the monitor's condition is currently satisfied. Kept free of
 * side effects so every branch is exhaustively unit-tested (coverage-gated).
 */
export function evaluateCondition(
  condition: ConditionSpec,
  result: CheckResult,
): boolean {
  switch (condition.type) {
    case 'always':
      return true;
    case 'exit-code':
      return result.code === condition.equals;
    case 'status-equals':
      return result.status === condition.value;
    case 'conclusion-equals':
      return result.conclusion === condition.value;
    case 'text-contains':
      return result.text.includes(condition.value);
    case 'ai-verdict':
      return result.code === 1;
  }
}

/**
 * Decides whether a matched condition should *fire the action this tick*.
 *
 * - **short** monitors fire on the first match.
 * - **long** monitors are edge-triggered: they fire only when the current
 *   occurrence differs from the last one that fired, so a persistently-matching
 *   condition (e.g. a pipeline that stays `completed`) does not re-fire every
 *   poll. When a check reports no occurrence key, every match fires.
 */
export function shouldFire(params: {
  matched: boolean;
  mode: 'short' | 'long';
  occurrenceKey: string | null;
  lastOccurrenceKey: string | null;
}): boolean {
  if (!params.matched) {
    return false;
  }
  if (params.mode === 'short') {
    return true;
  }
  if (params.occurrenceKey === null) {
    return true;
  }
  return params.occurrenceKey !== params.lastOccurrenceKey;
}
