import { describe, it, expect } from 'vitest';
import {
  canTransition,
  assertTransition,
  isTerminal,
} from './session-state-machine.js';
import { AppError } from '../kernel/error-types.js';

describe('session-state-machine', () => {
  it('allows legal transitions', () => {
    expect(canTransition('created', 'running')).toBe(true);
    expect(canTransition('created', 'cancelled')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('created', 'completed')).toBe(false);
    expect(canTransition('completed', 'running')).toBe(false);
  });

  it('assertTransition throws on illegal transition', () => {
    expect(() => assertTransition('completed', 'running')).toThrow(AppError);
    expect(() => assertTransition('created', 'running')).not.toThrow();
  });

  it('identifies terminal states', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('created')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });
});
