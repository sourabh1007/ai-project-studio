import { z } from 'zod';

/**
 * Configuration for the session-import feature, which lists past provider
 * sessions (from each provider's own store) and imports them into features.
 */
export const SESSION_IMPORT_NAMESPACE = 'sessionImport';

export const sessionImportConfigSchema = z.object({
  /** Max sessions listed per provider (newest first). */
  maxSessions: z.number().int().positive(),
  /** Max characters of a derived session title. */
  maxTitleChars: z.number().int().positive(),
  /** Title used when a session has neither a summary nor a first message. */
  emptyTitlePlaceholder: z.string().min(1),
});

export type SessionImportConfig = z.infer<typeof sessionImportConfigSchema>;

export const sessionImportDefaults: SessionImportConfig = {
  maxSessions: 100,
  maxTitleChars: 100,
  emptyTitlePlaceholder: '(untitled session)',
};
