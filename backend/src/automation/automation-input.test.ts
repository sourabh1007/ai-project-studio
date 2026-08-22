import { describe, it, expect } from 'vitest';
import {
  assertCreateAutomationInput,
  assertErrorBody,
  assertPlannedStepsBody,
  assertProgressBody,
  assertRegisterSubagentBody,
  assertResultBody,
} from './automation-input.js';

const base = {
  name: 'Monitor',
  mode: 'long',
  check: { type: 'shell', command: 'echo' },
  condition: { type: 'exit-code', equals: 0 },
  action: { type: 'report', prompt: 'go' },
};

describe('assertCreateAutomationInput', () => {
  it('accepts a minimal valid body and defaults optionals', () => {
    const input = assertCreateAutomationInput(base);
    expect(input.name).toBe('Monitor');
    expect(input.mode).toBe('long');
    expect(input.origin).toBeUndefined();
    expect(input.intervalMs).toBeUndefined();
    expect(input.maxRuns).toBeUndefined();
    expect(input.plannedSteps).toBeUndefined();
  });

  describe('automation control input validators', () => {
    it('accepts string wrapper bodies', () => {
      expect(assertProgressBody({ progress: 'working' })).toBe('working');
      expect(assertResultBody({ result: 'done' })).toBe('done');
      expect(assertErrorBody({ error: 'boom' })).toBe('boom');
    });

    it('rejects invalid string wrapper bodies', () => {
      expect(() => assertProgressBody(null)).toThrow(/body/);
      expect(() => assertProgressBody({ progress: '' })).toThrow(/progress/);
      expect(() => assertResultBody({ result: 1 })).toThrow(/result/);
      expect(() => assertErrorBody({ error: [] })).toThrow(/error/);
    });

    it('accepts planned steps', () => {
      expect(
        assertPlannedStepsBody({
          steps: [
            { id: 'a', label: 'A', status: 'pending', detail: null },
            { id: 'b', label: 'B', status: 'active', detail: 'now' },
            { id: 'c', label: 'C', status: 'done', detail: '' },
            { id: 'd', label: 'D', status: 'skipped', detail: null },
          ],
        }),
      ).toEqual([
        { id: 'a', label: 'A', status: 'pending', detail: null },
        { id: 'b', label: 'B', status: 'active', detail: 'now' },
        { id: 'c', label: 'C', status: 'done', detail: '' },
        { id: 'd', label: 'D', status: 'skipped', detail: null },
      ]);
    });

    it('rejects malformed planned steps', () => {
      expect(() => assertPlannedStepsBody({ steps: 'x' })).toThrow(/array/);
      expect(() => assertPlannedStepsBody({ steps: [null] })).toThrow(/step/);
      expect(() =>
        assertPlannedStepsBody({
          steps: [{ id: '', label: 'A', status: 'pending', detail: null }],
        }),
      ).toThrow(/step.id/);
      expect(() =>
        assertPlannedStepsBody({
          steps: [{ id: 'a', label: '', status: 'pending', detail: null }],
        }),
      ).toThrow(/step.label/);
      expect(() =>
        assertPlannedStepsBody({
          steps: [{ id: 'a', label: 'A', status: 'weird', detail: null }],
        }),
      ).toThrow(/status/);
      expect(() =>
        assertPlannedStepsBody({
          steps: [{ id: 'a', label: 'A', status: 'pending', detail: 1 }],
        }),
      ).toThrow(/detail/);
    });

    it('accepts a register-subagent body and overwrites automation id', () => {
      expect(
        assertRegisterSubagentBody(
          {
            task: 'Investigate',
            origin: { sessionId: 's1', featureId: 'f1' },
            automationId: 'ignored',
          },
          'a1',
        ),
      ).toEqual({
        task: 'Investigate',
        origin: { sessionId: 's1', featureId: 'f1' },
        automationId: 'a1',
      });
    });

    it('rejects malformed register-subagent bodies', () => {
      expect(() => assertRegisterSubagentBody('x', 'a1')).toThrow(/body/);
      expect(() =>
        assertRegisterSubagentBody({ task: '', origin: {} }, 'a1'),
      ).toThrow(/task/);
      expect(() =>
        assertRegisterSubagentBody({ task: 't' }, 'a1'),
      ).toThrow(/origin/);
      expect(() =>
        assertRegisterSubagentBody({ task: 't', origin: { sessionId: 1 } }, 'a1'),
      ).toThrow(/origin.sessionId/);
    });
  });

  it('rejects a non-object body', () => {
    expect(() => assertCreateAutomationInput(null)).toThrow(/must be an object/);
    expect(() => assertCreateAutomationInput([])).toThrow(/must be an object/);
  });

  it('rejects a blank name', () => {
    expect(() => assertCreateAutomationInput({ ...base, name: ' ' })).toThrow(
      /name/,
    );
  });

  it('rejects an unknown mode', () => {
    expect(() => assertCreateAutomationInput({ ...base, mode: 'x' })).toThrow(
      /mode/,
    );
    expect(
      assertCreateAutomationInput({ ...base, mode: 'short' }).mode,
    ).toBe('short');
  });

  describe('check', () => {
    it('validates shell with optional cwd', () => {
      expect(
        assertCreateAutomationInput({
          ...base,
          check: { type: 'shell', command: 'ls', cwd: '/tmp' },
        }).check,
      ).toEqual({ type: 'shell', command: 'ls', cwd: '/tmp' });
    });
    it('validates http with default and explicit method', () => {
      expect(
        assertCreateAutomationInput({
          ...base,
          check: { type: 'http', url: 'http://x' },
        }).check,
      ).toEqual({ type: 'http', url: 'http://x', method: 'GET' });
      expect(
        (
          assertCreateAutomationInput({
            ...base,
            check: { type: 'http', url: 'http://x', method: 'POST' },
          }).check as { method: string }
        ).method,
      ).toBe('POST');
    });
    it('validates ai', () => {
      expect(
        assertCreateAutomationInput({
          ...base,
          check: { type: 'ai', prompt: 'ready?' },
        }).check,
      ).toMatchObject({ type: 'ai', prompt: 'ready?' });
    });
    it('validates ci-pipeline with provider default and azure', () => {
      expect(
        assertCreateAutomationInput({
          ...base,
          check: { type: 'ci-pipeline', repo: 'o/r' },
        }).check,
      ).toMatchObject({ type: 'ci-pipeline', provider: 'github', repo: 'o/r' });
      expect(
        (
          assertCreateAutomationInput({
            ...base,
            check: {
              type: 'ci-pipeline',
              provider: 'azure',
              repo: 'o/p',
              ref: 'main',
              pipeline: '5',
            },
          }).check as { provider: string }
        ).provider,
      ).toBe('azure');
    });
    it('rejects an unknown check type and a bad command', () => {
      expect(() =>
        assertCreateAutomationInput({ ...base, check: { type: 'nope' } }),
      ).toThrow(/Unknown check type/);
      expect(() =>
        assertCreateAutomationInput({
          ...base,
          check: { type: 'shell', command: '' },
        }),
      ).toThrow(/command/);
    });
  });

  describe('condition', () => {
    it('validates every condition type', () => {
      const kinds = [
        { type: 'always' },
        { type: 'exit-code', equals: 1 },
        { type: 'status-equals', value: 'completed' },
        { type: 'conclusion-equals', value: 'success' },
        { type: 'text-contains', value: 'err' },
        { type: 'ai-verdict' },
      ];
      for (const condition of kinds) {
        expect(
          assertCreateAutomationInput({ ...base, condition }).condition,
        ).toEqual(condition);
      }
    });
    it('rejects a non-numeric exit-code and unknown type', () => {
      expect(() =>
        assertCreateAutomationInput({
          ...base,
          condition: { type: 'exit-code', equals: 'x' },
        }),
      ).toThrow(/number/);
      expect(() =>
        assertCreateAutomationInput({ ...base, condition: { type: 'nope' } }),
      ).toThrow(/Unknown condition type/);
    });
  });

  describe('action', () => {
    it('validates every action type', () => {
      expect(
        assertCreateAutomationInput({
          ...base,
          action: { type: 'metasession', prompt: 'p' },
        }).action,
      ).toMatchObject({ type: 'metasession' });
      expect(
        assertCreateAutomationInput({
          ...base,
          action: { type: 'subagent', task: 't', prompt: 'p' },
        }).action,
      ).toMatchObject({ type: 'subagent', task: 't' });
      expect(
        assertCreateAutomationInput({
          ...base,
          action: { type: 'command', command: 'c' },
        }).action,
      ).toMatchObject({ type: 'command', command: 'c' });
    });
    it('rejects an unknown action type', () => {
      expect(() =>
        assertCreateAutomationInput({ ...base, action: { type: 'nope' } }),
      ).toThrow(/Unknown action type/);
    });
  });

  describe('intervalMs', () => {
    it('accepts a positive number', () => {
      expect(
        assertCreateAutomationInput({ ...base, intervalMs: 30_000 }).intervalMs,
      ).toBe(30_000);
    });
    it('rejects a non-positive or non-numeric interval', () => {
      expect(() =>
        assertCreateAutomationInput({ ...base, intervalMs: 0 }),
      ).toThrow(/intervalMs/);
      expect(() =>
        assertCreateAutomationInput({ ...base, intervalMs: 'x' }),
      ).toThrow(/intervalMs/);
    });
  });

  describe('maxRuns', () => {
    it('accepts a positive integer, null, and undefined', () => {
      expect(
        assertCreateAutomationInput({ ...base, maxRuns: 3 }).maxRuns,
      ).toBe(3);
      expect(
        assertCreateAutomationInput({ ...base, maxRuns: null }).maxRuns,
      ).toBeNull();
      expect(assertCreateAutomationInput(base).maxRuns).toBeUndefined();
    });
    it('rejects a non-positive or fractional maxRuns', () => {
      expect(() =>
        assertCreateAutomationInput({ ...base, maxRuns: 0 }),
      ).toThrow(/maxRuns/);
      expect(() =>
        assertCreateAutomationInput({ ...base, maxRuns: 1.5 }),
      ).toThrow(/maxRuns/);
    });
  });

  describe('plannedSteps', () => {
    it('accepts planned steps during monitor creation', () => {
      const steps = [
        { id: 's1', label: 'Check build', status: 'pending' as const, detail: null },
      ];
      expect(
        assertCreateAutomationInput({ ...base, plannedSteps: steps })
          .plannedSteps,
      ).toEqual(steps);
    });
    it('rejects a malformed plannedSteps value', () => {
      expect(() =>
        assertCreateAutomationInput({ ...base, plannedSteps: 'x' }),
      ).toThrow(/plannedSteps/);
    });
  });

  describe('origin', () => {
    it('accepts a full origin', () => {
      expect(
        assertCreateAutomationInput({
          ...base,
          origin: { sessionId: 's1', featureId: 'f1' },
        }).origin,
      ).toEqual({ sessionId: 's1', featureId: 'f1' });
    });
    it('defaults missing origin fields to null', () => {
      expect(
        assertCreateAutomationInput({ ...base, origin: {} }).origin,
      ).toEqual({ sessionId: null, featureId: null });
    });
    it('rejects a non-object origin', () => {
      expect(() =>
        assertCreateAutomationInput({ ...base, origin: 'x' }),
      ).toThrow(/origin/);
    });
  });
});
