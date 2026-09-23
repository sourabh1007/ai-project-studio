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

/**
 * The four independent sections of a repository insights scan. Each is analysed
 * by its own warmed-up metasession in parallel so a slow section never blocks
 * the others and the whole pass cannot stall a single request past its timeout.
 */
export type RepoInsightsSection = 'agents' | 'skills' | 'docs' | 'readiness';

/**
 * One event from a streaming insights analysis ({@link
 * RepoInsightsService.analyzeStream}). The server resolves the branch, then fans
 * the four sections out across the warm metasession pool and emits, per section,
 * a `section-analyzing` when it starts (again with `healing: true` while a failed
 * section self-heals on a fresh session), then exactly one terminal `section`
 * (structural entries plus the metasession's analysis) or `section-failed`.
 * A final `done` carries the fully assembled snapshot. Streaming each section as
 * it settles lets the page fill progressively over one long-lived request rather
 * than a single blocking GET that times out on a large repository.
 */
export type RepoInsightsStreamEvent =
  | { type: 'branch'; branch: string }
  | {
      type: 'section-analyzing';
      section: RepoInsightsSection;
      /** True when this is a self-heal retry after an earlier attempt failed. */
      healing: boolean;
    }
  | {
      type: 'section';
      section: RepoInsightsSection;
      /** Discovered definitions for agents/skills/docs sections. */
      entries?: RepoDefinitionEntry[];
      /** Evaluated checks for the readiness section. */
      readiness?: ReadinessCheck[];
      /** The metasession's short analysis of the section, or null when none. */
      analysis: string | null;
      /** Set when enrichment ultimately failed but the structural scan is valid. */
      analysisError?: string;
    }
  | { type: 'section-failed'; section: RepoInsightsSection; error: string }
  | { type: 'done'; insights: RepoInsights };

/** Sink the server-side insights fan-out writes each event to as it settles. */
export interface RepoInsightsStreamSink {
  emit(event: RepoInsightsStreamEvent): void;
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
