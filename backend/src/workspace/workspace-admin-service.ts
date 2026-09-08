import { NotFoundError } from '../kernel/error-types.js';
import type { Feature } from '../feature/feature-contract.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { Session } from '../session/session-contract.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { TranscriptStore } from '../session/transcript-store-port.js';
import type { UsageRepo } from '../usage/usage-repo-port.js';
import type { SummaryStore } from '../summarizer/summary-store-port.js';
import type { SessionFilesStore } from '../session-files/session-files-contract.js';
import type { ContextService } from '../context-store/context-service.js';
import type { UsageCaptureRepo } from '../usage/usage-capture-contract.js';
import type { MetaUsageRepo } from '../meta/meta-usage-contract.js';
import type { MetaOperationRepo } from '../meta/meta-operation-contract.js';
import type { SessionSummaryStore } from '../session-summary/session-summary-store-port.js';

/** Closes a live interactive terminal for a session, if one is running. */
export interface TerminalCloser {
  close(sessionId: string): void;
}

/** Removes any PR review artifact tied to a feature being deleted. */
export interface PrReviewRemover {
  removeForFeature(featureId: string): void;
}

/**
 * Stops a session's live usage tailer immediately. Deletion kills the terminal
 * asynchronously, but the tailer keeps polling the CLI's usage store until the
 * PTY actually exits — long enough to re-record usage AFTER we purge it, which
 * both leaves a stray usage row behind and resurrects the just-deleted feature
 * in the live view (forcing a second delete). Releasing the tailer up front,
 * before purging usage, closes that race.
 */
export interface LiveUsageReleaser {
  release(sessionId: string): void;
}

/** Removes the on-disk git worktree a feature's PR review checked out into. */
export interface WorktreeRemover {
  removeForFeature(featureId: string): Promise<void>;
}

/** Removes owned monitor work before deleting its feature/session anchor. */
export interface OwnedAutomationRemover {
  deleteByFeature(featureId: string): void | Promise<void>;
  deleteBySession(sessionId: string): void | Promise<void>;
}

export interface WorkspaceQuiescence {
  /** Close admission, cancel producers and reject unless their completion has drained. */
  feature(featureId: string): Promise<void>;
  session(sessionId: string): Promise<void>;
}

/** Removes detached/external subagent artifacts bound to a feature/session. */
export interface OwnedSubagentRemover {
  deleteByFeature(featureId: string): void;
  deleteBySession(sessionId: string): void;
}

export interface WorkspaceAdminDeps {
  features: Pick<FeatureService, 'get' | 'rename' | 'remove'>;
  sessions: Pick<SessionRepo, 'get' | 'listByFeatureAll' | 'delete' | 'deleteByFeature' | 'rename'>;
  quiescence: WorkspaceQuiescence;
  usage: Pick<UsageRepo, 'deleteBySession'>;
  usageCaptures?: Pick<UsageCaptureRepo, 'deleteBySession'>;
  metaUsage?: Pick<MetaUsageRepo, 'deleteByFeature' | 'deleteBySession'>;
  metaOperations?: Pick<MetaOperationRepo, 'deleteByFeature' | 'deleteBySession'>;
  transcripts: Pick<TranscriptStore, 'delete'>;
  summaries: Pick<SummaryStore, 'delete'>;
  sessionSummaries?: Pick<SessionSummaryStore, 'delete'>;
  sessionFiles: Pick<SessionFilesStore, 'deleteBySession'>;
  terminals: TerminalCloser;
  /** Optional: stops a session's live usage tailer before its usage is purged. */
  liveUsage?: LiveUsageReleaser;
  /** Optional: purges a feature's PR review when the feature is deleted. */
  prReviews?: PrReviewRemover;
  /** Optional: removes a feature's PR review worktree from disk when deleted. */
  worktrees?: WorktreeRemover;
  /** Optional: purges a feature's shared-context document when it is deleted. */
  sharedContext?: Pick<ContextService, 'remove'>;
  /** Optional: cancels/removes automations owned by the deleted feature/session. */
  ownedAutomations?: OwnedAutomationRemover;
  /** Optional: removes detached subagent records owned by the deleted feature/session. */
  ownedSubagents?: OwnedSubagentRemover;
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
    await Promise.all([
      deps.quiescence.session(sessionId),
      deps.ownedAutomations?.deleteBySession(sessionId),
    ]);
    deps.ownedSubagents?.deleteBySession(sessionId);
    // Stop the live usage tailer FIRST so it cannot re-record usage after we
    // purge it (which would leave a stray row and resurrect the feature).
    deps.liveUsage?.release(sessionId);
    deps.terminals.close(sessionId);
    deps.usageCaptures?.deleteBySession(sessionId);
    deps.metaUsage?.deleteBySession(sessionId);
    deps.metaOperations?.deleteBySession(sessionId);
    deps.usage.deleteBySession(sessionId);
    deps.sessionFiles.deleteBySession(sessionId);
    deps.sessionSummaries?.delete(sessionId);
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
      await Promise.all([
        deps.quiescence.feature(id),
        deps.ownedAutomations?.deleteByFeature(id),
      ]);
      deps.ownedSubagents?.deleteByFeature(id);
      for (const session of deps.sessions.listByFeatureAll(id)) {
        await purgeSession(session.id);
      }
      deps.sessions.deleteByFeature(id);
      deps.metaUsage?.deleteByFeature(id);
      deps.metaOperations?.deleteByFeature(id);
      deps.summaries.delete(id);
      // Remove the on-disk worktree before purging the review row it is
      // resolved from; a failure here must not block feature deletion.
      if (deps.worktrees) {
        try {
          await deps.worktrees.removeForFeature(id);
        } catch {
          // Best-effort cleanup: leave an orphaned worktree rather than fail.
        }
      }
      deps.prReviews?.removeForFeature(id);
      deps.sharedContext?.remove('feature', id);
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
