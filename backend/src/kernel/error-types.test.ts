import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ProviderError,
  ConfigError,
  isAppError,
} from './error-types.js';

describe('error-types', () => {
  it('AppError carries kind, message and details', () => {
    const err = new AppError('internal', 'boom', { a: 1 });
    expect(err.kind).toBe('internal');
    expect(err.message).toBe('boom');
    expect(err.details).toEqual({ a: 1 });
    expect(err.name).toBe('AppError:internal');
    expect(err).toBeInstanceOf(Error);
  });

  it('subclasses set the right kind', () => {
    expect(new ValidationError('v').kind).toBe('validation');
    expect(new NotFoundError('n').kind).toBe('not_found');
    expect(new ConflictError('c').kind).toBe('conflict');
    expect(new ProviderError('p').kind).toBe('provider');
    expect(new ConfigError('cfg').kind).toBe('config');
  });

  it('subclasses forward details', () => {
    const e = new ValidationError('v', { field: 'x' });
    expect(e.details).toEqual({ field: 'x' });
  });

  it('isAppError discriminates', () => {
    expect(isAppError(new NotFoundError('n'))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('nope')).toBe(false);
  });
});
