/**
 * Typed error hierarchy for the backend. Every thrown error in product code
 * uses one of these so callers can discriminate on `kind`.
 */

export type ErrorKind =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'provider'
  | 'config'
  | 'internal';

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly details?: unknown;

  constructor(kind: ErrorKind, message: string, details?: unknown) {
    super(message);
    this.name = `AppError:${kind}`;
    this.kind = kind;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('validation', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: unknown) {
    super('not_found', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super('conflict', message, details);
  }
}

export class ProviderError extends AppError {
  constructor(message: string, details?: unknown) {
    super('provider', message, details);
  }
}

export class ConfigError extends AppError {
  constructor(message: string, details?: unknown) {
    super('config', message, details);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
