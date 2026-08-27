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
  | 'auth_required'
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

/**
 * A provider (GitHub, Azure DevOps, …) rejected the request because the user is
 * not signed in / the CLI or token is not configured. Maps to HTTP 401 so the
 * UI can prompt for sign-in instead of showing a generic 500. `provider`
 * identifies which login is missing.
 */
export class AuthRequiredError extends AppError {
  readonly provider?: string;

  constructor(message: string, provider?: string, details?: unknown) {
    super('auth_required', message, details);
    this.provider = provider;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
