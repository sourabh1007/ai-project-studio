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

/**
 * Describes a thrown value that the client is *not* told about, so it can be
 * logged instead of vanishing.
 *
 * The generic 500 above deliberately hides internal detail from the response,
 * but nothing was recording what it hid: a real fault reached the user as
 * "Internal server error" and left no trace anywhere, making failures
 * undiagnosable. Returns `null` for an {@link AppError}, whose message is
 * already in the response and is expected, not a defect.
 */
export function describeUnexpectedError(
  error: unknown,
): { name: string; message: string; stack?: string } | null {
  if (isAppError(error)) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  // A non-Error throw (string, object, undefined) has no message or stack, but
  // is exactly the kind of fault worth seeing, so it is still described.
  return { name: typeof error, message: String(error) };
}
