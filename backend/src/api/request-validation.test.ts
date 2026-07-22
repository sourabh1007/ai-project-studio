import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseInput } from './request-validation.js';
import { isAppError } from '../kernel/error-types.js';

const schema = z.object({ name: z.string().min(1) });

describe('parseInput', () => {
  it('returns parsed data for valid input', () => {
    expect(parseInput(schema, { name: 'ok' })).toEqual({ name: 'ok' });
  });

  it('throws a ValidationError for invalid input', () => {
    try {
      parseInput(schema, { name: '' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.kind).toBe('validation');
    }
  });
});
