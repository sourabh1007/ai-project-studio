import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepoInsightsGit } from './repo-insights-git-port.js';

const execFile = promisify(nodeExecFile);

export interface GitCommandExecutor {
  run(
    executable: string,
    args: readonly string[],
  ): Promise<{ stdout: string | Buffer }>;
}

/**
 * Environment that isolates these read-only insight scans from the user's global
 * and system git config. They never need identity or credentials, so depending
 * on `~/.gitconfig` only makes them fail when Git Credential Manager is briefly
 * rewriting (and locking) that file during a token refresh — git treats the
 * resulting config-read "Permission denied" as fatal. Pointing config at the
 * null device removes that coupling; `GIT_TERMINAL_PROMPT=0` prevents any auth
 * prompt from stalling a background scan.
 */
const ISOLATED_CONFIG_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

const defaultExecutor: GitCommandExecutor = {
  async run(executable, args) {
    // Global config is bypassed, so also opt out of the ownership check (whose
    // allow-list lives there) to avoid a "dubious ownership" fatal on mapped or
    // differently-owned drives.
    return execFile(executable, ['-c', 'safe.directory=*', ...args], {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...ISOLATED_CONFIG_ENV },
    });
  },
};

/**
 * Read-only Git adapter for repository insights. Every method targets an
 * explicit `ref` (the default branch) and swallows Git failures into an empty
 * result, so a missing directory, absent file, or bad ref never throws.
 */
export function createRepoInsightsGitAdapter(
  executor: GitCommandExecutor = defaultExecutor,
): RepoInsightsGit {
  const run = async (
    repositoryPath: string,
    args: readonly string[],
  ): Promise<string | null> => {
    try {
      const result = await executor.run('git', ['-C', repositoryPath, ...args]);
      return result.stdout.toString();
    } catch {
      return null;
    }
  };

  return {
    async resolveDefaultBranch(repositoryPath) {
      const symbolic = await run(repositoryPath, [
        'symbolic-ref',
        '--short',
        'refs/remotes/origin/HEAD',
      ]);
      if (symbolic !== null) {
        const branch = symbolic.trim().replace(/^origin\//, '');
        if (branch.length > 0) {
          return branch;
        }
      }
      const current = await run(repositoryPath, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]);
      const name = current?.trim();
      return name && name !== 'HEAD' ? name : null;
    },

    async listFiles(repositoryPath, ref, directory, recursive = false) {
      const output = await run(repositoryPath, [
        'ls-tree',
        '--name-only',
        ...(recursive ? ['-r'] : []),
        ref,
        `${directory.replace(/\/+$/, '')}/`,
      ]);
      if (output === null) {
        return [];
      }
      return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },

    async readFile(repositoryPath, ref, filePath) {
      return run(repositoryPath, ['show', `${ref}:${filePath}`]);
    },

    async fileExists(repositoryPath, ref, filePath) {
      const output = await run(repositoryPath, [
        'cat-file',
        '-e',
        `${ref}:${filePath}`,
      ]);
      return output !== null;
    },

    async lastCommitAuthor(repositoryPath, ref, filePath) {
      const output = await run(repositoryPath, [
        'log',
        '-1',
        '--format=%an',
        ref,
        '--',
        filePath,
      ]);
      const author = output?.trim();
      return author && author.length > 0 ? author : null;
    },
  };
}
