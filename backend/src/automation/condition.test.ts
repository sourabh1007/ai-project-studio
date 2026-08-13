import { describe, it, expect } from 'vitest';
import { evaluateCondition, shouldFire } from './condition.js';
import type { CheckResult } from './automation-contract.js';

function result(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    code: null,
    status: null,
    conclusion: null,
    text: '',
    occurrenceKey: null,
    ...overrides,
  };
}

describe('evaluateCondition', () => {
  it('always matches', () => {
    expect(evaluateCondition({ type: 'always' }, result())).toBe(true);
  });

  it('matches exit code', () => {
    expect(
      evaluateCondition({ type: 'exit-code', equals: 0 }, result({ code: 0 })),
    ).toBe(true);
    expect(
      evaluateCondition({ type: 'exit-code', equals: 0 }, result({ code: 1 })),
    ).toBe(false);
  });

  it('matches status equality', () => {
    expect(
      evaluateCondition(
        { type: 'status-equals', value: 'completed' },
        result({ status: 'completed' }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { type: 'status-equals', value: 'completed' },
        result({ status: 'in_progress' }),
      ),
    ).toBe(false);
  });

  it('matches conclusion equality', () => {
    expect(
      evaluateCondition(
        { type: 'conclusion-equals', value: 'success' },
        result({ conclusion: 'success' }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { type: 'conclusion-equals', value: 'success' },
        result({ conclusion: 'failure' }),
      ),
    ).toBe(false);
  });

  it('matches text contains', () => {
    expect(
      evaluateCondition(
        { type: 'text-contains', value: 'error' },
        result({ text: 'an error occurred' }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { type: 'text-contains', value: 'error' },
        result({ text: 'all good' }),
      ),
    ).toBe(false);
  });

  it('matches ai verdict when code is 1', () => {
    expect(evaluateCondition({ type: 'ai-verdict' }, result({ code: 1 }))).toBe(
      true,
    );
    expect(evaluateCondition({ type: 'ai-verdict' }, result({ code: 0 }))).toBe(
      false,
    );
  });
});

describe('shouldFire', () => {
  it('never fires when the condition did not match', () => {
    expect(
      shouldFire({
        matched: false,
        mode: 'long',
        occurrenceKey: 'x',
        lastOccurrenceKey: null,
      }),
    ).toBe(false);
  });

  it('fires short monitors on any match', () => {
    expect(
      shouldFire({
        matched: true,
        mode: 'short',
        occurrenceKey: 'x',
        lastOccurrenceKey: 'x',
      }),
    ).toBe(true);
  });

  it('fires long monitors with no occurrence key on every match', () => {
    expect(
      shouldFire({
        matched: true,
        mode: 'long',
        occurrenceKey: null,
        lastOccurrenceKey: null,
      }),
    ).toBe(true);
  });

  it('fires long monitors only on a new occurrence (edge-triggered)', () => {
    expect(
      shouldFire({
        matched: true,
        mode: 'long',
        occurrenceKey: 'run-2',
        lastOccurrenceKey: 'run-1',
      }),
    ).toBe(true);
    expect(
      shouldFire({
        matched: true,
        mode: 'long',
        occurrenceKey: 'run-1',
        lastOccurrenceKey: 'run-1',
      }),
    ).toBe(false);
  });
});
