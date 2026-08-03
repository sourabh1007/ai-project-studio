/**
 * Read-only Git access the insights service needs, always scoped to a specific
 * `ref` (the repository's default branch) so results reflect the branch rather
 * than the working tree. The concrete adapter is thin IO; all logic lives in
 * the pure service so it can be tested against this port.
 */
export interface RepoInsightsGit {
  /**
   * The repository's default branch (e.g. `main`/`master`), or null when it
   * cannot be resolved so the caller can fall back.
   */
  resolveDefaultBranch(repositoryPath: string): Promise<string | null>;
  /**
   * Repository-relative paths of the files directly under `directory` at `ref`.
   * Empty when the directory does not exist on the branch.
   */
  listFiles(
    repositoryPath: string,
    ref: string,
    directory: string,
  ): Promise<string[]>;
  /** File text at `ref`, or null when the path does not exist there. */
  readFile(
    repositoryPath: string,
    ref: string,
    filePath: string,
  ): Promise<string | null>;
  /** Whether `filePath` exists at `ref`. */
  fileExists(
    repositoryPath: string,
    ref: string,
    filePath: string,
  ): Promise<boolean>;
  /**
   * Name of the most recent commit author to touch `filePath` at `ref`, or
   * null when it cannot be determined.
   */
  lastCommitAuthor(
    repositoryPath: string,
    ref: string,
    filePath: string,
  ): Promise<string | null>;
}
