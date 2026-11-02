import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker, parentPort, workerData } from 'node:worker_threads';

import type { BackgroundWorkConfig } from '../kernel/background-work-config.js';
import {
  createBackgroundWorkRunner,
  type BackgroundWorker,
} from '../kernel/background-work-runner.js';
import type { LivePromptSource, LivePromptTurn } from './copilot-history-contract.js';
import { toVisiblePrompt } from './copilot-history-reader.js';
import { parseLatestLivePrompt } from './copilot-live-prompt-parser.js';

export interface LivePromptFsReaderDeps {
  /** Absolute path to the CLI's per-session state directory. */
  sessionStateDir: string;
  /** Event-log file name inside each session's directory. */
  eventsFile: string;
  /** Bytes read per backwards chunk from the end of the event log. */
  tailBytes: number;
  /**
   * Upper bound on bytes scanned backwards to find the latest visible user
   * message when long tool/assistant output pushed it out of the first chunk.
   */
  maxScanBytes: number;
  /** Worker pool limits: concurrency, queue depth, per-scan timeout, memory. */
  worker: BackgroundWorkConfig;
}

export interface LiveScanInput {
  path: string;
  tailBytes: number;
  maxScanBytes: number;
}

export interface LivePromptFsReader extends LivePromptSource {
  latest(sessionId: string, signal?: AbortSignal): Promise<LivePromptTurn | null>;
  /** Cancels queued/running scans and resolves once every worker has stopped. */
  close(): Promise<void>;
  /** Bounded shutdown; false means worker termination remains unconfirmed. */
  closeWithin(timeoutMs: number): Promise<boolean>;
  stats(): { active: number; queued: number; maxWorkers: number; maxQueued: number };
}

export type LiveScanSpawn = (
  input: LiveScanInput,
  progress: (message: string) => void,
) => BackgroundWorker<LivePromptTurn | null>;

/**
 * Scans a CLI `events.jsonl` backwards, one `tailBytes` chunk at a time, until
 * a window holds a visible user message, the file start is reached, or
 * `maxScanBytes` is exhausted. The first (possibly partial) line of each window
 * is dropped before parsing. A missing log is `null`; any other failure (e.g.
 * a transient Windows sharing violation) rejects so callers can report
 * degraded freshness instead of "nothing happened". This is the CPU/IO-heavy
 * step and runs inside a worker thread, never on the API event loop.
 */
export async function scanLiveLog(input: LiveScanInput): Promise<LivePromptTurn | null> {
  let handle;
  try {
    handle = await open(input.path, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    const budget = Math.min(size, Math.max(input.tailBytes, input.maxScanBytes));
    let chunks: Buffer[] = [];
    let scanned = 0;
    let turn: LivePromptTurn | null = null;
    while (scanned < budget) {
      const length = Math.min(input.tailBytes, budget - scanned);
      const start = size - scanned - length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead < length) {
        break; // file shrank/rotated mid-scan; parse what was read
      }
      chunks = [buffer, ...chunks];
      scanned += length;
      let text = Buffer.concat(chunks).toString('utf8');
      if (start > 0) {
        const newline = text.indexOf('\n');
        text = newline >= 0 ? text.slice(newline + 1) : '';
      }
      turn = parseLatestLivePrompt(text, toVisiblePrompt);
      if (turn !== null) {
        break;
      }
    }
    return turn;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Runs {@link scanLiveLog} in a worker thread; terminating stops it mid-IO. */
export function spawnLiveScanWorker(
  input: LiveScanInput,
  memoryMb: number,
  workerUrl: URL = new URL(import.meta.url),
): BackgroundWorker<LivePromptTurn | null> {
  const worker = new Worker(workerUrl, {
    workerData: { kind: 'live-prompt-scan', input },
    resourceLimits: { maxOldGenerationSizeMb: memoryMb },
  });
  const result = new Promise<LivePromptTurn | null>((resolve, reject) => {
    let received = false;
    worker.on('message', (message) => {
      if (message.type === 'result') {
        received = true;
        resolve(message.turn);
      } else if (message.type === 'error') {
        received = true;
        reject(Object.assign(new Error(message.message), { code: message.code }));
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!received) reject(new Error(`Live prompt scan worker exited before completion (code ${code}).`));
    });
  });
  return { result, terminate: async () => { await worker.terminate(); } };
}

/**
 * Live prompt source backed by bounded worker threads from the shared
 * background-work runner. Timeout, queue limit, abort and shutdown all
 * terminate the underlying worker, so no scan outlives its caller.
 */
export function createLivePromptFsReader(
  deps: LivePromptFsReaderDeps,
  spawn: LiveScanSpawn = (input) => spawnLiveScanWorker(input, deps.worker.workerMemoryMb),
): LivePromptFsReader {
  const runner = createBackgroundWorkRunner<LiveScanInput, LivePromptTurn | null>({
    config: deps.worker,
    spawn,
  });
  return {
    latest(sessionId: string, signal?: AbortSignal): Promise<LivePromptTurn | null> {
      return runner.run({
        path: join(deps.sessionStateDir, sessionId, deps.eventsFile),
        tailBytes: deps.tailBytes,
        maxScanBytes: deps.maxScanBytes,
      }, { signal });
    },
    close: () => runner.close(),
    closeWithin: (timeoutMs) => runner.closeWithin(timeoutMs),
    stats: () => runner.stats(),
  };
}

if (parentPort && workerData?.kind === 'live-prompt-scan') {
  const port = parentPort;
  scanLiveLog(workerData.input as LiveScanInput).then(
    (turn) => port.postMessage({ type: 'result', turn }),
    (error: NodeJS.ErrnoException) => port.postMessage({
      type: 'error', code: error.code, message: error.message,
    }),
  ).finally(() => port.close());
}
