import { describe, it, expect } from 'vitest';
import { describeUnexpectedError, toErrorResult } from './http-error-mapper.js';
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

describe('describeUnexpectedError', () => {
  it('says nothing about an expected app error', () => {
    // Its message already reached the client; it is not a defect to report.
    expect(describeUnexpectedError(new NotFoundError('missing'))).toBeNull();
  });

  it('describes the real fault hidden behind a generic 500', () => {
    const error = new Error('column features.foo does not exist');
    const described = describeUnexpectedError(error);
    expect(described).toMatchObject({
      name: 'Error',
      message: 'column features.foo does not exist',
    });
    expect(described?.stack).toBe(error.stack);
  });

  it('omits the stack when the error carries none', () => {
    const error = new Error('no stack');
    delete error.stack;
    expect(describeUnexpectedError(error)).toEqual({
      name: 'Error',
      message: 'no stack',
    });
  });

  it.each([
    ['a string throw', 'boom', 'string', 'boom'],
    ['undefined', undefined, 'undefined', 'undefined'],
    ['a plain object', { code: 1 }, 'object', '[object Object]'],
  ])('describes %s that is not an Error', (_label, thrown, name, message) => {
    expect(describeUnexpectedError(thrown)).toEqual({ name, message });
  });
});
