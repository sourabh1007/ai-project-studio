import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepositoryRevisionLookup } from './repository-revision-port.js';
import type { RepositoryTrackedFileLookup } from './repository-evidence-port.js';

const execFile = promisify(nodeExecFile);

export interface GitCommandExecutor {
  run(
    executable: string,
    args: readonly string[],
  ): Promise<{ stdout: string | Buffer }>;
}

const defaultExecutor: GitCommandExecutor = {
  async run(executable, args) {
    return execFile(executable, [...args], {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  },
};

export interface GitRepositoryAdapter
  extends RepositoryRevisionLookup,
    RepositoryTrackedFileLookup {}

/** Safe, read-only Git inspection adapter. */
export function createGitRepositoryAdapter(
  executor: GitCommandExecutor = defaultExecutor,
): GitRepositoryAdapter {
  return {
    async getRevision(repositoryPath) {
      const result = await executor.run('git', [
        '-C',
        repositoryPath,
        'rev-parse',
        '--verify',
        'HEAD',
      ]);
      const revision = result.stdout.toString().trim();
      if (!/^[0-9a-f]{40,64}$/i.test(revision)) {
        throw new Error('Git returned an invalid HEAD revision');
      }
      return revision;
    },

    async listTrackedFiles(repositoryPath) {
      const result = await executor.run('git', [
        '-C',
        repositoryPath,
        'ls-files',
        '-z',
      ]);
      return result.stdout
        .toString()
        .split('\0')
        .filter((path) => path.length > 0);
    },
  };
}
