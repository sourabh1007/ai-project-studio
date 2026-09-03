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
 * Routes exposing the warm metasession pools so the Settings page can show how
 * much warm AI capacity is ready and live-resize a pool without a restart.
 * `GET` reflects live pool state; `POST /meta/pools/resize` grows or shrinks a
 * pool immediately so the change animates in instead of forcing a restart.
 */
export function createMetaPoolsRoutes(deps: MetaPoolsControllerDeps): Route[] {
  return [
    {
      method: 'get',
      path: '/meta/pools',
      handler: () => ({ status: 200, body: deps.status() }),
    },
    {
      method: 'post',
      path: '/meta/pools/resize',
      handler: (req) => {
        const { purpose, size } = assertResize(req.body);
        return { status: 200, body: deps.resize(purpose, size) };
      },
    },
  ];
}
