import type { Route } from './http-contract.js';

/**
 * Version of the desktop<->backend contract. Bump this whenever the shell can
 * no longer drive an older backend (or vice versa): route shapes, the shutdown
 * handshake, or the IPC message set. The desktop refuses to adopt a backend
 * that answers with a different number, which turns a silent half-upgraded
 * install into an explicit, actionable failure.
 */
export const DESKTOP_PROTOCOL_VERSION = 1;

/** Payload returned by the desktop startup handshake. */
export interface BackendIdentity {
  /** Echo of the launch id the shell put in the child's environment. */
  launchId: string | null;
  /** OS process id, so the shell can prove it reached the child it spawned. */
  pid: number;
  /** Human-readable backend build, surfaced in mismatch diagnostics. */
  version: string;
  /** {@link DESKTOP_PROTOCOL_VERSION} of this build. */
  protocolVersion: number;
}

export interface IdentityControllerDeps {
  /** Launch id issued by the desktop shell; absent outside the desktop. */
  launchId?: string | null;
  /** Process id of this backend. */
  pid?: number;
  /** Backend build version. */
  version?: string;
}

/**
 * Identity probe used by the desktop shell to decide whether the server that
 * answered on its chosen port is really the backend it just spawned.
 *
 * A plain liveness check cannot tell "my backend is up" from "something else
 * already owns this port" or "a stale backend from the previous version is
 * still running". Both produce a healthy 2xx and then fail confusingly later.
 * This route must stay dependency-free so it answers before subsystems warm up.
 */
export function createIdentityRoutes(deps: IdentityControllerDeps = {}): Route[] {
  const body: BackendIdentity = {
    launchId: deps.launchId ?? process.env.CW_DESKTOP_LAUNCH_ID ?? null,
    pid: deps.pid ?? process.pid,
    version: deps.version ?? process.env.CW_APP_VERSION ?? 'unknown',
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
  };
  return [
    {
      method: 'get',
      path: '/identity',
      handler: () => ({ status: 200, body }),
    },
  ];
}
