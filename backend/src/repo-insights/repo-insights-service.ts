import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { Repository } from '../repo/repo-contract.js';
import type { RepoInsightsConfig, ReadinessRequirement } from './config.js';
import type {
  ReadinessCheck,
  RepoDefinitionContent,
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
  /**
   * Reads the full text of one discovered skill/agent/doc file from the default
   * branch. The path must sit under a configured directory and carry the
   * definition extension, so this cannot read arbitrary repository files.
   */
  readDefinition(
    repositoryId: string,
    filePath: string,
  ): Promise<RepoDefinitionContent>;
}

/** Application service that reads a repo's default branch to build insights. */
export function createRepoInsightsService(
  deps: RepoInsightsServiceDeps,
): RepoInsightsService {
  const { git, config } = deps;

  const hasDefinitionExtension = (path: string): boolean =>
    path.toLowerCase().endsWith(config.definitionExtension.toLowerCase());

  /** All directories a readable file may live under (skills, agents, docs). */
  const readableDirectories = (): string[] => [
    ...config.skillsDirectories,
    ...config.agentsDirectories,
    ...config.docsDirectories,
  ];

  async function buildEntry(
    repositoryPath: string,
    ref: string,
    file: string,
  ): Promise<RepoDefinitionEntry | null> {
    const content = await git.readFile(repositoryPath, ref, file);
    if (content === null) {
      return null;
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
    return { name, description, author, path: file };
  }

  /** Scans each directory (deduping shared files) into path-sorted entries. */
  async function scanDirectories(
    repositoryPath: string,
    ref: string,
    directories: string[],
  ): Promise<RepoDefinitionEntry[]> {
    const seen = new Set<string>();
    const entries: RepoDefinitionEntry[] = [];
    for (const directory of directories) {
      const files = (
        await git.listFiles(
          repositoryPath,
          ref,
          directory,
          config.recursiveScan,
        )
      ).filter(hasDefinitionExtension);
      for (const file of files) {
        if (seen.has(file)) {
          continue;
        }
        seen.add(file);
        const entry = await buildEntry(repositoryPath, ref, file);
        if (entry !== null) {
          entries.push(entry);
        }
      }
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
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

  async function resolveBranch(repository: Repository): Promise<string> {
    return (
      (await git.resolveDefaultBranch(repository.localPath)) ??
      repository.defaultBranch ??
      config.fallbackBranch
    );
  }

  /**
   * Whether `filePath` is safe to read: normalized (no traversal), carrying the
   * definition extension, and located under one of the configured directories.
   */
  function isReadablePath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (
      normalized.length === 0 ||
      normalized.startsWith('/') ||
      normalized.split('/').includes('..') ||
      !hasDefinitionExtension(normalized)
    ) {
      return false;
    }
    return readableDirectories().some((directory) =>
      normalized.startsWith(`${directory.replace(/\/+$/, '')}/`),
    );
  }

  return {
    async load(repositoryId) {
      const repository = deps.repos.get(repositoryId);
      const branch = await resolveBranch(repository);
      const agents = await scanDirectories(
        repository.localPath,
        branch,
        config.agentsDirectories,
      );
      const skills = await scanDirectories(
        repository.localPath,
        branch,
        config.skillsDirectories,
      );
      const docs = await scanDirectories(
        repository.localPath,
        branch,
        config.docsDirectories,
      );
      const readiness = await evaluateReadiness(repository.localPath, branch);
      return {
        repositoryId,
        branch,
        agents,
        skills,
        docs,
        readiness,
        agentReady: readiness.every((check) => check.status === 'pass'),
        generatedAt: deps.clock.isoNow(),
      };
    },

    async readDefinition(repositoryId, filePath) {
      const repository = deps.repos.get(repositoryId);
      if (!isReadablePath(filePath)) {
        throw new ValidationError(
          `Path is not a readable repository definition: ${filePath}`,
        );
      }
      const branch = await resolveBranch(repository);
      const content = await git.readFile(repository.localPath, branch, filePath);
      if (content === null) {
        throw new NotFoundError(`File not found on ${branch}: ${filePath}`);
      }
      return { path: filePath, branch, content };
    },
  };
}
