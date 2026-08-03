import type { Clock } from '../kernel/clock.js';
import type { Repository } from '../repo/repo-contract.js';
import type { RepoInsightsConfig, ReadinessRequirement } from './config.js';
import type {
  ReadinessCheck,
  RepoDefinitionEntry,
  RepoInsights,
} from './repo-insights-contract.js';
import type { RepoInsightsGit } from './repo-insights-git-port.js';
import {
  deriveName,
  firstMeaningfulLine,
  frontmatterValue,
  parseDefinition,
  truncate,
} from './frontmatter.js';

export interface RepoInsightsServiceDeps {
  /** Resolves a repository by id (throws when unknown). */
  repos: { get(id: string): Repository };
  git: RepoInsightsGit;
  clock: Clock;
  config: RepoInsightsConfig;
}

export interface RepoInsightsService {
  /** Builds insights for a repository from its default branch. */
  load(repositoryId: string): Promise<RepoInsights>;
}

/** Application service that reads a repo's default branch to build insights. */
export function createRepoInsightsService(
  deps: RepoInsightsServiceDeps,
): RepoInsightsService {
  const { git, config } = deps;

  const hasDefinitionExtension = (path: string): boolean =>
    path.toLowerCase().endsWith(config.definitionExtension.toLowerCase());

  async function scanDefinitions(
    repositoryPath: string,
    ref: string,
    directory: string,
  ): Promise<RepoDefinitionEntry[]> {
    const files = (await git.listFiles(repositoryPath, ref, directory))
      .filter(hasDefinitionExtension)
      .sort((left, right) => left.localeCompare(right));
    const entries: RepoDefinitionEntry[] = [];
    for (const file of files) {
      const content = await git.readFile(repositoryPath, ref, file);
      if (content === null) {
        continue;
      }
      const { frontmatter, body } = parseDefinition(content);
      const name =
        frontmatterValue(frontmatter, config.nameKey) ??
        deriveName(file, config.definitionExtension);
      const description = truncate(
        frontmatterValue(frontmatter, config.descriptionKey) ??
          firstMeaningfulLine(body) ??
          '',
        config.maxDescriptionChars,
      );
      const author =
        frontmatterValue(frontmatter, config.authorKey) ??
        (await git.lastCommitAuthor(repositoryPath, ref, file)) ??
        config.unknownAuthorLabel;
      entries.push({ name, description, author, path: file });
    }
    return entries;
  }

  async function evaluateRequirement(
    repositoryPath: string,
    ref: string,
    requirement: ReadinessRequirement,
  ): Promise<{ status: ReadinessCheck['status']; detail: string | null }> {
    if (requirement.kind === 'anyFileExists') {
      for (const path of requirement.paths) {
        if (await git.fileExists(repositoryPath, ref, path)) {
          return { status: 'pass', detail: path };
        }
      }
      return { status: 'fail', detail: null };
    }
    const matches = (
      await git.listFiles(repositoryPath, ref, requirement.directory)
    ).filter(hasDefinitionExtension);
    return matches.length > 0
      ? { status: 'pass', detail: `${matches.length} found` }
      : { status: 'fail', detail: null };
  }

  async function evaluateReadiness(
    repositoryPath: string,
    ref: string,
  ): Promise<ReadinessCheck[]> {
    const checks: ReadinessCheck[] = [];
    for (const definition of config.readinessChecks) {
      const { status, detail } = await evaluateRequirement(
        repositoryPath,
        ref,
        definition.test,
      );
      checks.push({
        key: definition.key,
        label: definition.label,
        requirement: definition.requirement,
        status,
        detail,
      });
    }
    return checks;
  }

  return {
    async load(repositoryId) {
      const repository = deps.repos.get(repositoryId);
      const branch =
        (await git.resolveDefaultBranch(repository.localPath)) ??
        repository.defaultBranch ??
        config.fallbackBranch;
      const agents = await scanDefinitions(
        repository.localPath,
        branch,
        config.agentsDirectory,
      );
      const skills = await scanDefinitions(
        repository.localPath,
        branch,
        config.skillsDirectory,
      );
      const readiness = await evaluateReadiness(repository.localPath, branch);
      return {
        repositoryId,
        branch,
        agents,
        skills,
        readiness,
        agentReady: readiness.every((check) => check.status === 'pass'),
        generatedAt: deps.clock.isoNow(),
      };
    },
  };
}
