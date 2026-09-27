import { z } from 'zod';

export const BACKGROUND_WORK_NAMESPACE = 'backgroundWork';
export const backgroundWorkConfigSchema = z.object({
  maxWorkers: z.number().int().positive(),
  maxQueued: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive(),
  workerMemoryMb: z.number().int().positive(),
});
export type BackgroundWorkConfig = z.infer<typeof backgroundWorkConfigSchema>;
export const backgroundWorkDefaults: BackgroundWorkConfig = {
  maxWorkers: 1,
  maxQueued: 16,
  timeoutMs: 60_000,
  workerMemoryMb: 256,
};
