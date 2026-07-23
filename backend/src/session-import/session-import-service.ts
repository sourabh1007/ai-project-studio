import { ConflictError, NotFoundError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { ImportableSession } from '../provider/provider-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { SessionConfig } from '../session/config.js';
import { buildUsageFilePath } from '../session/session-paths.js';
import type { Session } from '../session/session-contract.js';
import type {
  SessionImportService,
} from './session-import-contract.js';

export interface SessionImportServiceDeps {
  providers: ProviderRegistry;
  sessions: SessionRepo;
  features: FeatureService;
  clock: Clock;
  config: SessionConfig;
}

/**
 * Aggregates importable sessions from every provider that supports the
 * capability and materializes an imported session as a persisted `Session`
 * whose id equals the provider-native session id — so the CLI history, work
 * summary and checkpoints (all keyed by that id) light up automatically.
 */
export function createSessionImportService(
  deps: SessionImportServiceDeps,
): SessionImportService {
  function fromProvider(providerId: string): ImportableSession[] {
    const provider = deps.providers.get(providerId);
    return provider.listImportableSessions?.() ?? [];
  }

  return {
    listImportable() {
      const imported = new Set(deps.sessions.listAll().map((s) => s.id));
      const all = deps.providers
        .ids()
        .flatMap((id) => fromProvider(id))
        .filter((candidate) => !imported.has(candidate.externalId));
      return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    import({ featureId, provider, externalId }) {
      // Validates the feature exists (throws NotFoundError otherwise).
      deps.features.get(featureId);

      const candidate = fromProvider(provider).find(
        (s) => s.externalId === externalId,
      );
      if (!candidate) {
        throw new NotFoundError(
          `Session '${externalId}' is not importable from provider '${provider}'`,
        );
      }
      if (deps.sessions.get(externalId)) {
        throw new ConflictError(`Session already imported: ${externalId}`);
      }

      const session: Session = {
        id: externalId,
        featureId,
        provider,
        requestedModel: candidate.model ?? 'auto',
        resolvedModel: candidate.model,
        status: 'completed',
        kind: 'dev',
        prompt: candidate.title,
        usageFilePath: buildUsageFilePath(deps.config, externalId),
        createdAt: candidate.createdAt,
        startedAt: candidate.createdAt,
        endedAt: candidate.updatedAt,
        exitCode: 0,
      };
      deps.sessions.save(session);
      return session;
    },
  };
}
