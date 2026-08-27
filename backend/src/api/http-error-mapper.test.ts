import { describe, it, expect } from 'vitest';
import { toErrorResult } from './http-error-mapper.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ProviderError,
  ConfigError,
  AuthRequiredError,
  AppError,
} from '../kernel/error-types.js';

describe('toErrorResult', () => {
  it('maps each AppError kind to its status', () => {
    expect(toErrorResult(new ValidationError('x')).status).toBe(400);
    expect(toErrorResult(new NotFoundError('x')).status).toBe(404);
    expect(toErrorResult(new ConflictError('x')).status).toBe(409);
    expect(toErrorResult(new ProviderError('x')).status).toBe(502);
    expect(toErrorResult(new ConfigError('x')).status).toBe(500);
    expect(toErrorResult(new AuthRequiredError('x')).status).toBe(401);
    expect(toErrorResult(new AppError('internal', 'x')).status).toBe(500);
  });

  it('includes the kind and message for app errors', () => {
    const result = toErrorResult(new NotFoundError('missing feature'));
    expect(result.body).toEqual({
      error: { kind: 'not_found', message: 'missing feature' },
    });
  });

  it('maps unknown errors to a generic 500', () => {
    const result = toErrorResult(new Error('boom'));
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: { kind: 'internal', message: 'Internal server error' },
    });
  });
});
