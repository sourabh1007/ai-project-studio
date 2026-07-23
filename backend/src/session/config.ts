import { z } from 'zod';
import { join } from 'node:path';
import { defaultWorkspaceDataDir } from '../workspace/workspace-paths.js';

/** Configuration schema for the session orchestration module. */
export const SESSION_NAMESPACE = 'session';

export const sessionConfigSchema = z.object({
  /** Default session kind when a request does not specify one. */
  defaultKind: z.enum(['dev', 'meta']),
  /** Directory where per-session OpenTelemetry usage files are written. */
  usageDir: z.string().min(1),
  /** File extension for per-session usage files. */
  usageFileExtension: z.string().min(1),
});

export type SessionConfig = z.infer<typeof sessionConfigSchema>;

export const sessionDefaults: SessionConfig = {
  defaultKind: 'dev',
  usageDir: join(defaultWorkspaceDataDir(), 'usage'),
  usageFileExtension: '.jsonl',
};
