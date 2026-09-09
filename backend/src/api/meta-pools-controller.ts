import { ValidationError } from '../kernel/error-types.js';
import type { MetaPoolsStatus } from '../meta/pooled-meta-runner.js';
import type { Route } from './http-contract.js';

export interface MetaPoolsControllerDeps {
  /** Live warm-pool status snapshot (enabled + per-purpose capacity). */
  status: () => MetaPoolsStatus;
  /**
   * Live-resizes the warm pool for a purpose to `size` sessions, applying the
   * change immediately (no restart), and returns the refreshed status. Throws
   * when no pool serves the purpose.
   */
  resize: (purpose: string, size: number) => MetaPoolsStatus;
  /**
   * Live-creates and starts a warm pool for a new purpose at `size` sessions
   * (no restart), returning the refreshed status so the new pool's sessions
   * animate in as they warm. Throws when warm pools are disabled or the purpose
   * already has a pool.
   */
  create: (purpose: string, size: number) => MetaPoolsStatus;
  /**
   * Live-removes and shuts down the warm pool for a purpose (no restart),
   * returning the refreshed status. Throws when warm pools are disabled or no
   * pool serves the purpose.
   */
  remove: (purpose: string) => MetaPoolsStatus;
  /**
   * Live shared headless process budget. Stamped onto *every* response here
   * rather than by each caller: the mutations previously returned a status
   * without it, so the settings page lost the capacity readout after any pool
   * edit even though all four routes are declared to return the same refreshed
   * status. Optional so a deployment without an admission gate still serves.
   */
  processAdmission?: () => MetaPoolsStatus['processAdmission'];
}

function assertResize(body: unknown): { purpose: string; size: number } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be an object');
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.purpose !== 'string' ||
    record.purpose.trim().length === 0
  ) {
    throw new ValidationError('purpose must be a non-empty string');
  }
  if (
    typeof record.size !== 'number' ||
    !Number.isInteger(record.size) ||
    record.size < 0
  ) {
    throw new ValidationError('size must be a whole number of 0 or more');
  }
  return { purpose: record.purpose, size: record.size };
}

/**
 * Validates a `{ purpose }` body for the create-with-size and remove routes.
 * `create` reuses {@link assertResize} because it also needs a size; this
 * covers the remove route, which needs only a purpose.
 */
function assertPurpose(body: unknown): { purpose: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be an object');
  }
  const record = body as Record<string, unknown>;
  if (
    typeof record.purpose !== 'string' ||
    record.purpose.trim().length === 0
  ) {
    throw new ValidationError('purpose must be a non-empty string');
  }
  return { purpose: record.purpose };
}

/**
 * Routes exposing the warm metasession pools so the Settings page can show how
 * much warm AI capacity is ready and live-edit pools without a restart.
 * `GET` reflects live pool state; `POST /meta/pools/resize` grows or shrinks a
 * pool immediately; `POST /meta/pools/create` spins up a pool for a new
 * purpose; `POST /meta/pools/remove` tears one down — all so the change
 * animates in instead of forcing a restart.
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
        const { purpose, size } = assertResize(req.body);
        return respond(deps.resize(purpose, size));
      },
    },
    {
      method: 'post',
      path: '/meta/pools/create',
      handler: (req) => {
        const { purpose, size } = assertResize(req.body);
        return respond(deps.create(purpose, size));
      },
    },
    {
      method: 'post',
      path: '/meta/pools/remove',
      handler: (req) => {
        const { purpose } = assertPurpose(req.body);
        return respond(deps.remove(purpose));
      },
    },
  ];
}
