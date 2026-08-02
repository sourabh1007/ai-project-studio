import type { Clock } from '../kernel/clock.js';
import { ConflictError, NotFoundError } from '../kernel/error-types.js';
import type { EventBus } from '../kernel/event-bus.js';
import type { RepoService } from '../repo/repo-service.js';
import type {
  RepositoryContext,
  RepositoryEvidence,
} from './repository-context-contract.js';
import type { RepositoryContextGenerator } from './repository-context-generator-port.js';
import type { RepositoryContextRepo } from './repository-context-repo-port.js';
import {
  createRepositoryContextStepTracker,
  initialRepositoryContextSteps,
} from './repository-context-steps.js';
import type { RepositoryRevisionLookup } from './repository-revision-port.js';

export type RepositoryContextEventMap = {
  'repository.context.updated': RepositoryContext;
};

export interface RepositoryContextCoordinator {
  get(repositoryId: string): RepositoryContext;
  load(repositoryId: string): Promise<RepositoryContext>;
  ensureFresh(repositoryId: string): Promise<RepositoryContext>;
  initialize(repositoryId: string): RepositoryContext;
  refresh(repositoryId: string): RepositoryContext;
  synchronizeSaved(): Promise<void>;
  remove(repositoryId: string): void;
}

export interface RepositoryContextCoordinatorDeps {
  repositories: RepoService;
  contexts: RepositoryContextRepo;
  revisions: RepositoryRevisionLookup;
  evidence: {
    collect(repositoryPath: string): Promise<RepositoryEvidence>;
  };
  generator: RepositoryContextGenerator;
  clock: Clock;
  bus: EventBus<RepositoryContextEventMap>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Repository analysis failed';
}

