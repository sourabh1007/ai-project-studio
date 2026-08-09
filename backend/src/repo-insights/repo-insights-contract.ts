/**
 * At-a-glance understanding of a repository, generated from its default branch:
 * the repo-native skill/agent definitions it ships and whether it satisfies the
 * checklist that makes it ready for the AI coding agent. The AI-written project
 * summary is tracked separately by the repository-context module.
 */

/** A repo-native skill or custom-agent definition discovered on the branch. */
export interface RepoDefinitionEntry {
  /** Display name — frontmatter `name`, else derived from the file name. */
  name: string;
  /** One-line description — frontmatter `description`, else the first line. */
  description: string;
  /** Frontmatter `author`, else the file's last commit author, else a label. */
  author: string;
  /** Repository-relative path of the definition file. */
  path: string;
}

/** Whether a single agent-readiness parameter is satisfied by the repository. */
export type ReadinessStatus = 'pass' | 'fail';

/** One evaluated agent-readiness parameter and how the repository measured up. */
export interface ReadinessCheck {
  key: string;
  /** Short human label for the parameter. */
  label: string;
  /** What the repository must provide to satisfy the parameter. */
  requirement: string;
  status: ReadinessStatus;
  /** Which artifact satisfied it (or why it did not), when known. */
  detail: string | null;
}

/** Aggregated, on-demand insights for a repository's default branch. */
export interface RepoInsights {
  repositoryId: string;
  /** The default branch the insights were generated from (e.g. `main`). */
  branch: string;
  agents: RepoDefinitionEntry[];
  skills: RepoDefinitionEntry[];
  /** Documentation / troubleshooting-guide files discovered on the branch. */
  docs: RepoDefinitionEntry[];
  readiness: ReadinessCheck[];
  /** True when every readiness parameter passes. */
  agentReady: boolean;
  generatedAt: string;
}

/** The full, read-only content of a single discovered definition or doc file. */
export interface RepoDefinitionContent {
  /** Repository-relative path of the file. */
  path: string;
  /** The branch the content was read from. */
  branch: string;
  /** The file's full text at that branch. */
  content: string;
}
