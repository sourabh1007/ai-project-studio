import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FeatureBranchReader } from './feature-environment.js';

const execFile = promisify(nodeExecFile);

/**
 * Isolate this read-only branch probe from the user's global/system git config
 * (see repo-insights-git-adapter for the full rationale): it never needs
 * identity or credentials, and coupling to a briefly-locked `~/.gitconfig`
 * during a credential refresh would otherwise make it fail.
 */
const ISOLATED_CONFIG_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const;

/**
 * Reads a checkout's current branch with `git rev-parse --abbrev-ref HEAD`,
 * swallowing any failure (missing dir, not a repo, detached HEAD) into null so
 * the caller never throws while computing a feature's environment.
 */
export function createGitBranchReader(): FeatureBranchReader {
  return {
    async read(cwd) {
      try {
        const { stdout } = await execFile(
          'git',
          ['-c', 'safe.directory=*', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
          {
            encoding: 'utf8',
            windowsHide: true,
            env: { ...process.env, ...ISOLATED_CONFIG_ENV },
          },
        );
        const branch = stdout.trim();
        return branch.length > 0 && branch !== 'HEAD' ? branch : null;
      } catch {
        return null;
      }
    },
  };
}
