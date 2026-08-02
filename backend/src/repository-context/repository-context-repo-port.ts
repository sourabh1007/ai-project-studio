import type { RepositoryContext } from './repository-context-contract.js';

/** Persistence port for repository context and its lifecycle state. */
export interface RepositoryContextRepo {
  get(repositoryId: string): RepositoryContext | null;
  list(): RepositoryContext[];
  save(context: RepositoryContext): void;
  delete(repositoryId: string): void;
}
