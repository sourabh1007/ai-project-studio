import { isAppError, type ErrorKind } from '../kernel/error-types.js';
import type { HttpResult } from './http-contract.js';

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  provider: 502,
  config: 500,
  auth_required: 401,
  internal: 500,
};

/**
 * Maps any thrown value to an HTTP error result. Known {@link AppError}s use
 * their kind's status; anything else becomes a 500 so no internal detail leaks.
 */
export function toErrorResult(error: unknown): HttpResult {
  if (isAppError(error)) {
    return {
      status: STATUS_BY_KIND[error.kind],
      body: { error: { kind: error.kind, message: error.message } },
    };
  }
  return {
    status: 500,
    body: { error: { kind: 'internal', message: 'Internal server error' } },
  };
}
