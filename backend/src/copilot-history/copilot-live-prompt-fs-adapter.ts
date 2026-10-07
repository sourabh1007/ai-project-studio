import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import type { LivePromptSource, LivePromptTurn } from './copilot-history-contract.js';
import { isInjectedPrompt } from './copilot-history-reader.js';
import { parseLatestLivePrompt } from './copilot-live-prompt-parser.js';

export interface LivePromptFsReaderDeps {
  /** Absolute path to the CLI's per-session state directory. */
  sessionStateDir: string;
  /** Event-log file name inside each session's directory. */
  eventsFile: string;
  /** Maximum bytes to read from the tail of the event log. */
  tailBytes: number;
}

/**
 * Reads the live in-flight turn for a session from the tail of its CLI
 * `events.jsonl` log. Only the last {@link LivePromptFsReaderDeps.tailBytes}
 * bytes are read so a long session's multi-megabyte log never blocks the event
 * loop; the first (possibly partial) line in that window is dropped before
 * parsing. Any IO/decoding failure degrades to null so the reader simply falls
 * back to its store-derived indicator. This is a thin IO adapter — its parsing
 * logic lives in the unit-tested `parseLatestLivePrompt`.
 */
export function createLivePromptFsReader(
  deps: LivePromptFsReaderDeps,
): LivePromptSource {
  return {
    latest(sessionId: string): LivePromptTurn | null {
      const path = join(deps.sessionStateDir, sessionId, deps.eventsFile);
      let fd: number | null = null;
      try {
        fd = openSync(path, 'r');
        const size = fstatSync(fd).size;
        const length = Math.min(size, deps.tailBytes);
        if (length === 0) {
          return null;
        }
        const start = size - length;
        const buffer = Buffer.allocUnsafe(length);
        readSync(fd, buffer, 0, length, start);
        let tail = buffer.toString('utf8');
        if (start > 0) {
          const newline = tail.indexOf('\n');
          tail = newline >= 0 ? tail.slice(newline + 1) : '';
        }
        return parseLatestLivePrompt(tail, isInjectedPrompt);
      } catch {
        return null;
      } finally {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {
            // Best effort: nothing actionable if the descriptor is already gone.
          }
        }
      }
    },
  };
}
