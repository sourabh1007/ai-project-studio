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

const defaultExecutor: GitCommandExecutor = {
  async run(executable, args) {
    return execFile(executable, [...args], {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
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

    async listFiles(repositoryPath, ref, directory) {
      const output = await run(repositoryPath, [
        'ls-tree',
        '--name-only',
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
