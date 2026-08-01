import type { DatabaseSync } from 'node:sqlite';
import type { RepoProvider, Repository } from '../repo/repo-contract.js';
import type { RepoRepo } from '../repo/repo-repo-port.js';

interface RepositoryRow {
  id: string;
  provider: string;
  remote_url: string;
  name: string;
  local_path: string;
  default_branch: string | null;
  created_at: string;
}

function mapRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    provider: row.provider as RepoProvider,
    remoteUrl: row.remote_url,
    name: row.name,
    localPath: row.local_path,
    defaultBranch: row.default_branch ?? null,
    createdAt: row.created_at,
  };
}

/** SQLite-backed implementation of the RepoRepo port. */
export function createRepoRepo(db: DatabaseSync): RepoRepo {
  const insert = db.prepare(
    `INSERT INTO repositories
       (id, provider, remote_url, name, local_path, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare('SELECT * FROM repositories WHERE id = ?');
  const selectAll = db.prepare(
    'SELECT * FROM repositories ORDER BY created_at, id',
  );
  const deleteOne = db.prepare('DELETE FROM repositories WHERE id = ?');

  return {
    create(repo) {
      insert.run(
        repo.id,
        repo.provider,
        repo.remoteUrl,
        repo.name,
        repo.localPath,
        repo.defaultBranch ?? null,
        repo.createdAt,
      );
    },
    get(id) {
      const row = selectOne.get(id) as RepositoryRow | undefined;
      return row ? mapRepository(row) : null;
    },
    list() {
      return (selectAll.all() as unknown as RepositoryRow[]).map(mapRepository);
    },
    delete(id) {
      deleteOne.run(id);
    },
  };
}
