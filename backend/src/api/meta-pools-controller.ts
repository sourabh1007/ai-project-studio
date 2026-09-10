import { ValidationError } from '../kernel/error-types.js';
import type { MetaPoolsStatus } from '../meta/pooled-meta-runner.js';
import type { Route } from './http-contract.js';

export interface MetaPoolsControllerDeps {
  /** Live warm-pool status snapshot (enabled + capacity). */
  status: () => MetaPoolsStatus;
  /**
   * Live-resizes the shared warm pool to `size` sessions, applying the change
   * immediately (no restart), and returns the refreshed status. Throws when
   * warm pools are disabled.
   */
  resize: (size: number) => MetaPoolsStatus;
  /**
   * Live shared headless process budget. Stamped onto *every* response here
   * rather than by each caller: the mutation previously returned a status
   * without it, so the settings page lost the capacity readout after a resize
   * even though both routes are declared to return the same refreshed status.
   * Optional so a deployment without an admission gate still serves.
   */
  processAdmission?: () => MetaPoolsStatus['processAdmission'];
}

function assertResize(body: unknown): { size: number } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be an object');
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.size !== 'number' ||
    !Number.isInteger(record.size) ||
    record.size < 0
  ) {
    throw new ValidationError('size must be a whole number of 0 or more');
  }
  return { size: record.size };
}

/**
 * Routes exposing the shared warm metasession pool so the Settings page can
 * show how much warm AI capacity is ready and live-resize it without a
 * restart. `GET` reflects live pool state; `POST /meta/pools/resize` grows or
 * shrinks the pool immediately, so the change animates in.
 */
export function createMetaPoolsRoutes(deps: MetaPoolsControllerDeps): Route[] {
  // One place decides what a pool status response looks like, so a route can
  // never again answer with a partially-populated status.
  const respond = (status: MetaPoolsStatus) => {
    const admission = deps.processAdmission?.();
    return {
      status: 200,
      body: admission ? { ...status, processAdmission: admission } : status,
    };
  };
  return [
    {
      method: 'get',
      path: '/meta/pools',
      handler: () => respond(deps.status()),
    },
    {
      method: 'post',
      path: '/meta/pools/resize',
      handler: (req) => {
        const { size } = assertResize(req.body);
        return respond(deps.resize(size));
      },
    },
  ];
}
