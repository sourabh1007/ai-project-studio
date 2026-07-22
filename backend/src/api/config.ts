import { z } from 'zod';

/** Configuration schema for the HTTP API layer. */
export const API_NAMESPACE = 'api';

export const apiConfigSchema = z.object({
  /** Interface the HTTP server binds to. */
  host: z.string().min(1),
  /** TCP port the HTTP server listens on. */
  port: z.number().int().min(0).max(65535),
  /** Path prefix under which all routes are mounted. */
  basePath: z.string().min(1),
  /** Interval between SSE keep-alive comments, in milliseconds. */
  sseHeartbeatMs: z.number().int().positive(),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export const apiDefaults: ApiConfig = {
  host: '127.0.0.1',
  port: 4319,
  basePath: '/api',
  sseHeartbeatMs: 15000,
};
