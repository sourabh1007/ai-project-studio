import type { FeatureService } from '../feature/feature-service.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { ContextConfig } from './config.js';
import type { ContextDocument, ContextScope } from './context-contract.js';

export interface ContextBroadcasterDeps {
  features: Pick<FeatureService, 'list'>;
  sessions: Pick<SessionRepo, 'listByFeature'>;
  /** Live-push vehicle; returns false when the session has no live terminal. */
  inject: (sessionId: string, instructions: string) => boolean;
  config: Pick<ContextConfig, 'livePushNoteTemplate'>;
}

export interface ContextBroadcaster {
  /** Handler for context writes; pushes a short note into affected sessions. */
  onUpdated(doc: ContextDocument): void;
}

/**
 * Live-pushes context changes into already-running sessions so long-lived
 * sessions pick up new shared knowledge without a relaunch. Scope cascades
 * downward: a workspace change reaches every running session, a repo change
 * reaches that repo's features, and a feature change reaches that feature only.
 */
export function createContextBroadcaster(
  deps: ContextBroadcasterDeps,
): ContextBroadcaster {
  const featureIdsFor = (scope: ContextScope, scopeId: string): string[] => {
    if (scope === 'feature') {
      return [scopeId];
    }
    const features = deps.features.list();
    if (scope === 'repo') {
      return features
        .filter((feature) => feature.repoId === scopeId)
        .map((feature) => feature.id);
    }
    return features.map((feature) => feature.id);
  };

  return {
    onUpdated(doc) {
      const note = deps.config.livePushNoteTemplate
        .split('{{scope}}')
        .join(doc.scope);
      const seen = new Set<string>();
      for (const featureId of featureIdsFor(doc.scope, doc.scopeId)) {
        for (const session of deps.sessions.listByFeature(featureId)) {
          if (session.status !== 'running' || seen.has(session.id)) {
            continue;
          }
          seen.add(session.id);
          deps.inject(session.id, note);
        }
      }
    },
  };
}
