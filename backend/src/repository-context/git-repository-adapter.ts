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

/**
 * Environment that isolates read-only local git inspection from the user's
 * global and system config. These commands never need identity or credentials,
 * so reading `~/.gitconfig` only couples them to that file's availability — and
 * Git Credential Manager rewrites `~/.gitconfig` when refreshing tokens, briefly
 * locking it. A concurrent read then fails with "Permission denied", which git
 * treats as fatal. Pointing the config env at the null device skips those files
 * entirely and removes the race. `GIT_TERMINAL_PROMPT=0` keeps these background
 * commands from ever blocking on an auth prompt.
 */
const ISOLATED_CONFIG_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

const defaultExecutor: GitCommandExecutor = {
  async run(executable, args) {
    // Bypassing global config also bypasses any `safe.directory` allow-list the
    // user configured, so opt these read-only inspections out of the ownership
    // check to avoid a "dubious ownership" fatal on mapped/other-owned drives.
    return execFile(executable, ['-c', 'safe.directory=*', ...args], {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...ISOLATED_CONFIG_ENV },
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
