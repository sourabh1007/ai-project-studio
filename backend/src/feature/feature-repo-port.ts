import type { Feature } from './feature-contract.js';

/** Persistence port for features. Implemented by the persistence module. */
export interface FeatureRepo {
  create(feature: Feature): void;
  get(id: string): Feature | null;
  list(): Feature[];
  setSummary(id: string, summary: string): void;
  rename(id: string, name: string): void;
  delete(id: string): void;
}
