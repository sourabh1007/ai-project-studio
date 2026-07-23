import { z } from 'zod';
import { join } from 'node:path';
import { defaultWorkspaceDataDir } from '../workspace/workspace-paths.js';

/** Configuration schema for the persistence (SQLite) module. */
export const PERSISTENCE_NAMESPACE = 'persistence';

export const persistenceConfigSchema = z.object({
  /** SQLite database file path, or ':memory:' for an ephemeral store. */
  databasePath: z.string().min(1),
});

export type PersistenceConfig = z.infer<typeof persistenceConfigSchema>;

export const persistenceDefaults: PersistenceConfig = {
  databasePath: join(defaultWorkspaceDataDir(), 'workspace.db'),
};
