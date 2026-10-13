import type { Repository } from './repo-contract.js';

/** Persistence port for repositories. Implemented by the persistence module. */
export interface RepoRepo {
  create(repo: Repository): void;
  get(id: string): Repository | null;
  list(): Repository[];
  delete(id: string): void;
  /** Re-points an existing repository at a new local checkout in place. */
  updateLocalPath(id: string, localPath: string, defaultBranch: string | null): void;
}
