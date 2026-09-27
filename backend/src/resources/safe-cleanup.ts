import { resolve } from 'node:path';
import type { CleanupCategory, CleanupResult, ResourceFileSystem } from './resources-contract.js';
import { assertRealPath, errorText, isWithin } from './storage-scanner.js';

export interface LogCleanupPolicy {
  directory: string;
  appDataRoots: string[];
  isManagedFile(name: string): boolean;
  /** Keep today's files and anything created/modified since backend startup. */
  olderThan: number;
}
export function supportsLogCleanup(policy: LogCleanupPolicy): boolean {
  return policy.appDataRoots.some((root) => isWithin(policy.directory, root));
}
export async function cleanupFiles(deps: {
  fs: ResourceFileSystem; now(): number; policy: LogCleanupPolicy;
  maxEntries: number; timeoutMs: number;
  onProgress?: (result: CleanupResult) => void;
  onDeleted?: (bytes: number) => void;
}, category: CleanupCategory, signal: AbortSignal): Promise<CleanupResult> {
  const result: CleanupResult = {
    category, status: 'completed', deletedFiles: 0, freedBytes: 0,
    skippedFiles: 0, errors: [], completedAt: deps.now(),
  };
  if (category !== 'logs' || !supportsLogCleanup(deps.policy)) {
    return { ...result, status: 'unsupported', errors: ['No safe disposable directory is configured for this category.'] };
  }
  const start = deps.now();
  const directory = deps.policy.directory;
  try {
    await assertRealPath(deps.fs, directory);
    let count = 0;
    for await (const name of deps.fs.entries(directory)) {
      if (signal.aborted || deps.now() - start >= deps.timeoutMs || ++count > deps.maxEntries) {
        throw new Error('Cleanup cancelled or bounded work limit reached.');
      }
      const path = resolve(directory, name);
      if (!deps.policy.isManagedFile(name) || !isWithin(path, directory)) {
        result.skippedFiles++;
        deps.onProgress?.(result);
        continue;
      }
      try {
        await assertRealPath(deps.fs, path);
        const before = await deps.fs.stat(path);
        // Filename date is additionally checked: old mtime alone cannot prove inactivity.
        const date = /-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/.exec(name)?.[1];
        const dateMs = date ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
        if (before.kind !== 'file' || before.linkCount > 1 || before.modifiedAt >= deps.policy.olderThan ||
          !Number.isFinite(dateMs) || dateMs >= deps.policy.olderThan) {
          result.skippedFiles++;
          deps.onProgress?.(result);
          continue;
        }
        await assertRealPath(deps.fs, directory);
        await assertRealPath(deps.fs, path);
        const after = await deps.fs.stat(path);
        if (before.identity !== after.identity || before.modifiedAt !== after.modifiedAt ||
          before.size !== after.size || after.kind !== 'file' || after.linkCount > 1) throw new Error(`File changed during cleanup: ${path}`);
        await deps.fs.unlink(path);
        result.deletedFiles++;
        result.freedBytes += before.size;
        deps.onDeleted?.(before.size);
      } catch (error) {
        if (result.errors.length < 20) result.errors.push(errorText(error));
      }
      deps.onProgress?.(result);
    }
    if (result.errors.length) result.status = 'partial';
  } catch (error) {
    result.status = result.deletedFiles ? 'partial' : 'failed';
    result.errors.push(errorText(error));
  }
  result.completedAt = deps.now();
  return result;
}
