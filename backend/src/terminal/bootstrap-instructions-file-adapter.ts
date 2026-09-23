import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { instructionsFilePath } from './bootstrap-instructions.js';
import type { BootstrapInstructionsWriter } from './bootstrap-instructions-port.js';

/**
 * Filesystem-backed writer for per-session bootstrap context. Files live under
 * `<baseDir>/<sessionId>/.github/instructions/` so the CLI discovers them via
 * `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`; `write` returns the per-session directory
 * to add to that env var. Defaults to an app-owned directory under the OS temp
 * dir so context files never land inside the user's repository.
 */
export function createBootstrapInstructionsWriter(
  baseDir: string = join(tmpdir(), 'aps-session-context'),
): BootstrapInstructionsWriter {
  return {
    async write(sessionId, content) {
      const { dir, filePath } = instructionsFilePath(baseDir, sessionId);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf8');
      return dir;
    },
    async clear(sessionId) {
      const { dir } = instructionsFilePath(baseDir, sessionId);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
