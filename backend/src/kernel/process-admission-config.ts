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
  maxProcesses: 8, maxWarmProcesses: 4, maxQueued: 32,
};