/** Coordinates persisted repository analysis lifecycle and background work. */
export function createRepositoryContextCoordinator(
  deps: RepositoryContextCoordinatorDeps,
): RepositoryContextCoordinator {
  const inFlight = new Map<string, Promise<void>>();
  const freshnessChecks = new Map<string, Promise<RepositoryContext>>();
  const removed = new Set<string>();

  const publish = (context: RepositoryContext): RepositoryContext => {
    deps.contexts.save(context);
    deps.bus.emit('repository.context.updated', context);
    return context;
  };

  const pending = (repositoryId: string): RepositoryContext => {
    const now = deps.clock.isoNow();
    return publish({
      repositoryId,
      status: 'pending',
      content: null,
      sourceRevision: null,
      timestamps: {
        createdAt: now,
        updatedAt: now,
        generationStartedAt: null,
        generatedAt: null,
      },
      steps: [],
      failure: null,
    });
  };

  const start = (repositoryId: string): RepositoryContext => {
    const existing = deps.contexts.get(repositoryId) ?? pending(repositoryId);
    const startedAt = deps.clock.isoNow();
    let current = publish({
      ...existing,
      status: 'generating',
      steps: initialRepositoryContextSteps(),
      timestamps: {
        ...existing.timestamps,
        updatedAt: startedAt,
        generationStartedAt: startedAt,
      },
      failure: null,
    });
    const repository = deps.repositories.get(repositoryId);
    const tracker = createRepositoryContextStepTracker({
      clock: deps.clock,
      onChange: (steps) => {
        if (removed.has(repositoryId)) return;
        current = publish({
          ...current,
          steps,
          timestamps: { ...current.timestamps, updatedAt: deps.clock.isoNow() },
        });
      },
    });
    const job = (async () => {
      try {
        const evidence = await tracker.run('collect-evidence', async (report) => {
          const collected = await deps.evidence.collect(repository.localPath);
          report(
            `${collected.sourceRevision.slice(0, 12)} · ${collected.totalFileCount} files, ${collected.totalContentChars} chars`,
          );
          return collected;
        });
        const result = await tracker.run('analyze', (report) =>
          deps.generator.generate(
            {
              repositoryId,
              repositoryPath: repository.localPath,
              evidence,
            },
            report,
          ),
        );
        const content = await tracker.run('persist', async () => result.content);
        if (removed.has(repositoryId)) return;
        const completedAt = deps.clock.isoNow();
        publish({
          ...current,
          status: 'ready',
          content,
          sourceRevision: evidence.sourceRevision,
          steps: tracker.snapshot(),
          timestamps: {
            ...current.timestamps,
            updatedAt: completedAt,
            generatedAt: completedAt,
          },
          failure: null,
        });
      } catch (error) {
        if (removed.has(repositoryId)) return;
        const failedAt = deps.clock.isoNow();
        publish({
          ...current,
          status: 'failed',
          steps: tracker.snapshot(),
          timestamps: {
            ...current.timestamps,
            updatedAt: failedAt,
          },
          failure: {
            code: 'generation_failed',
            message: errorMessage(error),
            failedAt,
            retryable: true,
            step: tracker.failedStepKey(),
          },
        });
      }
    })().finally(() => {
      inFlight.delete(repositoryId);
    });
    inFlight.set(repositoryId, job);
    return current;
  };

  const ensureFresh = (repositoryId: string): Promise<RepositoryContext> => {
    const existingCheck = freshnessChecks.get(repositoryId);
    if (existingCheck) {
      return existingCheck;
    }

    const check = (async () => {
      const repository = deps.repositories.get(repositoryId);
      let context = deps.contexts.get(repositoryId);
      if (!context) {
        context = pending(repositoryId);
        start(repositoryId);
        return deps.contexts.get(repositoryId) as RepositoryContext;
      }
      if (inFlight.has(repositoryId)) {
        return context;
      }

      try {
        const revision = await deps.revisions.getRevision(repository.localPath);
        const latest = deps.contexts.get(repositoryId) as RepositoryContext;
        if (latest.sourceRevision !== revision) {
          const now = deps.clock.isoNow();
          publish({
            ...latest,
            status: 'stale',
            timestamps: { ...latest.timestamps, updatedAt: now },
            failure: null,
          });
          if (!inFlight.has(repositoryId)) {
            start(repositoryId);
          }
        } else if (
          latest.status === 'pending' ||
          latest.status === 'stale' ||
          latest.status === 'generating'
        ) {
          if (!inFlight.has(repositoryId)) {
            start(repositoryId);
          }
        }
      } catch (error) {
        const latest = deps.contexts.get(repositoryId) as RepositoryContext;
        const failedAt = deps.clock.isoNow();
        publish({
          ...latest,
          status: 'failed',
          timestamps: { ...latest.timestamps, updatedAt: failedAt },
          failure: {
            code: 'revision_lookup_failed',
            message: errorMessage(error),
            failedAt,
            retryable: true,
            step: null,
          },
        });
      }
      return deps.contexts.get(repositoryId) as RepositoryContext;
    })().finally(() => {
      freshnessChecks.delete(repositoryId);
    });
    freshnessChecks.set(repositoryId, check);
    return check;
  };

  return {
    get(repositoryId) {
      deps.repositories.get(repositoryId);
      const context = deps.contexts.get(repositoryId);
      if (!context) {
        throw new NotFoundError(
          `Repository context is not available: ${repositoryId}`,
        );
      }
      return context;
    },
    load: ensureFresh,
    ensureFresh,
    initialize(repositoryId) {
      deps.repositories.get(repositoryId);
      removed.delete(repositoryId);
      const context = deps.contexts.get(repositoryId) ?? pending(repositoryId);
      if (!inFlight.has(repositoryId)) {
        start(repositoryId);
      }
      return context;
    },
    refresh(repositoryId) {
      deps.repositories.get(repositoryId);
      if (inFlight.has(repositoryId)) {
        throw new ConflictError(
          `Repository context generation is already running: ${repositoryId}`,
        );
      }
      removed.delete(repositoryId);
      return start(repositoryId);
    },
    async synchronizeSaved() {
      for (const repository of deps.repositories.list()) {
        await ensureFresh(repository.id);
      }
    },
    remove(repositoryId) {
      removed.add(repositoryId);
      freshnessChecks.delete(repositoryId);
      deps.contexts.delete(repositoryId);
    },
  };
}
