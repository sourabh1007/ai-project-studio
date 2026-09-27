import { z } from 'zod';

export const ACTIVE_SESSIONS_NAMESPACE = 'activeSessions';
export const activeSessionsConfigSchema = z.object({
  pollMs: z.number().int().min(1000).max(60000),
  maxOperations: z.number().int().min(1).max(4096),
  maxActivityLines: z.number().int().min(1).max(200),
  maxTextCharacters: z.number().int().min(256).max(32000),
});
export type ActiveSessionsConfig = z.infer<typeof activeSessionsConfigSchema>;
export const activeSessionsDefaults: ActiveSessionsConfig = {
  pollMs: 3000, maxOperations: 512, maxActivityLines: 60, maxTextCharacters: 12000,
};
