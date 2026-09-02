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
  /**
   * Builds insights for a repository from its default branch. The first scan is
   * cached and reused for every later load; pass `refresh` to force a rescan.
   */
  load(
    repositoryId: string,
    options?: { refresh?: boolean },
  ): Promise<RepoInsights>;
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
    // List every directory concurrently, then dedupe shared files preserving
    // first-encounter order before building entries in parallel.
    const fileLists = await Promise.all(
      directories.map((directory) =>
        git.listFiles(repositoryPath, ref, directory, config.recursiveScan),
      ),
    );
    const seen = new Set<string>();
    const files: string[] = [];
    for (const list of fileLists) {
      for (const file of list) {
        if (!hasDefinitionExtension(file) || seen.has(file)) {
          continue;
        }
        seen.add(file);
        files.push(file);
      }
    }
    const built = await Promise.all(
      files.map((file) => buildEntry(repositoryPath, ref, file)),
    );
    return built
      .filter((entry): entry is RepoDefinitionEntry => entry !== null)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async function evaluateRequirement(
    repositoryPath: string,
    ref: string,
    requirement: ReadinessRequirement,
  ): Promise<{ status: ReadinessCheck['status']; detail: string | null }> {
    if (requirement.kind === 'anyFileExists') {
      const results = await Promise.all(
        requirement.paths.map((path) =>
          git.fileExists(repositoryPath, ref, path),
        ),
      );
      const index = results.findIndex(Boolean);
      return index >= 0
        ? { status: 'pass', detail: requirement.paths[index] }
        : { status: 'fail', detail: null };
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
    // All checks are independent, so evaluate them concurrently.
    return Promise.all(
      config.readinessChecks.map(async (definition) => {
        const { status, detail } = await evaluateRequirement(
          repositoryPath,
          ref,
          definition.test,
        );
        return {
          key: definition.key,
          label: definition.label,
          requirement: definition.requirement,
          status,
          detail,
        };
      }),
    );
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

  /** Reads the default branch once and assembles a fresh insights snapshot. */
  async function compute(repositoryId: string): Promise<RepoInsights> {
    const repository = deps.repos.get(repositoryId);
    const branch = await resolveBranch(repository);
    // Directory scans and readiness checks are independent — run concurrently.
    const [agents, skills, docs, readiness] = await Promise.all([
      scanDirectories(repository.localPath, branch, config.agentsDirectories),
      scanDirectories(repository.localPath, branch, config.skillsDirectories),
      scanDirectories(repository.localPath, branch, config.docsDirectories),
      evaluateReadiness(repository.localPath, branch),
    ]);
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
  }

  // Once a repository has been scanned its snapshot stays available for every
  // subsequent open; only an explicit refresh (Rescan) recomputes it. Inflight
  // promises dedupe concurrent first-time loads so a scan never runs twice.
  const cache = new Map<string, RepoInsights>();
  const inflight = new Map<string, Promise<RepoInsights>>();

  return {
    async load(repositoryId, options) {
      const refresh = options?.refresh ?? false;
      const cached = cache.get(repositoryId);
      if (!refresh && cached !== undefined) {
        return cached;
      }
      const existing = inflight.get(repositoryId);
      if (!refresh && existing !== undefined) {
        return existing;
      }
      const run = (async () => {
        try {
          const result = await compute(repositoryId);
          cache.set(repositoryId, result);
          return result;
        } finally {
          inflight.delete(repositoryId);
        }
      })();
      inflight.set(repositoryId, run);
      return run;
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
