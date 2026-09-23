import { join } from 'node:path';

/**
 * Environment variable the Copilot CLI reads for additional directories to
 * search for custom-instruction files, IN ADDITION to the git root and cwd.
 * Files placed under a listed directory load silently as instructions — they
 * never appear as a chat turn — which is how the app injects repository/feature
 * context without the user watching a wall of prompt text scroll past.
 */
export const CUSTOM_INSTRUCTIONS_DIRS_ENV = 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS';

/**
 * One-line status shown in place of the injected context block, so the user
 * sees that context is being applied rather than a wall of text they did not
 * type. Trailing CRLF keeps it on its own line in the terminal.
 */
export const INJECTING_CONTEXT_NOTICE = '⏳ Auto-injecting repository context…\r\n';

/**
 * Resolves where a session's instructions file lives under `baseDir`. The CLI
 * only discovers custom-instruction files under a `.github/instructions`
 * subtree of a search directory (a bare file at the directory root is NOT
 * picked up), so the file lives there while the directory added to the env var
 * is the per-session root above it.
 */
export function instructionsFilePath(
  baseDir: string,
  sessionId: string,
): { dir: string; filePath: string } {
  const dir = join(baseDir, sessionId);
  return {
    dir,
    filePath: join(
      dir,
      '.github',
      'instructions',
      'studio-context.instructions.md',
    ),
  };
}

/**
 * Appends `dir` to a `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` value, preserving any
 * directories already listed and never adding a duplicate. Blank entries are
 * dropped so a leading/trailing/doubled comma cannot produce an empty search
 * path.
 */
export function appendInstructionsDir(
  existing: string | undefined,
  dir: string,
): string {
  const parts = (existing ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (!parts.includes(dir)) {
    parts.push(dir);
  }
  return parts.join(',');
}

/**
 * Returns a copy of a spawn env with `dir` merged into its custom-instructions
 * search path, leaving every other variable untouched.
 */
export function withInstructionsDir(
  env: Readonly<Record<string, string>>,
  dir: string,
): Record<string, string> {
  return {
    ...env,
    [CUSTOM_INSTRUCTIONS_DIRS_ENV]: appendInstructionsDir(
      env[CUSTOM_INSTRUCTIONS_DIRS_ENV],
      dir,
    ),
  };
}
