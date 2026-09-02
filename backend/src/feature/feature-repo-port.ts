import type { Feature } from './feature-contract.js';

/** Persistence port for features. Implemented by the persistence module. */
export interface FeatureRepo {
  create(feature: Feature): void;
  get(id: string): Feature | null;
  list(): Feature[];
  setSummary(id: string, summary: string): void;
  rename(id: string, name: string): void;
  /** Re-homes a feature to a repository group and parent at a given sort position. */
  updatePlacement(
    id: string,
    placement: {
      repoId: string | null;
      parentFeatureId: string | null;
      orderIndex: number;
    },
  ): void;
  delete(id: string): void;
}
