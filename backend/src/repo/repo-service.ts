import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { IdGenerator } from '../kernel/id-generator.js';
import type { CreateRepositoryInput, Repository } from './repo-contract.js';
import type { RepoRepo } from './repo-repo-port.js';

export interface RepoServiceDeps {
  repo: RepoRepo;
  ids: IdGenerator;
  clock: Clock;
}

export interface RepoService {
  create(input: CreateRepositoryInput): Repository;
  get(id: string): Repository;
  list(): Repository[];
  remove(id: string): void;
}

/** Application service for repositories: builds records and enforces existence. */
export function createRepoService(deps: RepoServiceDeps): RepoService {
  const requireRepo = (id: string): Repository => {
    const repo = deps.repo.get(id);
    if (!repo) {
      throw new NotFoundError(`Unknown repository: ${id}`);
    }
    return repo;
  };

  return {
    create(input) {
      const localPath = input.localPath;
      const duplicate = deps.repo
        .list()
        .find(
          (r) => r.remoteUrl === input.remoteUrl && r.localPath === localPath,
        );
      if (duplicate) {
        throw new ValidationError(
          `Repository already added: ${input.name} at ${localPath}`,
        );
      }
      const repository: Repository = {
        id: deps.ids.next(),
        provider: input.provider,
        remoteUrl: input.remoteUrl,
        name: input.name,
        localPath: input.localPath,
        defaultBranch: input.defaultBranch ?? null,
        createdAt: deps.clock.isoNow(),
      };
      deps.repo.create(repository);
      return repository;
    },
    get(id) {
      return requireRepo(id);
    },
    list() {
      return deps.repo.list();
    },
    remove(id) {
      requireRepo(id);
      deps.repo.delete(id);
    },
  };
}
