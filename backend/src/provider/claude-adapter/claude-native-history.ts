import { opendir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { createBackgroundWorkRunner, type BackgroundWorker } from '../../kernel/background-work-runner.js';
import { claudeConfigSchema, type ClaudeConfig } from './config.js';
import { createClaudeHistoryCache, type ClaudeHistoryFile, type ClaudeHistorySnapshot } from './claude-history-cache.js';
import { claudeRecord } from './claude-protocol.js';

export interface ClaudeHistoryWorkInput {
  config: ClaudeConfig;
  directory: string;
}

export interface ClaudeHistoryFs {
  entries(path: string): AsyncIterable<{ name: string; directory: boolean; file: boolean }>;
  /** Reads at most limit+1 bytes, detecting overflow without allocating the file. */
  read(path: string, limit: number): Promise<string>;
}

export const claudeHistoryFs: ClaudeHistoryFs = {
  async *entries(path) {
    const directory = await opendir(path);
    for await (const entry of directory) {
      yield { name: entry.name, directory: entry.isDirectory(), file: entry.isFile() };
    }
  },
  async read(path, limit) {
    const file = await open(path, 'r');
    try {
      const bytes = Buffer.alloc(limit + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > limit) throw new Error('Claude history exceeds total byte limit');
      return bytes.subarray(0, total).toString('utf8');
    } finally {
      await file.close();
    }
  },
};

/** Runs only in a bounded worker. Never derives the project folder from cwd. */
export async function readClaudeHistoryFiles(
  input: ClaudeHistoryWorkInput,
  fs: ClaudeHistoryFs,
): Promise<ClaudeHistoryFile[]> {
  const files: ClaudeHistoryFile[] = [];
  let entries = 0;
  let bytes = 0;
  let openedRoot = false;
  const countEntry = () => {
    entries += 1;
    if (entries > input.config.historyMaxEntries) throw new Error('Claude history exceeds traversal limit');
  };
  try {
    for await (const project of fs.entries(input.directory)) {
      openedRoot = true;
      countEntry();
      if (!project.directory) continue;
      const directory = join(input.directory, project.name);
      for await (const entry of fs.entries(directory)) {
        countEntry();
        if (!entry.file || !entry.name.endsWith('.jsonl')) continue;
        if (files.length >= input.config.historyMaxSessions) throw new Error('Claude history exceeds session limit');
        const path = join(directory, entry.name);
        const jsonl = await fs.read(path, input.config.historyMaxBytes - bytes);
        bytes += Buffer.byteLength(jsonl, 'utf8');
        if (bytes > input.config.historyMaxBytes) throw new Error('Claude history exceeds total byte limit');
        files.push({ path, jsonl });
      }
    }
  } catch (error) {
    // A not-yet-installed CLI has no history directory. All other failures remain visible.
    if (!openedRoot && claudeRecord(error)?.code === 'ENOENT') return [];
    throw error;
  }
  return files;
}

export async function buildClaudeHistorySnapshot(input: ClaudeHistoryWorkInput, fs: ClaudeHistoryFs): Promise<ClaudeHistorySnapshot> {
  const files = await readClaudeHistoryFiles(input, fs);
  const cache = createClaudeHistoryCache(input.config, { read: async () => files });
  await cache.refresh(new AbortController().signal);
  return cache.snapshot();
}

export interface ClaudeHistoryWorkerHandle {
  on(event: 'message', callback: (value: unknown) => void): void;
  once(event: 'error', callback: (error: Error) => void): void;
  once(event: 'exit', callback: (code: number) => void): void;
  terminate(): Promise<number>;
}

export type ClaudeHistoryWorkerFactory = (input: ClaudeHistoryWorkInput) => ClaudeHistoryWorkerHandle;

export function spawnClaudeHistoryWorker(
  input: ClaudeHistoryWorkInput,
  makeWorker: ClaudeHistoryWorkerFactory = (work) => new Worker(new URL(import.meta.url), {
    workerData: { kind: 'claude-native-history', input: work },
    resourceLimits: { maxOldGenerationSizeMb: work.config.historyWorkerMemoryMb },
  }),
): BackgroundWorker<ClaudeHistorySnapshot> {
  const worker = makeWorker(input);
  const result = new Promise<ClaudeHistorySnapshot>((resolve, reject) => {
    let received = false;
    worker.on('message', (value) => {
      const message = claudeRecord(value);
      if (message?.type === 'result') {
        const snapshot = claudeRecord(message.snapshot);
        if (snapshot && Array.isArray(snapshot.sessions) && Array.isArray(snapshot.usage)) {
          // The private worker uses structured clone; validate its complete shape at the boundary.
          const parsed = claudeSnapshotSchema.safeParse(snapshot);
          if (parsed.success) {
            received = true;
            resolve(parsed.data);
          } else {
            reject(new Error('Invalid Claude history worker result'));
          }
        } else {
          reject(new Error('Invalid Claude history worker result'));
        }
      } else if (message?.type === 'failure') {
        reject(new Error('Claude history worker could not read native transcripts'));
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!received) reject(new Error(`Claude history worker exited before completion (code ${code})`));
    });
  });
  return { result, terminate: async () => { await worker.terminate(); } };
}

const claudeSnapshotSchema = z.object({
  sessions: z.array(z.tuple([z.string(), z.array(z.object({
    nativeSessionId: z.string(), nativeMessageId: z.string(),
    role: z.enum(['user', 'assistant']), text: z.string(), timestamp: z.string(),
    cwd: z.string().nullable(), model: z.string().nullable(),
  }))])),
  usage: z.array(z.tuple([z.string(), z.array(z.object({
    sourceId: z.string(), nativeSessionId: z.string(), nativeMessageId: z.string(),
    scope: z.enum(['message', 'session']), model: z.string().nullable(),
    inputTokens: z.number().nullable(), outputTokens: z.number().nullable(),
    cacheReadTokens: z.number().nullable(), cacheWriteTokens: z.number().nullable(),
    charge: z.union([
      z.object({ status: z.literal('unavailable') }),
      z.object({ status: z.literal('estimated'), unit: z.literal('USD'), amount: z.number(), scope: z.literal('session') }),
    ]),
  }))])),
});

export interface ClaudeNativeHistoryDeps {
  baseEnv?: Record<string, string | undefined>;
  home?: string;
  spawnWorker?: (input: ClaudeHistoryWorkInput) => BackgroundWorker<ClaudeHistorySnapshot>;
}

export function createClaudeNativeHistoryStore(config: ClaudeConfig, deps: ClaudeNativeHistoryDeps = {}) {
  const directory = config.historyDirectory ||
    join(deps.baseEnv?.CLAUDE_CONFIG_DIR ?? join(deps.home ?? homedir(), '.claude'), 'projects');
  const cache = createClaudeHistoryCache(config);
  const runner = createBackgroundWorkRunner<ClaudeHistoryWorkInput, ClaudeHistorySnapshot>({
    config: { maxWorkers: 1, maxQueued: 0, timeoutMs: config.historyTimeoutMs, workerMemoryMb: config.historyWorkerMemoryMb },
    spawn: (input) => (deps.spawnWorker ?? spawnClaudeHistoryWorker)(input),
  });
  return {
    read: cache.read,
    prompts: cache.prompts,
    recentPrompts: cache.recentPrompts,
    listImportable: cache.listImportable,
    readUsagePage: cache.readUsagePage,
    async refresh(signal: AbortSignal) {
      cache.replace(await runner.run({ config, directory }, { signal }));
    },
    close: () => runner.close(),
  };
}

export interface ClaudeHistoryWorkerPort {
  postMessage(value: unknown): void;
  close(): void;
}

export async function runClaudeHistoryWorker(
  port: ClaudeHistoryWorkerPort | null,
  data: unknown,
  fs: ClaudeHistoryFs,
): Promise<void> {
  const nativeWork = claudeRecord(data);
  if (!port || nativeWork?.kind !== 'claude-native-history') return;
  const input = claudeRecord(nativeWork.input);
  try {
    if (!input || typeof input.directory !== 'string') throw new Error('Invalid Claude history worker input');
    const work = { config: claudeConfigSchema.parse(input.config), directory: input.directory };
    const snapshot = await buildClaudeHistorySnapshot(work, fs);
    port.postMessage({ type: 'result', snapshot });
  } catch {
    port.postMessage({ type: 'failure' });
  } finally {
    port.close();
  }
}

void runClaudeHistoryWorker(parentPort, workerData, claudeHistoryFs);
