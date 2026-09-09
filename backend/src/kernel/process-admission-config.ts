import { z } from 'zod';

export const PROCESS_ADMISSION_NAMESPACE = 'processAdmission';
export const processAdmissionConfigSchema = z.object({
  maxProcesses: z.number().int().min(1).max(256),
  maxWarmProcesses: z.number().int().min(0).max(255),
  maxQueued: z.number().int().min(0).max(4096),
}).refine((value) => value.maxWarmProcesses < value.maxProcesses, 'Reserve at least one process slot for cold launches');
export type ProcessAdmissionConfig = z.infer<typeof processAdmissionConfigSchema>;
/** Shared ACP + SessionLauncher headless budget; interactive PTYs are a separate owner. */
export const processAdmissionDefaults: ProcessAdmissionConfig = {
  // Keep the warm ceiling aligned with meta.warmPool.maxSuggestedSize. The
  // previous 4-process ceiling was lower than the default 5-session pool, so a
  // clean install could never reach its own saved target.
  maxProcesses: 16, maxWarmProcesses: 12, maxQueued: 32,
};
