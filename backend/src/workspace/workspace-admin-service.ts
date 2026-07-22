import { NotFoundError } from '../kernel/error-types.js';
import type { Feature } from '../feature/feature-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { UsageRepo } from '../usage/usage-repo-port.js';
import type { SummaryStore } from '../summarizer/summary-store-port.js';

/** Closes a live interactive terminal for a session, if one is running. */
export interface TerminalCloser {
  close(sessionId: string): void;
}

export interface WorkspaceAdminDeps {
  features: Pick<FeatureService, 'get' | 'rename' | 'remove'>;
  sessions: Pick<SessionRepo, 'get' | 'listByFeature' | 'delete' | 'deleteByFeature'>;
  usage: Pick<UsageRepo, 'deleteBySession'>;
  transcripts: Pick<TranscriptStore, 'delete'>;
  summaries: Pick<SummaryStore, 'delete'>;
  terminals: TerminalCloser;
}

/**
 * Orchestrates destructive workspace mutations that span multiple modules:
 * renaming a feature, and cascading deletion of a feature (with all its
 * sessions) or a single session — including tearing down any live terminal and
 * purging the session's usage events and transcript.
 */
export interface WorkspaceAdmin {
  renameFeature(id: string, name: string): Feature;
  deleteFeature(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

export function createWorkspaceAdmin(deps: WorkspaceAdminDeps): WorkspaceAdmin {
  async function purgeSession(sessionId: string): Promise<void> {
    deps.terminals.close(sessionId);
    deps.usage.deleteBySession(sessionId);
    await deps.transcripts.delete(sessionId);
  }

  return {
    renameFeature(id, name) {
      return deps.features.rename(id, name);
    },

    async deleteFeature(id) {
      deps.features.get(id);
      for (const session of deps.sessions.listByFeature(id)) {
        await purgeSession(session.id);
      }
      deps.sessions.deleteByFeature(id);
      deps.summaries.delete(id);
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
