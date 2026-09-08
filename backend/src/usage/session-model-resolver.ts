import type { Session } from '../session/session-contract.js';
import type { UsageRepo, StoredUsage } from './usage-repo-port.js';

interface UsageWatermark {
  startedAt: string;
  turnIndex: number;
  authoritativeLock: boolean;
}

interface SessionModelUsageObservation {
  sessionId: string;
  resolvedModel: string;
  turnIndex: number;
  startedAt: string;
}

export interface SessionModelResolverDeps {
  sessions: Pick<{ get(id: string): Session | null; save(session: Session): void }, 'get' | 'save'>;
  usage: Pick<UsageRepo, 'listBySession'>;
  publish?: (session: Session) => void;
}

function compareUsageChronology(
  left: Pick<StoredUsage, 'startedAt' | 'turnIndex'>,
  right: Pick<StoredUsage, 'startedAt' | 'turnIndex'>,
): number {
  if (left.startedAt !== right.startedAt) {
    return left.startedAt > right.startedAt ? 1 : -1;
  }
  if (left.turnIndex !== right.turnIndex) {
    return left.turnIndex > right.turnIndex ? 1 : -1;
  }
  return 0;
}

function latestUsage(
  usage: readonly StoredUsage[],
): Pick<StoredUsage, 'startedAt' | 'turnIndex'> | null {
  let latest: Pick<StoredUsage, 'startedAt' | 'turnIndex'> | null = null;
  for (const event of usage) {
    if (latest === null || compareUsageChronology(event, latest) > 0) {
      latest = event;
    }
  }
  return latest;
}

/**
 * Keeps the session row's resolved model aligned with the freshest trustworthy
 * signal. Live provider model-change announcements are authoritative in the
 * moment, while replayed usage corrections must never regress the current
 * model by reprocessing older rows out of order during durable reconciliation.
 */
export function createSessionModelResolver(
  deps: SessionModelResolverDeps,
): {
  observeAuthoritative(sessionId: string, resolvedModel: string): void;
  observeUsage(event: SessionModelUsageObservation): void;
} {
  const watermarks = new Map<string, UsageWatermark>();

  const publishResolvedModel = (sessionId: string, resolvedModel: string): void => {
    const stored = deps.sessions.get(sessionId);
    if (!stored || stored.resolvedModel === resolvedModel) {
      return;
    }
    const updated = { ...stored, resolvedModel };
    deps.sessions.save(updated);
    deps.publish?.(updated);
  };

  const watermarkFor = (sessionId: string): UsageWatermark | null => {
    const known = watermarks.get(sessionId);
    if (known) {
      return known;
    }
    const seeded = latestUsage(deps.usage.listBySession(sessionId));
    if (!seeded) {
      return null;
    }
    const watermark: UsageWatermark = { ...seeded, authoritativeLock: false };
    watermarks.set(sessionId, watermark);
    return watermark;
  };

  return {
    observeAuthoritative(sessionId, resolvedModel) {
      const watermark = watermarkFor(sessionId);
      if (watermark) {
        watermark.authoritativeLock = true;
      } else {
        watermarks.set(sessionId, {
          startedAt: '',
          turnIndex: -1,
          authoritativeLock: true,
        });
      }
      publishResolvedModel(sessionId, resolvedModel);
    },
    observeUsage(event) {
      const watermark = watermarkFor(event.sessionId);
      if (watermark === null) {
        watermarks.set(event.sessionId, {
          startedAt: event.startedAt,
          turnIndex: event.turnIndex,
          authoritativeLock: false,
        });
        publishResolvedModel(event.sessionId, event.resolvedModel);
        return;
      }
      const comparison = compareUsageChronology(event, watermark);
      if (comparison < 0 || (comparison === 0 && watermark.authoritativeLock)) {
        return;
      }
      if (comparison > 0) {
        watermark.startedAt = event.startedAt;
        watermark.turnIndex = event.turnIndex;
        watermark.authoritativeLock = false;
      }
      publishResolvedModel(event.sessionId, event.resolvedModel);
    },
  };
}
