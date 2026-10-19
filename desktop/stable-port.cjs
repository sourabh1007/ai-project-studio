'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolves the TCP port the local backend listens on — and therefore the
 * origin (`scheme://host:port`) of the app's own page.
 *
 * The renderer keeps its UI state (open workspace tabs, explorer collapse, the
 * saved PR-review team roster, and other preferences) in `localStorage`, which
 * the browser isolates *per origin*. Picking a fresh free port on every launch
 * therefore gave the app a new origin each time, silently discarding all of
 * that state on every restart and after every update.
 *
 * This module reuses the previous launch's port whenever it is still bindable,
 * keeping the origin — and thus `localStorage` — stable. It falls back to a new
 * free port only when the remembered one is taken (the sole case where state is
 * unavoidably reset), and remembers the new choice for next time.
 */

/** True for an integer that is a usable TCP port number. */
function isValidPort(value) {
  return Number.isInteger(value) && value > 0 && value < 65536;
}

/** Finds a free TCP port by binding to port 0 and reading the assigned port. */
function findFreePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Resolves true when `port` can be bound on `host` right now. */
function isPortAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Builds a stable-port resolver.
 *
 * @param {object} options
 * @param {string} options.host Host the backend binds to (e.g. `127.0.0.1`).
 * @param {string} options.portFile Absolute path of the JSON file remembering
 *   the last-used port, under the app's (update-stable) userData directory.
 * @param {object} [options.io] Filesystem shim (defaults to `node:fs`), for tests.
 * @param {(host: string) => Promise<number>} [options.freePort] Free-port
 *   finder override, for tests.
 * @param {(host: string, port: number) => Promise<boolean>} [options.available]
 *   Port-availability probe override, for tests.
 */
function createStablePort({
  host,
  portFile,
  io = fs,
  freePort = findFreePort,
  available = isPortAvailable,
} = {}) {
  const readPersisted = () => {
    try {
      const value = JSON.parse(io.readFileSync(portFile, 'utf8')).port;
      return isValidPort(value) ? value : null;
    } catch {
      return null;
    }
  };

  const persist = (port) => {
    try {
      io.mkdirSync(path.dirname(portFile), { recursive: true });
      io.writeFileSync(portFile, JSON.stringify({ port }));
    } catch {
      // Best-effort: failing to persist only risks a different port (and reset
      // localStorage) next launch — it must never fail startup.
    }
  };

  return {
    /** Returns the remembered port when free, otherwise a fresh free port. */
    async resolve() {
      const persisted = readPersisted();
      if (persisted !== null && (await available(host, persisted))) {
        return persisted;
      }
      const port = await freePort(host);
      persist(port);
      return port;
    },
  };
}

module.exports = {
  createStablePort,
  findFreePort,
  isPortAvailable,
  isValidPort,
};
