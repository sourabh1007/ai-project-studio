/**
 * Delivers a session's composed bootstrap context (repository, feature-memory,
 * and skill context) to the CLI as a custom-instructions file it discovers via
 * `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`, instead of typing the whole block into the
 * terminal as a wall of injected prompt text. `write` persists the content and
 * returns the directory to add to that env var; `clear` removes the session's
 * files when it ends.
 */
export interface BootstrapInstructionsWriter {
  /** Writes `content` for `sessionId`; resolves with the dir to add to the env. */
  write(sessionId: string, content: string): Promise<string>;
  /** Removes any files previously written for `sessionId`. */
  clear(sessionId: string): Promise<void>;
}
