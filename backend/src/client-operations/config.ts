import { z } from 'zod';

/**
 * Configuration for durable client operation keys (idempotent creates). A key
 * lets a client retry or reload after a lost response and receive the original
 * result instead of creating a duplicate.
 */
export const CLIENT_OPERATIONS_NAMESPACE = 'clientOperations';

export const clientOperationsConfigSchema = z.object({
  /** Request header carrying the opaque client operation key. */
  headerName: z.literal('idempotency-key'),
  /** Longest accepted key; keys are opaque tokens, never prompts or secrets. */
  maxKeyLength: z.number().int().min(64).max(512),
  /** How long a succeeded record can replay before it may be pruned. */
  retentionMs: z.number().int().positive(),
  /** Hard cap on stored records; unresolved (pending) records are never pruned to fit. */
  maxRecords: z.number().int().positive(),
  /** Most expired records removed per reservation, bounding prune work. */
  pruneBatch: z.number().int().positive(),
});

export type ClientOperationsConfig = z.infer<typeof clientOperationsConfigSchema>;

export const clientOperationsDefaults: ClientOperationsConfig = {
  headerName: 'idempotency-key',
  maxKeyLength: 128,
  retentionMs: 24 * 60 * 60 * 1000,
  maxRecords: 10_000,
  pruneBatch: 500,
};
