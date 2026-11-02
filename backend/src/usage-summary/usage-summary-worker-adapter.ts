import { Worker, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { DATABASE_GROUPS } from '../persistence/db/schema.js';
import { readUsageSummarySnapshot } from '../persistence/usage-summary-snapshot.js';
import type { UsageSummary } from './usage-summary-contract.js';
import type { BackgroundWorker } from '../kernel/background-work-runner.js';

export interface UsageSummaryWorkInput {
  databasePath: string;
  rollupKinds: string[];
}

export function spawnUsageSummaryWorker(
  input: UsageSummaryWorkInput,
  _onProgress: (message: string) => void,
  memoryMb: number,
): BackgroundWorker<UsageSummary> {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: 'usage-summary', input },
    resourceLimits: { maxOldGenerationSizeMb: memoryMb },
  });
  const result = new Promise<UsageSummary>((resolve, reject) => {
    let settled = false;
    worker.on('message', (message) => {
      settled = true;
      if (message.type === 'result') resolve(message.summary);
      else reject(new Error(`Usage summary failed: ${message.error}`));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Usage summary worker exited before completion (code ${code}). Retry.`));
    });
  });
  return { result, terminate: async () => { await worker.terminate(); } };
}

if (parentPort && workerData?.kind === 'usage-summary') {
  const port = parentPort;
  const { databasePath, rollupKinds } = workerData.input as UsageSummaryWorkInput;
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      // Usage tables live in a sibling database file that must be attached read-only too.
      const usageFile = DATABASE_GROUPS.find((group) => group.schema === 'usage')?.file;
      if (usageFile) db.prepare('ATTACH DATABASE ? AS usage').run(join(dirname(databasePath), usageFile));
      port.postMessage({ type: 'result', summary: readUsageSummarySnapshot(db, rollupKinds) });
    } finally {
      db.close();
    }
  } catch (error) {
    port.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
  port.close();
}
