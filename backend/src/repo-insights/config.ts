import { z } from 'zod';

/** Configuration namespace for on-demand repository insights. */
export const REPO_INSIGHTS_NAMESPACE = 'repoInsights';

/**
 * A required parameter for making a repository "agent ready". Requirements are
 * data-driven so the checklist can be tuned via config without code changes:
 *  - `anyFileExists` passes when any of the listed paths exists on the branch.
 *  - `anyDefinitionUnder` passes when the directory holds ≥1 definition file.
 */
const readinessRequirementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anyFileExists'),
    paths: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('anyDefinitionUnder'),
    directory: z.string().min(1),
  }),
]);

export type ReadinessRequirement = z.infer<typeof readinessRequirementSchema>;

const readinessCheckSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  requirement: z.string().min(1),
  test: readinessRequirementSchema,
});

export type ReadinessCheckDefinition = z.infer<typeof readinessCheckSchema>;

export const repoInsightsConfigSchema = z.object({
  /** Directories holding custom-agent definition files (scanned in order). */
  agentsDirectories: z.array(z.string().min(1)).min(1),
  /** Directories holding repo-native skill definition files (scanned in order). */
  skillsDirectories: z.array(z.string().min(1)).min(1),
  /** Directories holding documentation / TSG files (scanned in order). */
  docsDirectories: z.array(z.string().min(1)).min(1),
  /** When true, directories are scanned recursively (nested files included). */
  recursiveScan: z.boolean(),
  /** Extension (with leading dot) a definition file must have. */
  definitionExtension: z.string().min(1),
  /** Frontmatter key read for a definition's display name. */
  nameKey: z.string().min(1),
  /** Frontmatter key read for a definition's one-line description. */
  descriptionKey: z.string().min(1),
  /** Frontmatter key read for a definition's author. */
  authorKey: z.string().min(1),
  /** Descriptions longer than this are truncated with an ellipsis. */
  maxDescriptionChars: z.number().int().positive(),
  /** Shown as the author when neither frontmatter nor git resolves one. */
  unknownAuthorLabel: z.string().min(1),
  /** Branch used when the repo's default branch cannot be resolved. */
  fallbackBranch: z.string().min(1),
  /** The ordered agent-readiness checklist evaluated against the branch. */
  readinessChecks: z.array(readinessCheckSchema).min(1),
  /** Per-section metasession enrichment (parallel, warm-pool, self-healing). */
  enrichment: z.object({
    /** When false the streaming scan is structural-only (no metasessions). */
    enabled: z.boolean(),
    /**
     * Prompt template for a section's analysis. Placeholders: `{section}`,
     * `{repository}`, `{branch}` and `{evidence}` (the section's scanned items).
     */
    promptTemplate: z.string().min(1),
    /** Hard timeout (ms) for one section's enrichment metasession turn. */
    timeoutMs: z.number().int().positive(),
    /** Warm attempts before the final forced-cold self-heal attempt. */
    retryAttempts: z.number().int().nonnegative(),
    /** Backoff (ms) between warm self-heal attempts. */
    retryBackoffMs: z.number().int().nonnegative(),
    /** Analyses longer than this are truncated. */
    maxAnalysisChars: z.number().int().positive(),
    /** Warm sessions kept free for other IDE work while fanning out. */
    fanOutReserve: z.number().int().nonnegative(),
  }),
});

export type RepoInsightsConfig = z.infer<typeof repoInsightsConfigSchema>;

export const repoInsightsDefaults: RepoInsightsConfig = {
  agentsDirectories: ['.github/agents', 'agents'],
  skillsDirectories: ['.github/skills', 'skills'],
  docsDirectories: ['docs', '.github/docs'],
  recursiveScan: true,
  definitionExtension: '.md',
  nameKey: 'name',
  descriptionKey: 'description',
  authorKey: 'author',
  maxDescriptionChars: 160,
  unknownAuthorLabel: 'Unknown',
  fallbackBranch: 'main',
  readinessChecks: [
    {
      key: 'agent-instructions',
      label: 'Agent instructions',
      requirement: 'AGENTS.md or .github/copilot-instructions.md is present.',
      test: {
        kind: 'anyFileExists',
        paths: ['AGENTS.md', '.github/copilot-instructions.md'],
      },
    },
    {
      key: 'custom-agent',
      label: 'Custom agent defined',
      requirement: 'At least one custom agent exists under .github/agents.',
      test: { kind: 'anyDefinitionUnder', directory: '.github/agents' },
    },
  ],
  enrichment: {
    enabled: true,
    promptTemplate: [
      'You are analysing the "{section}" section of the repository {repository} on branch {branch}.',
      'Below is the evidence discovered for this section:',
      '',
      '{evidence}',
      '',
      'In 1-3 short sentences, summarise what this tells a developer about the',
      "repository's {section} readiness — coverage, notable gaps, and one concrete",
      'next step if useful. Be specific and do not invent files that are not listed.',
      'Reply with plain prose only, no headings or markdown.',
    ].join('\n'),
    timeoutMs: 60_000,
    retryAttempts: 2,
    retryBackoffMs: 500,
    maxAnalysisChars: 600,
    fanOutReserve: 1,
  },
};
