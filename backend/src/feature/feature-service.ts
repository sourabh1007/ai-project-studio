import { NotFoundError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type { Feature, CreateFeatureInput } from './feature-contract.js';
import type { FeatureRepo } from './feature-repo-port.js';

export interface FeatureServiceDeps {
  repo: FeatureRepo;
  ids: IdGenerator;
  clock: Clock;
}

export interface FeatureService {
  create(input: CreateFeatureInput): Feature;
  get(id: string): Feature;
  list(): Feature[];
  attachSummary(id: string, summary: string): Feature;
  rename(id: string, name: string): Feature;
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

  return {
    create(input) {
      const feature: Feature = {
        id: deps.ids.next(),
        name: input.name,
        description: input.description,
        createdAt: deps.clock.isoNow(),
        summary: null,
      };
      deps.repo.create(feature);
      return feature;
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
    remove(id) {
      requireFeature(id);
      deps.repo.delete(id);
    },
  };
}
