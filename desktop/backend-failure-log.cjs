'use strict';

/**
 * Durable record of why the backend stopped.
 *
 * Without this a crash left no evidence anywhere: the backend cannot log its
 * own hard exit, the supervisor's stderr goes to a console a packaged app does
 * not have, and the renderer's in-memory notice dies with the next reload. The
 * diagnostics page then had nothing to show but "unreachable", and the reason
 * was unrecoverable. These entries survive both the crash and the restart.
 *
 * Lives outside main.cjs so it can be exercised without booting Electron.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 20;

/**
 * @param {object} options
 * @param {string} options.logPath Absolute path of the JSON-lines log file.
 * @param {(message: string) => void} [options.onError] Best-effort reporter.
 * @param {() => string} [options.now] Injected clock for deterministic tests.
 */
function createBackendFailureLog({ logPath, onError, now }) {
  /** Most recent entries, mirrored in memory so a read never hits the disk. */
  const entries = [];
  const clock = now ?? (() => new Date().toISOString());

  /**
   * Appends one backend-failure record. Best effort in every direction: a
   * diagnostics write must never be able to take the app down with it.
   */
  function record(entry) {
    const recorded = { at: clock(), ...entry };
    entries.push(recorded);
    if (entries.length > MAX_ENTRIES) {
      entries.shift();
    }
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      const size = fs.statSync(logPath, { throwIfNoEntry: false })?.size ?? 0;
      if (size > MAX_BYTES) {
        fs.rmSync(logPath, { force: true });
      }
      fs.appendFileSync(logPath, `${JSON.stringify(recorded)}\n`, 'utf8');
    } catch (error) {
      onError?.(`[desktop] could not record backend failure: ${error}`);
    }
    return recorded;
  }

  /** Newest-first view for the diagnostics page. */
  function recent(limit = 10) {
    return entries.slice(-limit).reverse();
  }

  return { record, recent, logDirectory: path.dirname(logPath) };
}

module.exports = { createBackendFailureLog, MAX_BYTES, MAX_ENTRIES };
