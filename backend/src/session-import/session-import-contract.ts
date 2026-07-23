import type { ImportableSession } from '../provider/provider-contract.js';
import type { Session } from '../session/session-contract.js';

export type { ImportableSession };

/** Request to import one provider-native session into a feature. */
export interface ImportSessionRequest {
  featureId: string;
  provider: string;
  externalId: string;
}

/**
 * Surfaces past provider-native sessions and imports them into features. Import
 * is a provider capability: any provider that implements
 * {@link IAIProvider.listImportableSessions} contributes to the list, so new
 * providers extend it without touching this service (open/closed).
 */
export interface SessionImportService {
  /** Importable sessions across all providers, excluding already-imported. */
  listImportable(): ImportableSession[];
  /** Imports one external session into a feature and returns the new Session. */
  import(request: ImportSessionRequest): Session;
}
