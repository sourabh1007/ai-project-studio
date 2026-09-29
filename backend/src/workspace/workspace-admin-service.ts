import { NotFoundError } from '../kernel/error-types.js';
import { resolve } from 'node:path';
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
import type { McpUsageRepo } from '../mcp-usage/mcp-usage-contract.js';
import type { MetaOperationRepo } from '../meta/meta-operation-contract.js';
import type { SessionSummaryStore } from '../session-summary/session-summary-store-port.js';
import type { Clock } from '../kernel/clock.js';
import type {
  RetainedUsageWriter,
  RetentionReason,
} from '../usage-retention/usage-retention-contract.js';

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
  pathForFeature?(featureId: string): string | null;
}

/** Removes an individual session's dedicated git worktree by its path. */
export interface SessionWorktreeRemover {
  remove(worktreePath: string): Promise<void>;
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

/** Removes agent attachments bound to a feature when the feature is deleted. */
export interface OwnedAgentRemover {
  deleteByFeature(featureId: string): void;
}

export interface WorkspaceAdminDeps {
  features: Pick<FeatureService, 'get' | 'list' | 'rename' | 'remove'>;
  sessions: Pick<SessionRepo, 'get' | 'listByFeatureAll' | 'delete' | 'deleteByFeature' | 'rename'>;
  quiescence: WorkspaceQuiescence;
  usage: Pick<UsageRepo, 'deleteBySession'>;
  usageCaptures?: Pick<UsageCaptureRepo, 'deleteBySession'>;
  /**
   * Optional: summarizes a session's usage into the durable retention ledger
   * BEFORE its live rows are purged, so month/year totals never drop on delete.
   */
  retainedUsage?: RetainedUsageWriter;
  /** Optional: timestamps retention rows; required alongside `retainedUsage`. */
  clock?: Pick<Clock, 'isoNow'>;
  metaUsage?: Pick<MetaUsageRepo, 'deleteByFeature' | 'deleteBySession'>;
  metaOperations?: Pick<MetaOperationRepo, 'deleteByFeature' | 'deleteBySession'>;
  /** Optional: purges proxy-measured MCP server usage on feature/session delete. */
  mcpUsage?: Pick<McpUsageRepo, 'deleteByFeature' | 'deleteBySession'>;
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
  /**
   * Optional: removes each descendant session's own dedicated worktree from
   * disk when its FEATURE is deleted. Deliberately unused by single-session
   * deletion — deleting one session leaves its worktree in place; only removing
   * the whole feature reclaims its sessions' worktrees.
   */
  sessionWorktrees?: SessionWorktreeRemover;
  /**
   * Optional: reads the branch checked out at a path, used only to describe the
   * exact local branch copies a feature deletion would remove (the consent
   * preview). Never required for the deletion itself.
   */
  readBranch?: (path: string) => Promise<string | null>;
  /** Optional: purges a feature's shared-context document when it is deleted. */
  sharedContext?: Pick<ContextService, 'remove'>;
  /** Optional: cancels/removes automations owned by the deleted feature/session. */
  ownedAutomations?: OwnedAutomationRemover;
  /** Optional: removes detached subagent records owned by the deleted feature/session. */
  ownedSubagents?: OwnedSubagentRemover;
  /** Optional: removes agent attachments owned by the deleted feature. */
  ownedAgents?: OwnedAgentRemover;
  /**
   * Optional: schedules slow, best-effort teardown (the on-disk git worktree
   * removal and its dependent PR-review row purge) to run detached from the
   * caller. When omitted the work runs inline. Deletion of the feature records
   * always completes synchronously so the UI reflects the removal immediately;
   * only this background work — which touches git and the filesystem — is
   * deferred so a bulk review with many PR worktrees never blocks the UI.
   */
  background?: (task: () => Promise<void>) => void;
}

/**
 * One on-disk worktree a feature deletion would remove — a descendant session's
 * dedicated worktree, or the feature's own PR-review checkout — described by the
 * exact local branch it holds so the user can consent before it is destroyed.
 */
export interface FeatureDeletionWorktree {
  /** The feature the worktree belongs to. */
  featureId: string;
  /** The session that owns the worktree, or null for a feature PR checkout. */
  sessionId: string | null;
  /** Absolute path of the worktree that would be removed. */
  path: string;
  /** The branch/ref checked out there, when known. */
  branch: string | null;
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
  /**
   * Lists every on-disk worktree deleting `id` (and its descendants) would
   * remove, so the UI can name the exact local branch copies and get consent
   * before the destructive delete. Read-only.
   */
  previewFeatureDeletion(id: string): Promise<FeatureDeletionWorktree[]>;
  deleteFeature(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

export function createWorkspaceAdmin(deps: WorkspaceAdminDeps): WorkspaceAdmin {
  function featureNameOf(featureId: string): string | null {
    try {
      return deps.features.get(featureId).name;
    } catch {
      return null;
    }
  }

  async function purgeSession(
    session: Session,
    reason: RetentionReason,
  ): Promise<void> {
    const sessionId = session.id;
    await Promise.all([
      deps.quiescence.session(sessionId),
      deps.ownedAutomations?.deleteBySession(sessionId),
    ]);
    deps.ownedSubagents?.deleteBySession(sessionId);
    // Stop the live usage tailer FIRST so it cannot re-record usage after we
    // purge it (which would leave a stray row and resurrect the feature).
    deps.liveUsage?.release(sessionId);
    deps.terminals.close(sessionId);
    // Summarize the session's usage into the durable ledger BEFORE deleting the
    // live rows, so deletion prunes history without shrinking month/year totals.
    if (deps.retainedUsage && deps.clock) {
      deps.retainedUsage.summarizeSession({
        sessionId,
        featureId: session.featureId,
        featureName: featureNameOf(session.featureId),
        sessionKind: session.kind,
        scope: session.scope ?? 'feature',
        reason,
        retainedAt: deps.clock.isoNow(),
      });
    }
    deps.usageCaptures?.deleteBySession(sessionId);
    deps.metaUsage?.deleteBySession(sessionId);
    deps.metaOperations?.deleteBySession(sessionId);
    deps.mcpUsage?.deleteBySession(sessionId);
    deps.usage.deleteBySession(sessionId);
    deps.sessionFiles.deleteBySession(sessionId);
    deps.sessionSummaries?.delete(sessionId);
    await deps.transcripts.delete(sessionId);
  }

  /**
   * Tears down a single feature: cancels its owned work, purges its sessions
   * and usage, deletes the record synchronously, then schedules removal of its
   * on-disk PR worktree in the background. Shared by direct deletion and the
   * bulk-review cascade below.
   */
  async function purgeFeature(id: string): Promise<void> {
    await Promise.all([
      deps.quiescence.feature(id),
      deps.ownedAutomations?.deleteByFeature(id),
    ]);
    deps.ownedSubagents?.deleteByFeature(id);
    deps.ownedAgents?.deleteByFeature(id);
    // Gather each session's own worktree BEFORE its record is purged so the
    // background teardown can reclaim them — a feature deletion removes its
    // sessions' worktrees (a single-session delete never does).
    const sessionWorktreePaths = new Map<string, string>();
    const reviewPath = deps.worktrees?.pathForFeature?.(id);
    const keyOf = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    for (const session of deps.sessions.listByFeatureAll(id)) {
      if (session.worktreePath && (!reviewPath || keyOf(session.worktreePath) !== keyOf(reviewPath))) {
        sessionWorktreePaths.set(keyOf(session.worktreePath), session.worktreePath);
      }
      await purgeSession(session, 'feature-deleted');
    }
    deps.sessions.deleteByFeature(id);
    deps.metaUsage?.deleteByFeature(id);
    deps.metaOperations?.deleteByFeature(id);
    deps.mcpUsage?.deleteByFeature(id);
    deps.summaries.delete(id);
    deps.sharedContext?.remove('feature', id);
    // Record removal is synchronous so the feature disappears from the UI at
    // once. The slow git/filesystem worktree teardown — and the PR-review row
    // it is resolved from — run in the background so deletion never blocks.
    deps.features.remove(id);
    const removeWorktree = async (): Promise<void> => {
      const failures: unknown[] = [];
      if (deps.worktrees) {
        try {
          await deps.worktrees.removeForFeature(id);
        } catch (error) {
          failures.push(error);
        }
      }
      for (const path of sessionWorktreePaths.values()) {
        try {
          await deps.sessionWorktrees?.remove(path);
        } catch (error) {
          failures.push(error);
        }
      }
      // The PR-review row is only a DB record, so purge it regardless of whether
      // the on-disk worktree teardown succeeded. The worktree remover resolves
      // its path FROM this row, so it must run after the removal is attempted —
      // but leaving the row behind on a (Windows-common) cleanup failure orphans
      // the review, resurrecting the deleted PR review in the pending queue and
      // via findByPull after a restart. Always drop it, then surface failures.
      deps.prReviews?.removeForFeature(id);
      if (failures.length > 0) {
        throw new AggregateError(failures, `Feature ${id} was deleted, but worktree cleanup failed. Retry removal in Settings.`);
      }
    };
    if (deps.background) {
      deps.background(removeWorktree);
    } else {
      await removeWorktree();
    }
  }

  /**
   * Resolves a feature and every descendant (child PR features of a "Bulk PR
   * Review", and any deeper nesting) in post-order — children before their
   * parent — so each is torn down, and its worktree removed, before the ancestor
   * that anchors them. Each feature has a single parent, so descendants form a
   * tree; a self-parent edge is ignored so a malformed record cannot loop.
   */
  function featureSubtreePostOrder(rootId: string): string[] {
    const childrenByParent = new Map<string, string[]>();
    for (const feature of deps.features.list()) {
      const parentId = feature.parentFeatureId;
      if (parentId && parentId !== feature.id) {
        const siblings = childrenByParent.get(parentId) ?? [];
        siblings.push(feature.id);
        childrenByParent.set(parentId, siblings);
      }
    }
    const order: string[] = [];
    const visit = (id: string): void => {
      for (const child of childrenByParent.get(id) ?? []) {
        visit(child);
      }
      order.push(id);
    };
    visit(rootId);
    return order;
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

    async previewFeatureDeletion(id) {
      deps.features.get(id);
      const worktrees: FeatureDeletionWorktree[] = [];
      for (const featureId of featureSubtreePostOrder(id)) {
        let checkoutPath: string | undefined;
        try {
          checkoutPath = deps.features.get(featureId).checkoutPath ?? undefined;
        } catch {
          checkoutPath = undefined;
        }
        if (checkoutPath) {
          const branch = deps.readBranch
            ? await deps.readBranch(checkoutPath)
            : null;
          worktrees.push({
            featureId,
            sessionId: null,
            path: checkoutPath,
            branch,
          });
        }
        for (const session of deps.sessions.listByFeatureAll(featureId)) {
          if (session.worktreePath) {
            worktrees.push({
              featureId,
              sessionId: session.id,
              path: session.worktreePath,
              branch: session.branch ?? null,
            });
          }
        }
      }
      return worktrees;
    },

    async deleteFeature(id) {
      deps.features.get(id);
      // A "Bulk PR Review" is a parent feature whose child PR features each own
      // a git worktree. Deleting the parent (directly) — or an ancestor
      // (indirectly) — must cascade to every descendant so their worktrees are
      // torn down, not orphaned on disk. Children are purged before the parent.
      for (const featureId of featureSubtreePostOrder(id)) {
        await purgeFeature(featureId);
      }
    },

    async deleteSession(id) {
      const session = deps.sessions.get(id);
      if (!session) {
        throw new NotFoundError(`Unknown session: ${id}`);
      }
      await purgeSession(session, 'session-deleted');
      deps.sessions.delete(id);
    },
  };
}
