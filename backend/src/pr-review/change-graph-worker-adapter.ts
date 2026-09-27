import { Worker, parentPort, workerData } from 'node:worker_threads';
import { buildChangeGraph, type BuiltChangeGraph } from './change-graph-builder.js';
import { nodeChangeGraphFs } from './change-graph-fs.js';
import { createDefaultAnalyzers } from './default-analyzers.js';
import type { PrDiffEntry } from './pr-review-contract.js';
import type { BackgroundWorker } from '../kernel/background-work-runner.js';

export interface ChangeGraphWorkInput {
  worktreePath: string;
  entries: PrDiffEntry[];
  maxBoundaryReads?: number;
}

export function spawnChangeGraphWorker(
  input: ChangeGraphWorkInput,
  onProgress: (message: string) => void,
  memoryMb: number,
): BackgroundWorker<BuiltChangeGraph> {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: 'change-graph', input },
    resourceLimits: { maxOldGenerationSizeMb: memoryMb },
  });
  const result = new Promise<BuiltChangeGraph>((resolve, reject) => {
    let received = false;
    worker.on('message', (message) => {
      if (message.type === 'progress') onProgress(message.message);
      if (message.type === 'result') {
        received = true;
        resolve(message.graph);
      }
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!received) reject(new Error(`Change-graph worker exited before completion (code ${code}). Retry this analysis.`));
    });
  });
  return { result, terminate: async () => { await worker.terminate(); } };
}

if (parentPort && workerData?.kind === 'change-graph') {
  const port = parentPort;
  void buildChangeGraph({
    ...(workerData.input as ChangeGraphWorkInput),
    registry: createDefaultAnalyzers(),
    fs: nodeChangeGraphFs,
    onProgress: (message) => port.postMessage({ type: 'progress', message }),
  }).then((graph) => {
    port.postMessage({ type: 'result', graph });
    port.close();
  });
}
