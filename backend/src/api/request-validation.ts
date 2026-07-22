import { z } from 'zod';
import { ValidationError } from '../kernel/error-types.js';

/**
 * Parses request input against a schema, converting Zod failures into the
 * app's {@link ValidationError} so the error mapper yields a 400.
 */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Invalid request', result.error.flatten());
  }
  return result.data;
}
