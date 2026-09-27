import { z } from 'zod';

export const RESOURCES_NAMESPACE = 'resources';
export const resourcesConfigSchema = z.object({
  sampleIntervalMs: z.number().int().min(5000).max(60000),
  staleAfterMs: z.number().int().min(10000).max(300000),
  processTimeoutMs: z.number().int().min(1000).max(30000),
  scanTimeoutMs: z.number().int().min(1000).max(120000),
  maxScanEntries: z.number().int().min(100).max(1000000),
  storageStaleAfterMs: z.number().int().min(1000).max(3600000),
  desktopPid: z.number().int().nonnegative(),
  desktopDataPath: z.string(),
  applicationPath: z.string(),
  runtimePaths: z.array(z.string()).max(16).default([]),
});
export type ResourcesConfig = z.infer<typeof resourcesConfigSchema>;
export const resourcesDefaults: ResourcesConfig = {
  sampleIntervalMs: 10000, staleAfterMs: 30000, processTimeoutMs: 8000,
  scanTimeoutMs: 30000, maxScanEntries: 100000, storageStaleAfterMs: 300000,
  desktopPid: 0, desktopDataPath: '', applicationPath: '',
  runtimePaths: [],
};
