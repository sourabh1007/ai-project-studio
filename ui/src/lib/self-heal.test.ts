import { describe, expect, it } from 'vitest';
import {
  INITIAL_SELF_HEAL_STATE,
  deriveSelfHealUi,
  isGhMissingError,
  reduceSelfHeal,
  type SelfHealState,
} from './self-heal.js';

describe('reduceSelfHeal', () => {
  it('applies a phase event', () => {
    const next = reduceSelfHeal(INITIAL_SELF_HEAL_STATE, {
      kind: 'phase',
      phase: 'healing',
    });
    expect(next.phase).toBe('healing');
  });

  it('appends log lines in order', () => {
    let state = INITIAL_SELF_HEAL_STATE;
    state = reduceSelfHeal(state, { kind: 'log', line: 'a' });
    state = reduceSelfHeal(state, { kind: 'log', line: 'b' });
    expect(state.logs).toEqual(['a', 'b']);
  });

  it('records a successful done event', () => {
    const next = reduceSelfHeal(INITIAL_SELF_HEAL_STATE, {
      kind: 'done',
      healed: true,
      message: 'ok',
    });
    expect(next).toMatchObject({ phase: 'done', healed: true, message: 'ok' });
  });

  it('records an error event', () => {
    const next = reduceSelfHeal(
      { ...INITIAL_SELF_HEAL_STATE, healed: true },
      { kind: 'error', message: 'boom' },
    );
    expect(next).toMatchObject({ phase: 'error', healed: false, message: 'boom' });
  });

  it('ignores an unknown event kind', () => {
    const weird = { kind: 'nope' } as unknown as Parameters<
      typeof reduceSelfHeal
    >[1];
    expect(reduceSelfHeal(INITIAL_SELF_HEAL_STATE, weird)).toBe(
      INITIAL_SELF_HEAL_STATE,
    );
  });
});

describe('deriveSelfHealUi', () => {
  const at = (phase: SelfHealState['phase'], over: Partial<SelfHealState> = {}) =>
    deriveSelfHealUi({ ...INITIAL_SELF_HEAL_STATE, phase, ...over });

  it('is pending when idle', () => {
    expect(at('idle')).toEqual({
      status: 'pending',
      headline: 'Ready to fix',
      busy: false,
    });
  });

  it('is running and busy while checking', () => {
    expect(at('checking')).toEqual({
      status: 'running',
      headline: 'Checking…',
      busy: true,
    });
  });

  it('is running and busy while healing', () => {
    expect(at('healing').busy).toBe(true);
  });

  it('is success when done and healed', () => {
    expect(at('done', { healed: true, message: 'Fixed it' })).toEqual({
      status: 'success',
      headline: 'Fixed it',
      busy: false,
    });
  });

  it('falls back to a default success headline', () => {
    expect(at('done', { healed: true }).headline).toBe('Fixed');
  });

  it('is failed when done but not healed', () => {
    expect(at('done', { healed: false }).status).toBe('failed');
    expect(at('done', { healed: false }).headline).toBe(
      'Could not fix automatically',
    );
  });

  it('shows the done failure message when present', () => {
    expect(at('done', { healed: false, message: 'still broken' }).headline).toBe(
      'still broken',
    );
  });

  it('is failed on error with the message', () => {
    expect(at('error', { message: 'nope' })).toEqual({
      status: 'failed',
      headline: 'nope',
      busy: false,
    });
  });

  it('has a default error headline', () => {
    expect(at('error').headline).toBe('Something went wrong');
  });
});

describe('isGhMissingError', () => {
  it('detects a gh-not-found message', () => {
    expect(
      isGhMissingError('GitHub CLI (gh) was not found. Install it…'),
    ).toBe(true);
  });

  it('detects a PATH complaint', () => {
    expect(isGhMissingError('gh is not on your PATH')).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isGhMissingError('The code expired before sign-in completed.')).toBe(
      false,
    );
  });
});
