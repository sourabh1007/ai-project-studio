import { NotFoundError } from '../kernel/error-types.js';
import type { Feature } from '../feature/feature-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { Session } from '../session/session-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { UsageRepo } from '../usage/usage-repo-port.js';
import type { SummaryStore } from '../summarizer/summary-store-port.js';
import type { SessionFilesStore } from '../session-files/session-files-contract.js';

/** Closes a live interactive terminal for a session, if one is running. */
export interface TerminalCloser {
  close(sessionId: string): void;
}

/** Removes any PR review artifact tied to a feature being deleted. */
export interface PrReviewRemover {
  removeForFeature(featureId: string): void;
}

export interface WorkspaceAdminDeps {
  features: Pick<FeatureService, 'get' | 'rename' | 'remove'>;
  sessions: Pick<SessionRepo, 'get' | 'listByFeature' | 'delete' | 'deleteByFeature' | 'rename'>;
  usage: Pick<UsageRepo, 'deleteBySession'>;
  transcripts: Pick<TranscriptStore, 'delete'>;
  summaries: Pick<SummaryStore, 'delete'>;
  sessionFiles: Pick<SessionFilesStore, 'deleteBySession'>;
  terminals: TerminalCloser;
  /** Optional: purges a feature's PR review when the feature is deleted. */
  prReviews?: PrReviewRemover;
}

/**
 * Orchestrates destructive workspace mutations that span multiple modules:
 * renaming a feature, and cascading deletion of a feature (with all its
 * sessions) or a single session — including tearing down any live terminal and
 * purging the session's usage events and transcript.
 */
export interface WorkspaceAdmin {
  renameFeature(id: string, name: string): Feature;
  renameSession(id: string, name: string | null): Session;
  deleteFeature(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

export function createWorkspaceAdmin(deps: WorkspaceAdminDeps): WorkspaceAdmin {
  async function purgeSession(sessionId: string): Promise<void> {
    deps.terminals.close(sessionId);
    deps.usage.deleteBySession(sessionId);
    deps.sessionFiles.deleteBySession(sessionId);
    await deps.transcripts.delete(sessionId);
  }

  return {
    renameFeature(id, name) {
      return deps.features.rename(id, name);
    },

    renameSession(id, name) {
      const session = deps.sessions.get(id);
      if (!session) {
        throw new NotFoundError(`Unknown session: ${id}`);
      }
      const trimmed = name?.trim();
      const next = trimmed ? trimmed : null;
      deps.sessions.rename(id, next);
      return { ...session, name: next };
    },

    async deleteFeature(id) {
      deps.features.get(id);
      for (const session of deps.sessions.listByFeature(id)) {
        await purgeSession(session.id);
      }
      deps.sessions.deleteByFeature(id);
      deps.summaries.delete(id);
      deps.prReviews?.removeForFeature(id);
      deps.features.remove(id);
    },

    async deleteSession(id) {
      const session = deps.sessions.get(id);
      if (!session) {
        throw new NotFoundError(`Unknown session: ${id}`);
      }
      await purgeSession(id);
      deps.sessions.delete(id);
    },
  };
}
