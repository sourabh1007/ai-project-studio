import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewContextCommandRunner } from './review-context-git.js';

const execute = promisify(execFile);

export function createReviewContextCommandRunner(): ReviewContextCommandRunner {
  return {
    async run(executable, args, options) {
      return execute(executable, [...args], {
        ...options,
        encoding: 'buffer',
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_CONFIG_COUNT: '0',
        },
      });
    },
  };
}
