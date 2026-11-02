import { z } from 'zod';

export const RESOURCES_NAMESPACE = 'resources';
export const resourcesConfigSchema = z.object({
  processSamplingEnabled: z.boolean().default(true).describe('Disable app process-tree sampling to avoid its PowerShell/CIM overhead; host pressure remains available.'),
  sampleIntervalMs: z.number().int().min(5000).max(60000),
  staleAfterMs: z.number().int().min(10000).max(300000),
  processTimeoutMs: z.number().int().min(1000).max(30000),
  scanTimeoutMs: z.number().int().min(1000).max(120000).describe('Inventory discovery and cleanup deadline; scan traversal uses resumable scheduling slices, not this total deadline.'),
  maxScanEntries: z.number().int().min(100).max(1000000).describe('Cleanup entry cap and scan hardlink-identity budget; ordinary inventory entries continue across bounded slices.'),
  maxScanDurationMs: z.number().int().min(1000).max(3600000).default(300000).describe('Scan-wide wall-clock deadline. Incomplete paths retain measured bytes and are marked partial; cleanup cancels an active scan immediately.'),
  storageStaleAfterMs: z.number().int().min(1000).max(3600000),
  desktopPid: z.number().int().nonnegative(),
  desktopDataPath: z.string(),
  applicationPath: z.string(),
  runtimePaths: z.array(z.string()).max(16).default([]),
});
export type ResourcesConfig = z.infer<typeof resourcesConfigSchema>;
export const resourcesDefaults: ResourcesConfig = {
  processSamplingEnabled: true, maxScanDurationMs: 300000,
  sampleIntervalMs: 10000, staleAfterMs: 30000, processTimeoutMs: 8000,
  scanTimeoutMs: 30000, maxScanEntries: 100000, storageStaleAfterMs: 300000,
  desktopPid: 0, desktopDataPath: '', applicationPath: '',
  runtimePaths: [],
};
