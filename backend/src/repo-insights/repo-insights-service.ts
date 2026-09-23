import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { Clock } from '../kernel/clock.js';
import type { Repository } from '../repo/repo-contract.js';
import { MetaAbortError, type MetaRunner } from '../meta/meta-runner.js';
import type { RepoInsightsConfig, ReadinessRequirement } from './config.js';
import type {
  ReadinessCheck,
  RepoDefinitionContent,
  RepoDefinitionEntry,
  RepoInsights,
  RepoInsightsSection,
  RepoInsightsStreamSink,
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
  /**
   * Warm metasession runner used to enrich each section in parallel. Optional:
   * when absent (or `config.enrichment.enabled` is false) the streaming scan is
   * structural-only and every section is analysed concurrently.
   */
  ai?: Pick<MetaRunner, 'runDetailed'>;
  /**
   * Live count of booted warm metasessions, re-read as the pass proceeds so
   * capacity added mid-run is used. Sizes how many sections enrich at once (all
   * but {@link RepoInsightsConfig.enrichment.fanOutReserve}). Absent/zero runs
   * one section at a time — the safe default when the warm pool is cold.
   */
  liveMetaSessions?: () => number;
  /** Backoff primitive between self-heal attempts (injected for tests). */
  sleep?: (ms: number) => Promise<void>;
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
   * Streams a fresh scan section-by-section: resolves the branch, then fans the
   * four sections out across the warm metasession pool (one warmed session per
   * section, reserving one for other IDE work) and emits each section's
   * structural entries plus its metasession analysis to `sink` as it settles. A
   * failed section self-heals on a fresh session before it is reported failed.
   * The assembled snapshot is cached (so a later {@link load} is instant) and
   * emitted as a terminal `done`. Never rejects for a single section's failure;
   * resolves once every section has settled or the request is aborted.
   */
  analyzeStream(
    repositoryId: string,
    sink: RepoInsightsStreamSink,
    signal?: AbortSignal,
  ): Promise<void>;
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

  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** The ordered sections a streaming scan analyses, one per warm session. */
  const SECTIONS: readonly RepoInsightsSection[] = [
    'agents',
    'skills',
    'docs',
    'readiness',
  ];

  const sectionDirectories = (
    section: Exclude<RepoInsightsSection, 'readiness'>,
  ): string[] =>
    section === 'agents'
      ? config.agentsDirectories
      : section === 'skills'
        ? config.skillsDirectories
        : config.docsDirectories;

  /** Whether metasession enrichment is active for this run. */
  const enrichmentActive = (): boolean =>
    deps.ai !== undefined && config.enrichment.enabled;

  /**
   * How many sections to enrich at once. With no warm pool (or enrichment off)
   * every section runs concurrently — the structural git scans are independent.
   * Otherwise use all live warm sessions but `fanOutReserve`, re-read each time
   * a slot frees so capacity added mid-run is picked up.
   */
  function fanOutWidth(): number {
    if (!enrichmentActive()) {
      return SECTIONS.length;
    }
    const live = deps.liveMetaSessions?.() ?? 0;
    return Math.max(1, live - config.enrichment.fanOutReserve);
  }

  /**
   * Fan `items` out to `task` with at most `limit()` running at once, re-reading
   * `limit()` whenever a slot frees. Never rejects — `task` owns its failures;
   * resolves once every item has settled or, once aborted, all in-flight work
   * has drained.
   */
  async function runReserved<T>(
    items: readonly T[],
    limit: () => number,
    task: (item: T) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const queue = [...items];
    let active = 0;
    await new Promise<void>((resolve) => {
      const pump = (): void => {
        if (signal?.aborted) {
          if (active === 0) resolve();
          return;
        }
        while (active < Math.max(1, limit()) && queue.length > 0) {
          const item = queue.shift() as T;
          active += 1;
          void task(item).finally(() => {
            active -= 1;
            pump();
          });
        }
        if (active === 0 && queue.length === 0) {
          resolve();
        }
      };
      pump();
    });
  }

  /**
   * A section's structural scan result, discriminated so callers get tight
   * types without defensive fallbacks.
   */
  type SectionScan =
    | { section: 'readiness'; readiness: ReadinessCheck[] }
    | {
        section: Exclude<RepoInsightsSection, 'readiness'>;
        entries: RepoDefinitionEntry[];
      };

  /** Compact, prompt-safe evidence text for a section's discovered items. */
  function evidenceText(scan: SectionScan): string {
    if (scan.section === 'readiness') {
      return scan.readiness
        .map(
          (check) =>
            `- [${check.status.toUpperCase()}] ${check.label}: ${check.requirement}`,
        )
        .join('\n');
    }
    return scan.entries.length === 0
      ? '(none found)'
      : scan.entries
          .map((entry) => `- ${entry.name} (${entry.path}): ${entry.description}`)
          .join('\n');
  }

  /** Runs one enrichment turn; `forceCold` pins the final self-heal attempt. */
  async function enrichAttempt(
    repositoryId: string,
    repositoryPath: string,
    branch: string,
    section: RepoInsightsSection,
    evidence: string,
    forceCold: boolean,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const prompt = config.enrichment.promptTemplate
      .replaceAll('{section}', section)
      .replaceAll('{repository}', deps.repos.get(repositoryId).name)
      .replaceAll('{branch}', branch)
      .replaceAll('{evidence}', evidence);
    const result = await deps.ai!.runDetailed({
      featureId: `repository:${repositoryId}`,
      prompt,
      cwd: repositoryPath,
      scope: 'internal',
      // Pure prompt→text: no tool loops, but kept warm-eligible so the pool
      // (not a cold spawn per section) serves the fan-out.
      noTools: true,
      toolsOptional: true,
      forceCold,
      timeoutMs: config.enrichment.timeoutMs,
      label: `Repo insights · ${section}`,
      signal,
    });
    return result.text.trim().slice(0, config.enrichment.maxAnalysisChars);
  }

  /**
   * Enrich a section with self-heal: retry warm sessions with backoff, then a
   * final forced-cold attempt so a broken warm session cannot fail every retry.
   * A provider timeout skips the warm retries (it already burned the budget) and
   * goes straight to the cold attempt. `onHeal` fires before each retry so the
   * UI can show the section self-healing. Throws only when every attempt fails.
   */
  async function enrichSection(
    repositoryId: string,
    repositoryPath: string,
    branch: string,
    section: RepoInsightsSection,
    evidence: string,
    signal: AbortSignal | undefined,
    onHeal: () => void,
  ): Promise<string> {
    for (let attempt = 0; attempt < config.enrichment.retryAttempts; attempt += 1) {
      if (attempt > 0) {
        onHeal();
      }
      try {
        return await enrichAttempt(
          repositoryId,
          repositoryPath,
          branch,
          section,
          evidence,
          false,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        if (error instanceof MetaAbortError && error.kind === 'timed_out') {
          break;
        }
        await sleep(config.enrichment.retryBackoffMs);
      }
    }
    onHeal();
    return enrichAttempt(
      repositoryId,
      repositoryPath,
      branch,
      section,
      evidence,
      true,
      signal,
    );
  }

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

    async analyzeStream(repositoryId, sink, signal) {
      const repository = deps.repos.get(repositoryId);
      const branch = await resolveBranch(repository);
      if (signal?.aborted) {
        return;
      }
      sink.emit({ type: 'branch', branch });

      const structural = {
        agents: [] as RepoDefinitionEntry[],
        skills: [] as RepoDefinitionEntry[],
        docs: [] as RepoDefinitionEntry[],
        readiness: [] as ReadinessCheck[],
      };

      await runReserved(
        SECTIONS,
        fanOutWidth,
        async (section) => {
          sink.emit({ type: 'section-analyzing', section, healing: false });

          let scan: SectionScan;
          try {
            if (section === 'readiness') {
              scan = {
                section,
                readiness: await evaluateReadiness(repository.localPath, branch),
              };
            } else {
              scan = {
                section,
                entries: await scanDirectories(
                  repository.localPath,
                  branch,
                  sectionDirectories(section),
                ),
              };
            }
          } catch (error) {
            sink.emit({
              type: 'section-failed',
              section,
              error: errorMessage(error),
            });
            return;
          }

          if (scan.section === 'readiness') {
            structural.readiness = scan.readiness;
          } else {
            structural[scan.section] = scan.entries;
          }

          let analysis: string | null = null;
          let analysisError: string | undefined;
          if (enrichmentActive()) {
            try {
              analysis = await enrichSection(
                repositoryId,
                repository.localPath,
                branch,
                section,
                evidenceText(scan),
                signal,
                () =>
                  sink.emit({ type: 'section-analyzing', section, healing: true }),
              );
            } catch (error) {
              analysisError = errorMessage(error);
            }
          }

          sink.emit({
            type: 'section',
            section,
            ...(scan.section === 'readiness'
              ? { readiness: scan.readiness }
              : { entries: scan.entries }),
            analysis,
            ...(analysisError !== undefined ? { analysisError } : {}),
          });
        },
        signal,
      );

      if (signal?.aborted) {
        return;
      }
      const insights: RepoInsights = {
        repositoryId,
        branch,
        agents: structural.agents,
        skills: structural.skills,
        docs: structural.docs,
        readiness: structural.readiness,
        agentReady: structural.readiness.every((check) => check.status === 'pass'),
        generatedAt: deps.clock.isoNow(),
      };
      cache.set(repositoryId, insights);
      sink.emit({ type: 'done', insights });
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
