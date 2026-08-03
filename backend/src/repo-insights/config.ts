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
  /** Directory holding custom-agent definition files. */
  agentsDirectory: z.string().min(1),
  /** Directory holding repo-native skill definition files. */
  skillsDirectory: z.string().min(1),
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
});

export type RepoInsightsConfig = z.infer<typeof repoInsightsConfigSchema>;

export const repoInsightsDefaults: RepoInsightsConfig = {
  agentsDirectory: '.github/agents',
  skillsDirectory: '.github/skills',
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
      key: 'copilot-setup-steps',
      label: 'Cloud agent setup',
      requirement: '.github/workflows/copilot-setup-steps.yml is present.',
      test: {
        kind: 'anyFileExists',
        paths: ['.github/workflows/copilot-setup-steps.yml'],
      },
    },
    {
      key: 'custom-agent',
      label: 'Custom agent defined',
      requirement: 'At least one custom agent exists under .github/agents.',
      test: { kind: 'anyDefinitionUnder', directory: '.github/agents' },
    },
  ],
};
