import { NotFoundError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type {
  Feature,
  CreateFeatureInput,
  MoveFeatureInput,
} from './feature-contract.js';
import type { FeatureRepo } from './feature-repo-port.js';

export interface FeatureServiceDeps {
  repo: FeatureRepo;
  ids: IdGenerator;
  clock: Clock;
  /** Validates a target repository exists (throws NotFoundError otherwise). */
  repos: { get(id: string): unknown };
}

export interface FeatureService {
  create(input: CreateFeatureInput): Feature;
  /**
   * Seeds a default "Scratchpad" feature when the workspace has no features
   * yet, so a fresh instance can start ad-hoc sessions without first creating a
   * feature. A no-op once any feature exists.
   */
  ensureScratchpad(): void;
  get(id: string): Feature;
  list(): Feature[];
  attachSummary(id: string, summary: string): Feature;
  rename(id: string, name: string): Feature;
  /** Reorders a feature within, or moves it between, repository groups. */
  moveFeature(input: MoveFeatureInput): void;
  remove(id: string): void;
}

/** Application service for features: builds records and enforces existence. */
export function createFeatureService(deps: FeatureServiceDeps): FeatureService {
  const requireFeature = (id: string): Feature => {
    const feature = deps.repo.get(id);
    if (!feature) {
      throw new NotFoundError(`Unknown feature: ${id}`);
    }
    return feature;
  };

  const persist = (input: CreateFeatureInput): Feature => {
    const feature: Feature = {
      id: deps.ids.next(),
      name: input.name,
      description: input.description,
      createdAt: deps.clock.isoNow(),
      summary: null,
      repoId: input.repoId ?? null,
      checkoutPath: input.checkoutPath ?? null,
      parentFeatureId: input.parentFeatureId ?? null,
    };
    deps.repo.create(feature);
    return feature;
  };

  return {
    create(input) {
      return persist(input);
    },
    ensureScratchpad() {
      if (deps.repo.list().length > 0) {
        return;
      }
      persist({
        name: 'Scratchpad',
        description:
          'Quick, ad-hoc CLI runs. Start a session here without setting up a feature first.',
      });
    },
    get(id) {
      return requireFeature(id);
    },
    list() {
      return deps.repo.list();
    },
    attachSummary(id, summary) {
      requireFeature(id);
      deps.repo.setSummary(id, summary);
      return requireFeature(id);
    },
    rename(id, name) {
      requireFeature(id);
      deps.repo.rename(id, name);
      return requireFeature(id);
    },
    moveFeature(input) {
      requireFeature(input.id);
      const targetRepoId = input.targetRepoId ?? null;
      if (targetRepoId !== null) {
        deps.repos.get(targetRepoId);
      }
      const siblings = deps.repo
        .list()
        .filter(
          (feature) =>
            (feature.repoId ?? null) === targetRepoId && feature.id !== input.id,
        )
        .sort(
          (left, right) =>
            (left.orderIndex ?? 0) - (right.orderIndex ?? 0) ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        );
      const index = Math.max(0, Math.min(input.targetIndex, siblings.length));
      const ordered = [
        ...siblings.slice(0, index),
        { id: input.id },
        ...siblings.slice(index),
      ];
      ordered.forEach((feature, position) => {
        deps.repo.updatePlacement(feature.id, {
          repoId: targetRepoId,
          orderIndex: position,
        });
      });
    },
    remove(id) {
      requireFeature(id);
      deps.repo.delete(id);
    },
  };
}
