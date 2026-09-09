'use strict';

/**
 * Version of the desktop<->backend contract this shell speaks. Must match
 * DESKTOP_PROTOCOL_VERSION in backend/src/api/identity-controller.ts.
 */
const DESKTOP_PROTOCOL_VERSION = 1;

/**
 * Classifies an /identity response against what this shell just launched.
 *
 * Startup used to accept any 2xx on the chosen port. That conflates three very
 * different situations: our backend is ready, an unrelated server squatted the
 * port between the free-port probe and the child binding it, or a backend from
 * the previous install is still holding the port after an upgrade. The last two
 * produce a healthy-looking app that then fails in confusing ways, which is the
 * shape of the post-upgrade breakage users hit.
 *
 * Outcomes:
 *  - `ready`    — proven to be the child we spawned, speaking our protocol.
 *  - `foreign`  — someone else answered; retryable, our child may still bind.
 *  - `mismatch` — our backend, wrong protocol; fatal, retrying cannot fix it.
 */
function classifyBackendIdentity(identity, expected) {
  if (identity === null || typeof identity !== 'object') {
    return { state: 'foreign', reason: 'The server on this port did not return an identity.' };
  }
  const { launchId, pid, version, protocolVersion } = identity;
  if (typeof launchId !== 'string' || launchId !== expected.launchId) {
    return {
      state: 'foreign',
      reason: 'Another program is already using this port.',
    };
  }
  // Past this point the launch id proves it is our own child, so a bad pid or
  // protocol is a real defect rather than a stranger on the port.
  if (expected.pid != null && pid !== expected.pid) {
    return {
      state: 'foreign',
      reason: `A different backend process (pid ${pid}) answered for this launch.`,
    };
  }
  if (protocolVersion !== expected.protocolVersion) {
    return {
      state: 'mismatch',
      reason: `This app speaks backend protocol ${expected.protocolVersion} but the backend (version ${version ?? 'unknown'}) speaks ${protocolVersion}. The installation is half-upgraded — reinstall AI Project Studio to repair it.`,
    };
  }
  return { state: 'ready' };
}

/** Parses an /identity body, tolerating any non-JSON payload. */
function parseBackendIdentity(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Error thrown when the backend cannot be adopted no matter how long we wait. */
class BackendProtocolMismatchError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'BackendProtocolMismatchError';
    this.fatal = true;
  }
}

module.exports = {
  DESKTOP_PROTOCOL_VERSION,
  BackendProtocolMismatchError,
  classifyBackendIdentity,
  parseBackendIdentity,
};
