import { ConflictError } from '../kernel/error-types.js';

/** Request every owner's cancellation before awaiting any of their confirmations. */
export async function requireQuiescence(
  actions: ReadonlyArray<() => Promise<boolean>>,
): Promise<void> {
  const results = await Promise.allSettled(actions.map((action) => {
    try {
      return action();
    } catch (error) {
      return Promise.reject(error);
    }
  }));
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []);
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Producer shutdown could not be confirmed');
  }
  if (results.some((result) => result.status === 'fulfilled' && result.value !== true)) {
    throw new ConflictError('Deletion is blocked until all owned work has stopped');
  }
}
