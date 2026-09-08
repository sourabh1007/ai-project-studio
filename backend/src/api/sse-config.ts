import { z } from 'zod';

export const SSE_NAMESPACE = 'sse';

export const sseConfigSchema = z.object({
  maxConnections: z.number().int().min(1).max(128),
  maxFrameBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  maxConnectionBytes: z.number().int().min(1).max(64 * 1024 * 1024),
  maxTotalBytes: z.number().int().min(1).max(512 * 1024 * 1024),
  blockedTimeoutMs: z.number().int().min(1).max(300_000),
}).refine((value) => value.maxFrameBytes <= value.maxConnectionBytes, {
  message: 'SSE frame limit must not exceed the connection limit',
}).refine((value) => value.maxConnectionBytes <= value.maxTotalBytes, {
  message: 'SSE connection limit must not exceed the total limit',
});

export type SseConfig = z.infer<typeof sseConfigSchema>;

export const sseDefaults: SseConfig = {
  maxConnections: 32,
  maxFrameBytes: 1024 * 1024,
  maxConnectionBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  blockedTimeoutMs: 30_000,
};
