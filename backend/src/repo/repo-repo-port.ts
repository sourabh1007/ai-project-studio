import type { Repository } from './repo-contract.js';

/** Persistence port for repositories. Implemented by the persistence module. */
export interface RepoRepo {
  create(repo: Repository): void;
  get(id: string): Repository | null;
  list(): Repository[];
  delete(id: string): void;
}
