import {
  mkdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join as pathJoin, delimiter as pathDelimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';

import { createClock } from './kernel/clock.js';
import { createIdGenerator } from './kernel/id-generator.js';
import { createLogger, type LogLevel } from './kernel/logger.js';
import {
  LOGGING_NAMESPACE,
  loggingConfigSchema,
  loggingDefaults,
  dailyLogFileName,
  type LoggingConfig,
} from './logging/config.js';
import {
  createFileLogSink,
  combineSinks,
} from './logging/log-file-sink.js';
import { createEventBus, type EventBus } from './kernel/event-bus.js';
import { ValidationError } from './kernel/error-types.js';

import { createConfigSchemaRegistry } from './config/config-schema-registry.js';
import { buildConfig } from './config/config-validator.js';
import { envSource, mergeSources } from './config/config-loader.js';
import { collectSecretPaths } from './config/config-redactor.js';

import {
  COPILOT_NAMESPACE,
  copilotConfigSchema,
  copilotDefaults,
  type CopilotConfig,
} from './provider/copilot-adapter/config.js';
import {
  AGENCY_NAMESPACE,
  agencyConfigSchema,
  agencyDefaults,
  type AgencyConfig,
} from './provider/agency-adapter/config.js';
import {
  SESSION_NAMESPACE,
  sessionConfigSchema,
  sessionDefaults,
  type SessionConfig,
} from './session/config.js';
import {
  USAGE_NAMESPACE,
  usageConfigSchema,
  usageDefaults,
  type UsageConfig,
} from './usage/config.js';
import {
  CREDIT_NAMESPACE,
  creditConfigSchema,
  creditDefaults,
  type CreditConfig,
} from './credit/config.js';
import {
  AGGREGATION_NAMESPACE,
  aggregationConfigSchema,
  aggregationDefaults,
  type AggregationConfig,
} from './aggregation/config.js';
import {
  PERSISTENCE_NAMESPACE,
  persistenceConfigSchema,
  persistenceDefaults,
  type PersistenceConfig,
} from './persistence/config.js';
import {
  SUMMARIZER_NAMESPACE,
  summarizerConfigSchema,
  summarizerDefaults,
  type SummarizerConfig,
} from './summarizer/config.js';
import {
  API_NAMESPACE,
  apiConfigSchema,
  apiDefaults,
  type ApiConfig,
} from './api/config.js';
import {
  TERMINAL_NAMESPACE,
  terminalConfigSchema,
  terminalDefaults,
  type TerminalConfig,
} from './terminal/config.js';
import {
  COPILOT_HISTORY_NAMESPACE,
  copilotHistoryConfigSchema,
  copilotHistoryDefaults,
  type CopilotHistoryConfig,
} from './copilot-history/config.js';

import { createProcessSpawner } from './provider/process-kernel/process-spawner.js';
import { createAgencyBootstrapper } from './agency-bootstrap/agency-bootstrapper.js';
import { createAgencyDetector } from './agency-bootstrap/agency-detector.js';
import {
  agencyInstallPaths,
  resolveAgencyExecutable,
} from './agency-bootstrap/agency-install-paths.js';
import { withTabsDisabled } from './copilot-settings/copilot-settings.js';
import {
  createGithubAuth,
  type GhRunner,
} from './github-auth/github-auth-service.js';
import { buildGithubCredentialEnv } from './github-auth/github-credential-env.js';
import { createGithubDeviceAuth } from './github-auth/github-device-auth.js';
import {
  createAzureDevOpsAuth,
  type GitRunResult,
} from './azure-auth/azure-devops-auth.js';
import { createCopilotProvider } from './provider/copilot-adapter/copilot-provider.js';
import { createAgencyProvider } from './provider/agency-adapter/agency-provider.js';
import { createProviderRegistry } from './provider/provider-registry.js';
import { createProviderResolver } from './provider/provider-resolver.js';

import { createSessionFactory } from './session/session-factory.js';
import { createSessionLauncher } from './session/session-launcher.js';
import { createSessionReconciler } from './session/session-reconciler.js';

import { createNodePtySpawner } from './terminal/node-pty-spawner.js';
import { createTerminalManager } from './terminal/terminal-manager.js';
import { attachTerminalWs } from './terminal/terminal-ws-server.js';

import { createUsageRecorder } from './usage/usage-recorder.js';
import { createCliUsageTailer } from './usage/cli-usage-tailer.js';

import { createBuiltinCreditStrategies } from './credit/credit-strategies.js';
import { createCreditCalculator } from './credit/credit-calculator.js';

import { createDatabase } from './persistence/db/connection.js';
import { createFeatureRepo } from './persistence/feature-repo.js';
import { createRepoRepo } from './persistence/repo-repo.js';
import { createRepoService } from './repo/repo-service.js';
import { provisionRepo } from './repo/repo-provisioner.js';
import { listGithubRepos } from './repo/github-repo-lister.js';
import { listGithubPulls, getGithubPull } from './repo/github-pr-lister.js';
import {
  listAzureRepos,
  type AzureHttpResponse,
} from './repo/azure-repo-lister.js';
import {
  listAzurePulls,
  getAzurePull,
  parseAzureRepoUrl,
  fetchAzureUser,
} from './repo/azure-pr-lister.js';
import { provisionPrWorktree } from './repo/pr-worktree-provisioner.js';
import { createPrFeatureService } from './repo/pr-feature-service.js';
import { createGithubCommentsGateway } from './repo/github-pr-comments.js';
import { createAzureCommentsGateway } from './repo/azure-pr-comments.js';
import { createPrCommentsService } from './pr-review/pr-comments-service.js';
import { createGithubApprovalGateway } from './repo/github-pr-approval.js';
import { createAzureApprovalGateway } from './repo/azure-pr-approval.js';
import { createPrApprovalService } from './pr-review/pr-approval-service.js';
import type {
  PrCommentsGateway,
  PrCommentsGatewayResolver,
} from './pr-review/pr-comments-contract.js';
import type {
  PrApprovalGateway,
  PrApprovalGatewayResolver,
} from './pr-review/pr-approval-contract.js';
import type { Repository } from './repo/repo-contract.js';
import type {
  RemotePullRequest,
  PullFilter,
} from './repo/remote-pr-contract.js';
import { parseAzureTarget } from './azure-auth/azure-devops-auth.js';
import { createSessionRepo } from './persistence/session-repo.js';
import { createUsageRepo } from './persistence/usage-repo.js';
import { createTranscriptRepo } from './persistence/transcript-repo.js';
import { createSummaryRepo } from './persistence/summary-repo.js';
import { createSessionSummaryRepo } from './persistence/session-summary-repo.js';
import { createAggregateRepo } from './persistence/aggregate-repo.js';
import { createFeatureAnalytics } from './aggregation/feature-analytics.js';
import { createUsageDetailService } from './usage-detail/usage-detail-service.js';

import { createFeatureService } from './feature/feature-service.js';
import { createFeatureWorkSummaryService } from './feature/feature-work-summary.js';
import { createCopilotHistoryDb } from './copilot-history/copilot-history-db.js';
import { createCopilotHistoryReader } from './copilot-history/copilot-history-reader.js';
import { createSessionFilesRepo } from './persistence/session-files-repo.js';
import { createWorkspaceAdmin } from './workspace/workspace-admin-service.js';

import { createTranscriptCollector } from './summarizer/transcript-collector.js';
import { createSummaryRunner } from './summarizer/summary-runner.js';
import { createSessionSummaryRunner } from './session-summary/session-summary-runner.js';
import { createSessionSummaryAutoTrigger } from './session-summary/session-summary-auto.js';
import {
  CONTEXT_NAMESPACE,
  contextConfigSchema,
  contextDefaults,
  type ContextConfig,
} from './context-store/config.js';
import { createContextService } from './context-store/context-service.js';
import { createContextBroadcaster } from './context-store/context-broadcaster.js';
import { createContextMergeRunner } from './context-store/context-merge-runner.js';
import { createContextMergeAutoTrigger } from './context-store/context-merge-auto.js';
import { createContextRepo } from './persistence/context-repo.js';
import { createConfigOverrideRepo } from './persistence/config-override-repo.js';
import { createConfigOverrideService } from './config/config-override-service.js';
import { overridesToConfig } from './config/config-override-store.js';
import { createCliSessionStore } from './provider/cli-store/cli-session-store.js';
import {
  createCliUsageStore,
  toUsageEvent,
} from './provider/cli-store/cli-usage-store.js';
import { createSessionImportService } from './session-import/session-import-service.js';
import {
  SESSION_IMPORT_NAMESPACE,
  sessionImportConfigSchema,
  sessionImportDefaults,
  type SessionImportConfig,
} from './session-import/config.js';
import { createSkillsService } from './skills/skills-service.js';
import { seedBuiltinSkills } from './skills/skill-seed.js';
import { createSkillsRepo } from './persistence/skills-repo.js';
import {
  SKILLS_NAMESPACE,
  skillsConfigSchema,
  skillsDefaults,
  type SkillsConfig,
} from './skills/config.js';
import { createMetaRunner } from './meta/meta-runner.js';
import { MetaSessionPool } from './meta/acp/acp-pool.js';
import { AcpClient } from './meta/acp/acp-client.js';
import { AcpProcessAdapter } from './meta/acp/acp-process-adapter.js';
import { createAcpMetaRunner } from './meta/acp/acp-meta-runner.js';
import {
  META_NAMESPACE,
  metaConfigSchema,
  metaDefaults,
  type MetaConfig,
} from './meta/config.js';
import { createMcpService } from './mcp/mcp-service.js';
import { createMcpConfigFileStore } from './mcp/mcp-config-file-adapter.js';
import { createMcpToolInspector } from './mcp/mcp-tool-inspector-adapter.js';
import {
  MCP_NAMESPACE,
  mcpConfigSchema,
  mcpDefaults,
  type McpConfig,
} from './mcp/config.js';
import { createFeatureTasksService } from './feature-tasks/feature-tasks-service.js';
import { createTaskPlanRunner } from './feature-tasks/task-plan-runner.js';
import { createFeatureTasksRepo } from './persistence/feature-tasks-repo.js';
import {
  FEATURE_TASKS_NAMESPACE,
  featureTasksConfigSchema,
  featureTasksDefaults,
  type FeatureTasksConfig,
} from './feature-tasks/config.js';
import { createFeatureTreeService } from './feature-tree/feature-tree-service.js';
import { createFeatureGroupsRepo } from './persistence/feature-groups-repo.js';
import {
  FEATURE_TREE_NAMESPACE,
  featureTreeConfigSchema,
  featureTreeDefaults,
  type FeatureTreeConfig,
} from './feature-tree/config.js';
import { createIdeUsageService } from './ide-usage/ide-usage-service.js';
import { createIdeUsageRepo } from './persistence/ide-usage-repo.js';
import {
  IDE_USAGE_NAMESPACE,
  ideUsageConfigSchema,
  ideUsageDefaults,
  type IdeUsageConfig,
} from './ide-usage/config.js';
import {
  REPOSITORY_CONTEXT_NAMESPACE,
  repositoryContextConfigSchema,
  repositoryContextDefaults,
  type RepositoryContextConfig,
} from './repository-context/config.js';
import { createGitRepositoryAdapter } from './repository-context/git-repository-adapter.js';
import { createFilesystemEvidenceCollector } from './repository-context/filesystem-evidence-adapter.js';
import { createRepositoryEvidenceService } from './repository-context/repository-evidence-service.js';
import { createRepositoryAnalysisExecutor } from './repository-context/repository-analysis-executor.js';
import { createTemporaryPromptFileFactory } from './repository-context/temporary-prompt-file-adapter.js';
import { createRepositoryContextGenerator } from './repository-context/repository-context-generator.js';
import {
  createRepositoryContextCoordinator,
  type RepositoryContextEventMap,
} from './repository-context/repository-context-coordinator.js';
import { createRepositoryContextRepo } from './persistence/repository-context-repo.js';
import {
  REPO_INSIGHTS_NAMESPACE,
  repoInsightsConfigSchema,
  repoInsightsDefaults,
  type RepoInsightsConfig,
} from './repo-insights/config.js';
import { createRepoInsightsService } from './repo-insights/repo-insights-service.js';
import { createRepoInsightsGitAdapter } from './repo-insights/repo-insights-git-adapter.js';
import { createSessionBootstrap } from './session-bootstrap/session-bootstrap.js';
import {
  PR_REVIEW_NAMESPACE,
  prReviewConfigSchema,
  prReviewDefaults,
  type PrReviewConfig,
} from './pr-review/config.js';
import { createPrReviewService } from './pr-review/pr-review-service.js';
import { createLanguageAnalyzerRegistry } from './pr-review/language-analyzer.js';
import { createCSharpAnalyzer } from './pr-review/csharp-analyzer.js';
import { nodeChangeGraphFs } from './pr-review/change-graph-fs.js';
import { createPrReviewReconciler } from './pr-review/pr-review-reconciler.js';
import { createMetaUsageReader } from './pr-review/meta-usage-reader.js';
import { createPrDiffCollector } from './pr-review/pr-diff-collector.js';
import type { PrReviewEventMap } from './pr-review/pr-review-contract.js';
import { createPrReviewRepo } from './persistence/pr-review-repo.js';

import { createApiRoutes } from './api/routes.js';
import { mountRoutes } from './api/express-adapter.js';
import { subscribeStream, type StreamEventMap } from './api/usage-stream.js';
import type { ConfigObject } from './config/config-contract.js';
import type { Session } from './session/session-contract.js';
import type { IAIProvider } from './provider/provider-contract.js';

const ENV_PREFIX = 'CW';

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function main(): void {
  const registry = createConfigSchemaRegistry();
  registry.register({ namespace: COPILOT_NAMESPACE, schema: copilotConfigSchema, defaults: copilotDefaults });
  registry.register({ namespace: AGENCY_NAMESPACE, schema: agencyConfigSchema, defaults: agencyDefaults });
  registry.register({ namespace: SESSION_NAMESPACE, schema: sessionConfigSchema, defaults: sessionDefaults });
  registry.register({ namespace: USAGE_NAMESPACE, schema: usageConfigSchema, defaults: usageDefaults });
  registry.register({ namespace: CREDIT_NAMESPACE, schema: creditConfigSchema, defaults: creditDefaults });
  registry.register({ namespace: AGGREGATION_NAMESPACE, schema: aggregationConfigSchema, defaults: aggregationDefaults });
  registry.register({ namespace: PERSISTENCE_NAMESPACE, schema: persistenceConfigSchema, defaults: persistenceDefaults });
  registry.register({ namespace: LOGGING_NAMESPACE, schema: loggingConfigSchema, defaults: loggingDefaults });
  registry.register({ namespace: SUMMARIZER_NAMESPACE, schema: summarizerConfigSchema, defaults: summarizerDefaults });
  registry.register({ namespace: API_NAMESPACE, schema: apiConfigSchema, defaults: apiDefaults });
  registry.register({ namespace: TERMINAL_NAMESPACE, schema: terminalConfigSchema, defaults: terminalDefaults });
  registry.register({ namespace: COPILOT_HISTORY_NAMESPACE, schema: copilotHistoryConfigSchema, defaults: copilotHistoryDefaults });
  registry.register({ namespace: SESSION_IMPORT_NAMESPACE, schema: sessionImportConfigSchema, defaults: sessionImportDefaults });
  registry.register({ namespace: SKILLS_NAMESPACE, schema: skillsConfigSchema, defaults: skillsDefaults });
  registry.register({ namespace: META_NAMESPACE, schema: metaConfigSchema, defaults: metaDefaults });
  registry.register({ namespace: MCP_NAMESPACE, schema: mcpConfigSchema, defaults: mcpDefaults });
  registry.register({ namespace: FEATURE_TASKS_NAMESPACE, schema: featureTasksConfigSchema, defaults: featureTasksDefaults });
  registry.register({ namespace: FEATURE_TREE_NAMESPACE, schema: featureTreeConfigSchema, defaults: featureTreeDefaults });
  registry.register({ namespace: IDE_USAGE_NAMESPACE, schema: ideUsageConfigSchema, defaults: ideUsageDefaults });
  registry.register({ namespace: CONTEXT_NAMESPACE, schema: contextConfigSchema, defaults: contextDefaults });
  registry.register({
    namespace: REPOSITORY_CONTEXT_NAMESPACE,
    schema: repositoryContextConfigSchema,
    defaults: repositoryContextDefaults,
  });
  registry.register({
    namespace: REPO_INSIGHTS_NAMESPACE,
    schema: repoInsightsConfigSchema,
    defaults: repoInsightsDefaults,
  });
  registry.register({
    namespace: PR_REVIEW_NAMESPACE,
    schema: prReviewConfigSchema,
    defaults: prReviewDefaults,
  });

  // Phase 1 (bootstrap): resolve just enough config from defaults + environment
  // to locate on-disk storage and configure logging. Persisted overrides live
  // inside the workspace database, which we cannot open until we know its path,
  // so persistence and logging are intentionally env/default-only here.
  const bootConfig: ConfigObject = buildConfig({
    registry,
    sources: [envSource(process.env, ENV_PREFIX)],
    secretLookup: (name) => process.env[name],
  });
  const persistenceConfig = bootConfig[PERSISTENCE_NAMESPACE] as PersistenceConfig;
  const loggingConfig = bootConfig[LOGGING_NAMESPACE] as LoggingConfig;

  const logLevel =
    (process.env.CW_LOG_LEVEL as LogLevel | undefined) ?? loggingConfig.level;
  const logFilePath = pathJoin(
    loggingConfig.directory,
    dailyLogFileName(loggingConfig.filePrefix, new Date()),
  );
  const consoleSink = (record: {
    level: Exclude<LogLevel, 'none'>;
    message: string;
    data?: unknown;
  }): void => {
    // eslint-disable-next-line no-console
    console[record.level === 'debug' ? 'log' : record.level](
      `[${record.level}] ${record.message}`,
      record.data ?? '',
    );
  };
  const logger = createLogger(
    logLevel,
    loggingConfig.toFile
      ? combineSinks(consoleSink, createFileLogSink({ filePath: logFilePath }))
      : consoleSink,
  );
  const clock = createClock();
  const ids = createIdGenerator();
  const bus = createEventBus<StreamEventMap>();

  // One-time migration from the pre-rebrand storage location. The app's data
  // directory identifier changed with the "Copilot Workspace" → "AI Project
  // Studio" rebrand, so on first launch under the new brand copy the previous
  // brand's data directory (workspace.db + usage/) to preserve existing
  // features, sessions, and usage history.
  const currentDataDir = dirname(persistenceConfig.databasePath);
  const previousBrandDataDir = currentDataDir
    .split(pathJoin('@ai-project-studio', 'desktop'))
    .join(pathJoin('@copilot-workspace', 'desktop'));
  if (
    previousBrandDataDir !== currentDataDir &&
    !existsSync(currentDataDir) &&
    existsSync(previousBrandDataDir)
  ) {
    cpSync(previousBrandDataDir, currentDataDir, { recursive: true });
    logger.info('Migrated data directory from previous brand', {
      from: previousBrandDataDir,
      to: currentDataDir,
    });
  }

  const legacyDatabasePath = pathJoin(
    process.cwd(),
    '.copilot-workspace',
    'workspace.db',
  );
  if (
    !existsSync(persistenceConfig.databasePath) &&
    existsSync(legacyDatabasePath)
  ) {
    ensureDir(persistenceConfig.databasePath);
    copyFileSync(legacyDatabasePath, persistenceConfig.databasePath);
    logger.info('Migrated legacy workspace database', {
      from: legacyDatabasePath,
      to: persistenceConfig.databasePath,
    });
  }

  // Persistence.
  ensureDir(persistenceConfig.databasePath);
  const db = createDatabase({ databasePath: persistenceConfig.databasePath });

  // Phase 2 (effective): now that the database is open, layer persisted,
  // user-editable overrides beneath the environment and rebuild the config.
  // Overrides win over defaults; the environment still wins over both.
  const configOverrideRepo = createConfigOverrideRepo(db);
  const overridesSource = {
    origin: 'overrides',
    data: overridesToConfig(configOverrideRepo.all()),
  };
  const config: ConfigObject = buildConfig({
    registry,
    sources: [overridesSource, envSource(process.env, ENV_PREFIX)],
    secretLookup: (name) => process.env[name],
  });
  const configOverrideService = createConfigOverrideService({
    store: configOverrideRepo,
    registry,
    clock,
    onChanged: (namespace) =>
      logger.info('Configuration override changed', { namespace }),
  });

  // Paths whose (pre-resolution) values reference a secret, so `GET /config`
  // can redact their resolved values instead of leaking them.
  const configSecretPaths = collectSecretPaths(
    mergeSources([
      { origin: 'defaults', data: registry.defaults() },
      overridesSource,
      envSource(process.env, ENV_PREFIX),
    ]),
  );

  const copilotConfig = config[COPILOT_NAMESPACE] as CopilotConfig;
  const agencyConfig = config[AGENCY_NAMESPACE] as AgencyConfig;
  const sessionConfig = config[SESSION_NAMESPACE] as SessionConfig;
  const usageConfig = config[USAGE_NAMESPACE] as UsageConfig;
  const creditConfig = config[CREDIT_NAMESPACE] as CreditConfig;
  const aggregationConfig = config[AGGREGATION_NAMESPACE] as AggregationConfig;
  const summarizerConfig = config[SUMMARIZER_NAMESPACE] as SummarizerConfig;
  const contextConfig = config[CONTEXT_NAMESPACE] as ContextConfig;
  const apiConfig = config[API_NAMESPACE] as ApiConfig;
  const terminalConfig = config[TERMINAL_NAMESPACE] as TerminalConfig;
  const copilotHistoryConfig = config[COPILOT_HISTORY_NAMESPACE] as CopilotHistoryConfig;
  const sessionImportConfig = config[SESSION_IMPORT_NAMESPACE] as SessionImportConfig;
  const skillsConfig = config[SKILLS_NAMESPACE] as SkillsConfig;
  const metaConfig = config[META_NAMESPACE] as MetaConfig;
  const mcpConfig = config[MCP_NAMESPACE] as McpConfig;
  const featureTasksConfig = config[FEATURE_TASKS_NAMESPACE] as FeatureTasksConfig;
  const featureTreeConfig = config[FEATURE_TREE_NAMESPACE] as FeatureTreeConfig;
  const ideUsageConfig = config[IDE_USAGE_NAMESPACE] as IdeUsageConfig;
  const repositoryContextConfig = config[
    REPOSITORY_CONTEXT_NAMESPACE
  ] as RepositoryContextConfig;
  const repoInsightsConfig = config[REPO_INSIGHTS_NAMESPACE] as RepoInsightsConfig;
  const prReviewConfig = config[PR_REVIEW_NAMESPACE] as PrReviewConfig;

  const featureRepo = createFeatureRepo(db);
  const repoService = createRepoService({ repo: createRepoRepo(db), ids, clock });
  const repositoryContextRepo = createRepositoryContextRepo(db);
  const sessionRepo = createSessionRepo(db);
  const reconciledCount = createSessionReconciler({
    sessions: sessionRepo,
    clock,
  }).reconcileOrphans();
  if (reconciledCount > 0) {
    logger.info('Reconciled orphaned sessions from previous run', {
      count: reconciledCount,
    });
  }
  const usageRepo = createUsageRepo(db);
  const transcriptRepo = createTranscriptRepo(db);
  const summaryRepo = createSummaryRepo(db);
  const sessionSummaryRepo = createSessionSummaryRepo(db);
  const sessionFilesRepo = createSessionFilesRepo(db);
  const contextRepo = createContextRepo(db);
  const aggregateRepo = createAggregateRepo(db, aggregationConfig);
  const featureAnalytics = createFeatureAnalytics({
    reader: aggregateRepo,
    sessions: sessionRepo,
    groups: createFeatureGroupsRepo(db),
    clock,
  });
  // Independent meta-only reader so IDE AI overhead is reported separately and
  // never affects the dev-cost feature/workspace rollups above.
  const ideUsageService = createIdeUsageService({
    reader: createIdeUsageRepo(db, ideUsageConfig),
  });

  // Providers. Registration is driven by a descriptor list so adding a new
  // provider is a one-line change: append a descriptor and toggle its config
  // `enabled` flag. A provider is registered only when enabled, keeping
  // disabled adapters intact and instantly re-enable-able via config.
  const spawner = createProcessSpawner(clock);

  // Ensures the bundled Microsoft `agency` CLI is installed. Detection probes the
  // per-user install location(s); the install is streamed to the UI on first run.
  // Lists immediate child folders of a directory, degrading to [] when absent so
  // the versioned-folder probe stays robust on a machine with no agency yet.
  const listDir = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir) : [];
  const currentAgencyPaths = (): string[] =>
    agencyInstallPaths(process.platform, process.env, homedir(), listDir);
  const agencyBootstrapper = createAgencyBootstrapper({
    platform: process.platform,
    detect: createAgencyDetector({
      paths: currentAgencyPaths,
      pathExists: existsSync,
    }),
    spawner,
    env: process.env as Record<string, string>,
  });

  // Prepends the installed agency executable's directory to this process's PATH.
  // node-pty resolves the bare `agency` command against the live process PATH at
  // spawn time, so this lets terminals find agency without an app restart — both
  // right after a first-run install and when agency lives in a versioned folder
  // that the registry PATH entry does not yet point at.
  const refreshAgencyPath = (): void => {
    const exe = resolveAgencyExecutable(currentAgencyPaths(), existsSync);
    if (!exe) {
      return;
    }
    const dir = dirname(exe);
    const current = process.env.PATH ?? '';
    const alreadyOnPath = current
      .split(pathDelimiter)
      .some((entry) => entry === dir);
    if (!alreadyOnPath) {
      process.env.PATH = current ? `${dir}${pathDelimiter}${current}` : dir;
    }
  };
  refreshAgencyPath();

  // Force the Copilot CLI's home-screen tab bar off for every session. The CLI
  // reads ~/.copilot/settings.json at launch and has no flag/env for this, so we
  // merge-write the setting on startup (before any session spawns), preserving
  // any other user settings and tolerating a missing/malformed file.
  try {
    const copilotSettingsPath = pathJoin(homedir(), '.copilot', 'settings.json');
    const existing = existsSync(copilotSettingsPath)
      ? readFileSync(copilotSettingsPath, 'utf8')
      : null;
    const next = withTabsDisabled(existing);
    if (next !== existing) {
      mkdirSync(dirname(copilotSettingsPath), { recursive: true });
      writeFileSync(copilotSettingsPath, next);
    }
  } catch {
    // Best-effort: a settings write failure must not block startup.
  }

  // Reuse the single GitHub login that agency/`gh` already established and
  // propagate it to every spawned session, so their git operations authenticate
  // non-interactively (no "Cannot prompt" failures). The credential env is
  // injected into this process's env; the session env-mapper copies process.env
  // into each session, so all sessions inherit the same login automatically.
  const ghRun: GhRunner = (args) =>
    new Promise((resolve) => {
      execFile('gh', args, { windowsHide: true }, (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    });
  const githubAuth = createGithubAuth({ run: ghRun });
  // Capture the current `gh` token into this process's env so every spawned
  // session's git operations authenticate non-interactively. `gh` rotates the
  // underlying OAuth token, so we re-read it periodically (and right after an
  // in-app sign-in) — spawned sessions read the live process.env, so a refresh
  // reaches every future session without a restart.
  // Reads the current `gh` token and propagates it to spawned sessions. This MUST
  // stay asynchronous: it runs at startup, hourly, and on every sign-in/sign-out.
  // A synchronous `execFileSync` here blocks the whole single-threaded backend
  // event loop until `gh` returns (up to 15s, longer if gh stalls on a locked
  // keychain/credential prompt), freezing every HTTP request and terminal
  // WebSocket — i.e. the entire IDE hangs. `execFile` keeps the loop responsive.
  const refreshGithubCredentialEnv = (): Promise<void> =>
    new Promise((resolve) => {
      execFile(
        'gh',
        ['auth', 'token'],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
        (err, stdout) => {
          if (!err) {
            const token = (stdout ?? '').trim();
            for (const [key, value] of Object.entries(
              buildGithubCredentialEnv(token),
            )) {
              process.env[key] = value;
            }
            if (token) {
              logger.info('GitHub auth propagated to sessions', {});
            }
          }
          // gh missing or not logged in — sessions keep whatever git credentials
          // the host already provides; /github/status surfaces this state.
          resolve();
        },
      );
    });
  void refreshGithubCredentialEnv();
  // Re-read the token hourly so a long-running IDE never spawns sessions with an
  // expired GitHub token.
  setInterval(() => void refreshGithubCredentialEnv(), 60 * 60 * 1000).unref();

  // In-app GitHub sign-in via the OAuth device flow, for users who have never
  // run `gh auth login`. The minted token is handed to `gh auth login
  // --with-token` so the rest of the app picks it up transparently.
  const githubDeviceAuth = createGithubDeviceAuth({
    httpPost: async (url, form) => {
      // Never let a stalled network call hang sign-in: abort after 15s so the
      // UI surfaces a clear "check your connection" error instead of an
      // indefinitely spinning modal.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams(form).toString(),
          signal: controller.signal,
        });
        const body = await res.json().catch(() => null);
        return { status: res.status, body };
      } catch (err) {
        const timedOut = controller.signal.aborted;
        throw new Error(
          timedOut
            ? 'GitHub did not respond in time. Check your network connection and try again.'
            : `Could not reach GitHub: ${err instanceof Error ? err.message : 'network error'}. Check your connection and try again.`,
        );
      } finally {
        clearTimeout(timer);
      }
    },
    ghLogin: (token) =>
      new Promise((resolve) => {
        const child = execFile(
          'gh',
          ['auth', 'login', '--with-token'],
          { windowsHide: true, timeout: 20_000 },
          (err, _stdout, stderr) => {
            const code =
              err && typeof (err as { code?: unknown }).code === 'number'
                ? (err as { code: number }).code
                : err
                  ? 1
                  : 0;
            resolve({ code, stderr: stderr ?? '' });
          },
        );
        child.stdin?.end(`${token}\n`);
      }),
  });
  // On a successful in-app sign-in, immediately propagate the new token to
  // sessions rather than waiting for the hourly refresh.
  const githubSignInPoll = async (deviceCode: string) => {
    const result = await githubDeviceAuth.poll(deviceCode);
    if (result.status === 'success') {
      await refreshGithubCredentialEnv();
    }
    return result;
  };
  // Sign out via `gh auth logout`, then immediately clear the propagated
  // credential from sessions rather than waiting for the hourly refresh.
  const githubSignOut = async () => {
    const status = await githubAuth.signOut();
    await refreshGithubCredentialEnv();
    return status;
  };

  // Azure DevOps auth, handled the way Visual Studio / Git Credential Manager
  // do, adapted for a background process: use OAuth (org-agnostic Entra tokens)
  // and GCM's browser sign-in flow rather than the WAM broker. The broker needs
  // a parent window we don't have when GCM is spawned in the background (it
  // would hang), whereas the browser flow launches the default browser and
  // caches a refresh token. The interactive sign-in primes that cache once;
  // spawned sessions then acquire access tokens silently against dev.azure.com
  // / *.visualstudio.com with no "Cannot prompt" failure.
  const gitRun = (
    args: string[],
    opts: { stdin?: string; interactive?: boolean; longRunning?: boolean } = {},
  ): Promise<GitRunResult> =>
    new Promise((resolve) => {
      const child = execFile(
        'git',
        args,
        {
          windowsHide: true,
          // Quick auth/status checks stay small; a worktree checkout of a large
          // monorepo streams megabytes of "Updating files: X%" progress to
          // stderr, which would blow a 1 MB cap (ENOBUFS kills the process), so
          // long-running git operations get a much larger buffer.
          maxBuffer: opts.longRunning ? 512 * 1024 * 1024 : 1024 * 1024,
          // A silent status check must never hang the sidebar "checking…" pill;
          // an interactive sign-in legitimately waits on the browser (unbounded),
          // and a worktree checkout of a huge repo legitimately runs for minutes
          // — but must still not hang *forever* if git stalls on a network read
          // or a credential wait, so it gets a generous finite ceiling rather
          // than no timeout at all.
          timeout: opts.interactive ? 0 : opts.longRunning ? 900_000 : 20_000,
          env: {
            ...process.env,
            // Sign-in may show the browser prompt; the silent status check must
            // never block on a prompt. Never use the WAM broker (needs a window
            // we don't have). OAuth avoids per-org PAT creation.
            GCM_INTERACTIVE: opts.interactive ? 'auto' : 'never',
            GIT_TERMINAL_PROMPT: opts.interactive ? '1' : '0',
            GCM_MSAUTH_USEBROKER: 'false',
            GCM_AZREPOS_CREDENTIALTYPE: 'oauth',
          },
        },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
      if (opts.stdin !== undefined) {
        child.stdin?.end(opts.stdin);
      }
    });
  const azureAuth = createAzureDevOpsAuth({
    config: (args) => gitRun(args),
    credential: (verb, input, credOpts) =>
      gitRun(['credential-manager', verb], {
        stdin: input,
        interactive: credOpts.interactive,
      }),
  });
  void azureAuth
    .configure()
    .then(() =>
      logger.info('Azure DevOps OAuth sign-in configured for sessions', {}),
    )
    .catch(() => {
      // git / GCM missing — Azure DevOps sign-in stays a no-op; sessions keep
      // whatever git credentials the host already provides.
    });

  // Repository layer wiring. Repos are cloned/attached with the same git + auth
  // the IDE already configured, and listed from each provider using the login
  // the IDE holds (GitHub via `gh`, Azure DevOps via the GCM OAuth token against
  // the REST API — no `az login` needed).
  const cloneRepo = (request: { remoteUrl: string; targetPath: string }) =>
    gitRun(['clone', request.remoteUrl, request.targetPath], {
      interactive: false,
    });
  const provisionRepoInput = (input: Parameters<typeof provisionRepo>[1]) =>
    provisionRepo({ clone: cloneRepo, pathExists: existsSync }, input);
  const listGithubReposFor = () => listGithubRepos(ghRun);
  // Azure DevOps REST calls must never hang the UI: a stalled connection (VPN
  // drop, proxy black-hole) on a bare `fetch` has no default timeout, so PR
  // listing, PR fetch and comment posting could spin forever. Bound every call
  // with an AbortController, the same way the GitHub device-flow call is bounded.
  const AZURE_HTTP_TIMEOUT_MS = 30_000;
  const azureFetch = async (
    url: string,
    init: RequestInit,
  ): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AZURE_HTTP_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          'Azure DevOps did not respond in time. Check your network ' +
            'connection (or VPN) and try again.',
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  const azureHttpGet = async (
    url: string,
    token: string,
  ): Promise<AzureHttpResponse> => {
    const response = await azureFetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const body = response.ok ? await response.json() : null;
    return { status: response.status, body };
  };
  const azureHttpSend = async (
    method: 'POST' | 'PATCH' | 'PUT',
    url: string,
    token: string,
    payload: unknown,
  ): Promise<AzureHttpResponse> => {
    const response = await azureFetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  };
  const azureHttpPost = (url: string, token: string, payload: unknown) =>
    azureHttpSend('POST', url, token, payload);
  const azureHttpPatch = (url: string, token: string, payload: unknown) =>
    azureHttpSend('PATCH', url, token, payload);
  const azureHttpPut = (url: string, token: string, payload: unknown) =>
    azureHttpSend('PUT', url, token, payload);
  const listAzureReposFor = (org: string) =>
    listAzureRepos(
      {
        token: (o) => azureAuth.token(parseAzureTarget(o)),
        httpGet: azureHttpGet,
      },
      org,
    );

  // Pull-request review wiring. PRs are listed and fetched with the same
  // provider logins the IDE already holds (GitHub via `gh`, Azure DevOps via the
  // GCM OAuth token against the REST API). The chosen PR is checked out into a
  // dedicated git worktree so a review runs isolated from the main checkout and
  // multiple reviews can run at once. The provider dispatch lives here (the
  // composition root) so the review service stays pure and unit-tested.
  const azurePullDeps = {
    token: (o: string) => azureAuth.token(parseAzureTarget(o)),
    httpGet: azureHttpGet,
  };
  const listPullsFor = async (
    repo: Repository,
    filter: PullFilter,
  ): Promise<RemotePullRequest[]> => {
    if (repo.provider === 'github') {
      const status = await githubAuth.status();
      return listGithubPulls(ghRun, repo.name, {
        currentUser: status.login ?? undefined,
        filter,
      });
    }
    const target = parseAzureRepoUrl(repo.remoteUrl);
    if (!target) {
      throw new ValidationError(
        `Cannot parse an Azure DevOps repository from ${repo.remoteUrl}`,
      );
    }
    const currentUser =
      (await fetchAzureUser(azurePullDeps, target.org)) ?? undefined;
    return listAzurePulls(azurePullDeps, target, { currentUser, filter });
  };
  const getPullFor = (
    repo: Repository,
    number: number,
  ): Promise<RemotePullRequest | null> => {
    if (repo.provider === 'github') {
      return getGithubPull(ghRun, repo.name, number);
    }
    const target = parseAzureRepoUrl(repo.remoteUrl);
    if (!target) {
      throw new ValidationError(
        `Cannot parse an Azure DevOps repository from ${repo.remoteUrl}`,
      );
    }
    return getAzurePull(azurePullDeps, target, number);
  };

  // Resolves the working directory a session's terminal runs in: a PR review's
  // dedicated worktree when set, otherwise the local checkout of the repository
  // its feature belongs to, falling back to the workspace cwd for repo-less
  // (legacy) features.
  const resolveSessionCwd = (featureId: string): string | undefined => {
    const feature = featureRepo.get(featureId);
    if (feature?.checkoutPath) {
      return feature.checkoutPath;
    }
    const repoId = feature?.repoId;
    if (!repoId) {
      return undefined;
    }
    return repoService.list().find((r) => r.id === repoId)?.localPath;
  };

  const cliStorePath = pathJoin(
    homedir(),
    copilotHistoryConfig.subdir,
    copilotHistoryConfig.databaseFile,
  );
  const agencyImportStore = createCliSessionStore({
    databasePath: cliStorePath,
    provider: AGENCY_NAMESPACE,
    limit: sessionImportConfig.maxSessions,
    maxTitleChars: sessionImportConfig.maxTitleChars,
    emptyTitlePlaceholder: sessionImportConfig.emptyTitlePlaceholder,
  });
  // Live usage source: the CLI records per-request tokens/credits/model in its
  // own session-store.db (keyed by the same --session-id we launch with), so we
  // tail that instead of the OTel file exporter (which the CLI TUI never emits).
  const cliUsageStore = createCliUsageStore({ databasePath: cliStorePath });
  const providers = createProviderRegistry();
  const providerDescriptors: Array<{
    namespace: string;
    enabled: boolean;
    defaultModel: string;
    create: () => IAIProvider;
  }> = [
    {
      namespace: COPILOT_NAMESPACE,
      enabled: copilotConfig.enabled,
      defaultModel: copilotConfig.defaultModel,
      create: () =>
        createCopilotProvider(copilotConfig, { spawner, baseEnv: process.env }),
    },
    {
      namespace: AGENCY_NAMESPACE,
      enabled: agencyConfig.enabled,
      defaultModel: agencyConfig.defaultModel,
      create: () =>
        createAgencyProvider(agencyConfig, {
          spawner,
          baseEnv: process.env,
          importStore: agencyImportStore,
        }),
    },
  ];

  const enabledProviders: IAIProvider[] = [];
  const defaultModelByProvider: Record<string, string> = {};
  for (const descriptor of providerDescriptors) {
    if (!descriptor.enabled) {
      continue;
    }
    const provider = descriptor.create();
    providers.register(provider);
    enabledProviders.push(provider);
    defaultModelByProvider[descriptor.namespace] = descriptor.defaultModel;
  }
  if (enabledProviders.length === 0) {
    throw new Error('No providers are enabled; enable at least one provider in config.');
  }

  const resolver = createProviderResolver(providers, {
    defaultProvider: enabledProviders[0].id,
    defaultModelByProvider,
  });

  // Credit engine.
  const creditCalculator = createCreditCalculator(
    createBuiltinCreditStrategies(creditConfig),
    { activeStrategy: creditConfig.activeStrategy, unit: creditConfig.unit },
  );
  const usageRecorder = createUsageRecorder({
    calculator: creditCalculator,
    repo: usageRepo,
    bus: bus as unknown as Parameters<typeof createUsageRecorder>[0]['bus'],
  });

  // Session orchestration.
  ensureDir(`${sessionConfig.usageDir}/.keep`);
  const factory = createSessionFactory({ ids, clock, config: sessionConfig });
  const launcher = createSessionLauncher({
    resolver,
    factory,
    transcriptStore: transcriptRepo,
    bus: bus as unknown as Parameters<typeof createSessionLauncher>[0]['bus'],
    clock,
    config: sessionConfig,
    bootstrap: {
      assertFeatureReady: (featureId) =>
        sessionBootstrap.assertFeatureReady(featureId),
      composeForSession: (session) =>
        sessionBootstrap.composeForSession(session),
    },
  });

  // Reconciles a session's persisted resolved model with a freshly-observed
  // one (from a usage row or a CLI model-change announcement), persisting and
  // broadcasting only on a real change so the UI's per-session model label
  // stays in lockstep with the CLI.
  const resolveSessionModel = (sessionId: string, resolvedModel: string) => {
    const stored = sessionRepo.get(sessionId);
    if (stored && stored.resolvedModel !== resolvedModel) {
      const updated = { ...stored, resolvedModel };
      sessionRepo.save(updated);
      bus.emit('session.updated', updated);
    }
  };

  let terminalManager: ReturnType<typeof createTerminalManager> | null = null;
  // Interactive terminal: launches the real CLI chat TUI in a PTY per session,
  // reusing the same usage-capture pipeline via session.started/ended events.
  terminalManager = createTerminalManager({
    spawner: createNodePtySpawner(),
    providers,
    bus: bus as unknown as Parameters<typeof createTerminalManager>[0]['bus'],
    clock,
    config: terminalConfig,
    transcriptStore: transcriptRepo,
    // Lazily composes current repository, feature-memory, and skill context.
    bootstrap: {
      composeForSession: (session) =>
        sessionBootstrap.composeForSession(session),
    },
    // Records the files each session creates/edits by parsing the tool's own
    // terminal output (per-session PTY = unambiguous attribution), replacing
    // brittle filesystem watching of a shared working directory.
    sessionFiles: sessionFilesRepo,
    // Mirror mid-session model switches the CLI prints (e.g. "Model changed …
    // to <model>") onto the session's resolved model, so the UI updates as soon
    // as the user changes model in the CLI, not just on the next usage row.
    onModelResolved: resolveSessionModel,
    home: homedir(),
  });
  const terminalCwd = process.env.CW_WORKSPACE_CWD ?? process.cwd();

  // Live usage capture: poll the CLI's own usage store for each running session
  // and feed new per-request usage into the same credit/record pipeline. This
  // updates the live AIC/token/model meter for both one-shot and interactive
  // sessions, since the CLI attributes usage to our launch --session-id.
  const tailers = new Map<string, ReturnType<typeof createCliUsageTailer>>();
  const makeUsageTailer = (session: Session) =>
    createCliUsageTailer({
      intervalMs: usageConfig.livePollIntervalMs,
      read: () =>
        cliUsageStore.listBySession(session.id).map((row) =>
          toUsageEvent(row, {
            featureId: session.featureId,
            provider: session.provider,
            requestedModel: session.requestedModel,
          }),
        ),
      onUsage: (event) => {
        resolveSessionModel(event.sessionId, event.resolvedModel);
        usageRecorder.record(event, session.kind);
      },
    });
  bus.on('session.started', (session: Session) => {
    sessionRepo.save(session);
    const tailer = makeUsageTailer(session);
    tailers.set(session.id, tailer);
    try {
      tailer.start();
    } catch (error) {
      logger.error('Usage tailer failed', error);
    }
  });
  bus.on('session.ended', (session: Session) => {
    sessionRepo.save(session);
    const tailer = tailers.get(session.id);
    if (!tailer) {
      return;
    }
    tailers.delete(session.id);
    try {
      tailer.drain();
    } catch (error) {
      logger.error('Final usage flush failed', error);
    } finally {
      tailer.stop();
    }
  });
  bus.on('session.discarded', (sessionId: string) => {
    // The session is being deleted: release its live usage tailer without a
    // final drain (its usage rows are being purged) and without re-persisting.
    const tailer = tailers.get(sessionId);
    if (!tailer) {
      return;
    }
    tailers.delete(sessionId);
    tailer.stop();
  });

  // Feature + summarizer.
  const featureService = createFeatureService({
    repo: featureRepo,
    ids,
    clock,
    repos: repoService,
  });
  // Seed a default "Scratchpad" feature on a fresh workspace so a new instance
  // can start ad-hoc sessions immediately. No-op once any feature exists.
  featureService.ensureScratchpad();
  // Layered shared-context store: durable, curated instructions injected at
  // launch and live-pushed into running sessions. The broadcaster fans context
  // writes out to affected running terminals; the merge runner curates a
  // feature's document from each completed dev session.
  const contextBroadcaster = createContextBroadcaster({
    features: featureService,
    sessions: sessionRepo,
    inject: (sessionId, instructions) =>
      terminalManager!.injectInstructions(sessionId, instructions),
    config: contextConfig,
  });
  const contextService = createContextService({
    store: contextRepo,
    clock,
    config: contextConfig,
    onUpdated: (doc) => contextBroadcaster.onUpdated(doc),
  });
  const contextMerger = createContextMergeRunner({
    sessions: sessionRepo,
    features: featureService,
    transcripts: transcriptRepo,
    launcher,
    service: contextService,
    summarizerConfig,
    config: contextConfig,
    onStatus: (status) => bus.emit('context.status', status),
  });
  const contextMergeAuto = createContextMergeAutoTrigger({
    merger: contextMerger,
    config: contextConfig,
    logger,
  });
  bus.on('session.ended', (session: Session) => {
    contextMergeAuto.onSessionEnded(session);
  });
  // Per-turn usage drill-down: exposes every credit/token event at the
  // session, feature, and repository scopes for the UI breakdown modal.
  const usageDetailService = createUsageDetailService({
    usage: usageRepo,
    sessions: sessionRepo,
    features: featureService,
  });
  const cliStoreDatabasePath = pathJoin(
    homedir(),
    copilotHistoryConfig.subdir,
    copilotHistoryConfig.databaseFile,
  );
  const copilotHistoryReader = createCopilotHistoryReader({
    source: createCopilotHistoryDb({
      databasePath: cliStoreDatabasePath,
    }),
    config: copilotHistoryConfig,
  });
  const workSummaryService = createFeatureWorkSummaryService({
    sessions: sessionRepo,
    reader: copilotHistoryReader,
    summaries: sessionSummaryRepo,
  });
  const collector = createTranscriptCollector({
    features: featureService,
    sessions: sessionRepo,
    transcripts: transcriptRepo,
    config: summarizerConfig,
  });
  const summarizer = createSummaryRunner({
    collector,
    launcher,
    transcripts: transcriptRepo,
    summaries: summaryRepo,
    features: featureService,
    clock,
    config: summarizerConfig,
  });
  const sessionSummarizer = createSessionSummaryRunner({
    sessions: sessionRepo,
    features: featureService,
    transcripts: transcriptRepo,
    launcher,
    store: sessionSummaryRepo,
    clock,
    config: summarizerConfig,
  });
  // Auto-generate a concise AI summary when a dev session ends, so the work
  // summary shows short summaries instead of the raw checkpoint dump without
  // the user having to trigger it. Guarded against meta recursion + duplicates.
  const sessionSummaryAuto = createSessionSummaryAutoTrigger({
    summarizer: sessionSummarizer,
    logger,
  });
  bus.on('session.ended', (session: Session) => {
    sessionSummaryAuto.onSessionEnded(session);
  });

  const sessionImportService = createSessionImportService({
    providers,
    sessions: sessionRepo,
    features: featureService,
    clock,
    config: sessionConfig,
  });

  const skillsService = createSkillsService({
    repo: createSkillsRepo(db),
    ids,
    clock,
    features: featureService,
    sessions: sessionRepo,
    config: skillsConfig,
  });
  // Populate the curated starter skills on first run (no-op once any skill
  // exists), so the Skills view is useful out of the box.
  seedBuiltinSkills(skillsService);

  // Shared headless-AI primitive reused by every AI feature (summaries,
  // task plans, …) so they drive the CLI the same config-driven way.
  const metaRunner = createMetaRunner({
    launcher,
    transcripts: transcriptRepo,
    config: metaConfig,
  });
  // Provider-agnostic MCP server management. The provider's own CLI reports
  // where its MCP config lives (via a meta-session), so no path is hardcoded.
  const mcpService = createMcpService({
    registry: providers,
    meta: metaRunner,
    files: createMcpConfigFileStore(),
    tools: createMcpToolInspector(),
    config: mcpConfig,
    liveReload: (providerId, command) => {
      let applied = 0;
      for (const session of sessionRepo.listAll()) {
        if (
          session.provider === providerId &&
          session.status === 'running' &&
          terminalManager?.injectInstructions(session.id, command)
        ) {
          applied += 1;
        }
      }
      return applied;
    },
  });
  const gitRepository = createGitRepositoryAdapter();
  const repositoryEvidence = createRepositoryEvidenceService({
    revisionLookup: gitRepository,
    collector: createFilesystemEvidenceCollector({
      trackedFiles: gitRepository,
    }),
    config: repositoryContextConfig,
  });
  const repositoryContextCoordinator = createRepositoryContextCoordinator({
    repositories: repoService,
    contexts: repositoryContextRepo,
    revisions: gitRepository,
    evidence: repositoryEvidence,
    generator: createRepositoryContextGenerator({
      executor: createRepositoryAnalysisExecutor(
        metaRunner,
        createTemporaryPromptFileFactory(),
      ),
      config: repositoryContextConfig,
    }),
    clock,
    bus: bus as unknown as EventBus<RepositoryContextEventMap>,
  });
  const repoInsightsService = createRepoInsightsService({
    repos: repoService,
    git: createRepoInsightsGitAdapter(),
    clock,
    config: repoInsightsConfig,
  });
  // PR review: when a PR review feature is created, generate an AI summary and
  // core analysis from the ready repository context plus the PR's diff, and
  // stream the result to the review panel.
  const prReviewRepo = createPrReviewRepo(db);
  // Fail any review left mid-generation by a previous run: its metasessions died
  // with the process, so without this the review page would spin on "Analyzing…"
  // forever. Marking orphaned steps failed surfaces a Retry instead.
  const prReviewsReconciled = createPrReviewReconciler({
    reviews: prReviewRepo,
    clock,
  }).reconcileOrphans();
  if (prReviewsReconciled > 0) {
    logger.info('Reconciled orphaned PR reviews from previous run', {
      count: prReviewsReconciled,
    });
  }
  const prDiffCollector = createPrDiffCollector({
    git: {
      run: (args, cwd) =>
        new Promise((resolve) => {
          execFile(
            'git',
            args,
            {
              cwd,
              windowsHide: true,
              // A large PR diff can be tens of MB. Buffer generously so it does
              // not error, and treat an overflow past even this as a truncated
              // success below (the collector only keeps a bounded slice anyway).
              maxBuffer: 64 * 1024 * 1024,
              timeout: 20_000,
            },
            (err, stdout, stderr) => {
              // Node reports a maxBuffer overflow with a non-numeric string code
              // and still hands back the captured (truncated) stdout. The diff
              // collector clamps the patch to its own budget, so a truncated but
              // present diff is fine — surface it as success instead of a bogus
              // "git diff failed: exit 1".
              const overflowed =
                (err as { code?: unknown } | null)?.code ===
                'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER';
              const code =
                overflowed || !err
                  ? 0
                  : typeof (err as { code?: unknown }).code === 'number'
                    ? (err as { code: number }).code
                    : 1;
              resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
            },
          );
        }),
    },
    config: prReviewConfig,
  });
  // Warm ACP metasession pool (opt-in). When enabled it keeps a few live
  // `copilot --acp` sessions ready so PR review steps lease a warm session
  // instead of cold-spawning a CLI (MCP proxies + auth) per request. The cold
  // `metaRunner` remains the fallback and the default for every other feature.
  const warmPoolCfg = metaConfig.warmPool;
  const warmExecutable =
    warmPoolCfg.executable === 'copilot'
      ? copilotConfig.executable
      : warmPoolCfg.executable;
  let warmMetaRunner: Pick<typeof metaRunner, 'runDetailed'> | null = null;
  if (warmPoolCfg.enabled) {
    const pool = new MetaSessionPool({
      size: warmPoolCfg.size,
      createClient: () =>
        new AcpClient(
          new AcpProcessAdapter({ executable: warmExecutable }),
          {
            initializeTimeoutMs: warmPoolCfg.initializeTimeoutMs,
            turnTimeoutMs: warmPoolCfg.turnTimeoutMs,
          },
        ),
    });
    pool.start().catch((error: unknown) => {
      logger.error('Warm ACP pool failed to start; falling back to cold path', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    warmMetaRunner = createAcpMetaRunner({
      pool,
      newSessionId: () => `acp-${randomUUID()}`,
    });
  }
  const prReviewService = createPrReviewService({
    reviews: prReviewRepo,
    diffs: prDiffCollector,
    analyzers: createLanguageAnalyzerRegistry([createCSharpAnalyzer()]),
    changeGraphFs: nodeChangeGraphFs,
    ai: warmMetaRunner ?? metaRunner,
    inlinePrompts: warmMetaRunner !== null,
    metaUsage: createMetaUsageReader({ usage: usageRepo }),
    temporaryPrompts: createTemporaryPromptFileFactory(),
    clock,
    bus: bus as unknown as EventBus<PrReviewEventMap>,
    config: prReviewConfig,
  });
  // Provider-agnostic live PR comments. The resolver picks the GitHub (`gh`) or
  // Azure DevOps (REST) gateway from the repo's provider, so the comments
  // service stays pure and every operation posts against the real pull request.
  const prCommentsGateways: PrCommentsGatewayResolver = {
    resolve: (repo, pull): PrCommentsGateway => {
      if (repo.provider === 'github') {
        return createGithubCommentsGateway(ghRun, {
          repo: repo.name,
          number: pull.number,
        });
      }
      const target = parseAzureRepoUrl(repo.remoteUrl);
      if (!target) {
        throw new ValidationError(
          `Cannot parse an Azure DevOps repository from ${repo.remoteUrl}`,
        );
      }
      return createAzureCommentsGateway(
        {
          token: (o: string) => azureAuth.token(parseAzureTarget(o)),
          httpGet: azureHttpGet,
          httpPost: azureHttpPost,
          httpPatch: azureHttpPatch,
        },
        { ...target, pullRequestId: pull.number },
      );
    },
  };
  const prCommentsService = createPrCommentsService({
    reviews: { get: (featureId) => prReviewService.find(featureId) },
    repos: { get: (id) => repoService.list().find((r) => r.id === id) ?? null },
    gateways: prCommentsGateways,
  });
  const prApprovalGateways: PrApprovalGatewayResolver = {
    resolve: (repo, pull): PrApprovalGateway => {
      if (repo.provider === 'github') {
        return createGithubApprovalGateway(ghRun, {
          repo: repo.name,
          number: pull.number,
        });
      }
      const target = parseAzureRepoUrl(repo.remoteUrl);
      if (!target) {
        throw new ValidationError(
          `Cannot parse an Azure DevOps repository from ${repo.remoteUrl}`,
        );
      }
      return createAzureApprovalGateway(
        {
          token: (o: string) => azureAuth.token(parseAzureTarget(o)),
          httpGet: azureHttpGet,
          httpPut: azureHttpPut,
        },
        { ...target, pullRequestId: pull.number },
      );
    },
  };
  const prApprovalService = createPrApprovalService({
    reviews: { get: (featureId) => prReviewService.find(featureId) },
    repos: { get: (id) => repoService.list().find((r) => r.id === id) ?? null },
    gateways: prApprovalGateways,
  });
  const prFeatureService = createPrFeatureService({
    repos: repoService,
    listPulls: listPullsFor,
    getPull: getPullFor,
    provisionWorktree: (repo, pull) =>
      provisionPrWorktree(
        { git: (args) => gitRun(args, { longRunning: true }), pathExists: existsSync },
        {
          repoLocalPath: repo.localPath,
          provider: repo.provider,
          number: pull.number,
          sourceBranch: pull.sourceBranch,
        },
      ),
    features: featureService,
    reviews: prReviewService,
  });
  const workspaceAdmin = createWorkspaceAdmin({
    features: featureService,
    sessions: sessionRepo,
    usage: usageRepo,
    transcripts: transcriptRepo,
    summaries: summaryRepo,
    sessionFiles: sessionFilesRepo,
    terminals: terminalManager!,
    prReviews: prReviewService,
    sharedContext: contextService,
  });
  const sessionBootstrap = createSessionBootstrap({
    features: featureService,
    sessions: sessionRepo,
    summaries: sessionSummaryRepo,
    skills: skillsService,
    contexts: repositoryContextCoordinator,
    sharedContext: contextService,
    config: repositoryContextConfig,
  });
  void repositoryContextCoordinator.synchronizeSaved().catch((error) => {
    logger.error('Repository context startup check failed', error);
  });
  const featureTasksRepo = createFeatureTasksRepo(db);
  const featureTasksService = createFeatureTasksService({
    repo: featureTasksRepo,
    runner: createTaskPlanRunner({
      meta: metaRunner,
      features: featureService,
      repo: featureTasksRepo,
      ids,
      clock,
      config: featureTasksConfig,
    }),
    features: featureService,
    ids,
    clock,
    config: featureTasksConfig,
  });
  const featureTreeService = createFeatureTreeService({
    groups: createFeatureGroupsRepo(db),
    sessions: sessionRepo,
    features: featureService,
    ids,
    clock,
    config: featureTreeConfig,
  });

  // HTTP API.
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountRoutes(
    router,
    createApiRoutes({
      features: featureService,
      admin: workspaceAdmin,
      launcher,
      resolver,
      factory,
      sessionConfig,
      sessions: sessionRepo,
      sessionHistory: copilotHistoryReader,
      providers,
      aggregates: featureAnalytics,
      summarizer,
      summaries: summaryRepo,
      workSummaries: workSummaryService,
      sessionFiles: sessionFilesRepo,
      sessionSummaries: sessionSummarizer,
      imports: sessionImportService,
      skills: skillsService,
      sessionBootstrap,
      // Session-scoped skills can only be tagged after the session (and its
      // terminal) is open, so launch-time seeding never sees them. Inject them
      // into the live terminal on tag so they actually take effect.
      injectSessionSkill: (sessionId, skillId) => {
        const instructions = skillsService.instructionsForSkill(skillId);
        if (instructions.length > 0) {
          terminalManager!.injectInstructions(sessionId, instructions);
        }
      },
      // Reverse a session-scoped skill on its live terminal when it is removed,
      // so its guidance is actively undone (negated / plan cancelled).
      removeSessionSkill: (sessionId, skillId) => {
        const prompt = skillsService.removalPromptForSkill(skillId);
        if (prompt.length > 0) {
          terminalManager!.injectInstructions(sessionId, prompt);
        }
      },
      tasks: featureTasksService,
      tree: featureTreeService,
      ideUsage: ideUsageService,
      usageDetail: usageDetailService,
      mcp: mcpService,
      configRegistry: registry,
      currentConfig: config,
      configSecretPaths,
      configOverrides: configOverrideService,
      agencyStatus: () => agencyBootstrapper.status(),
      githubStatus: () => githubAuth.status(),
      githubSignInStart: () => githubDeviceAuth.start(),
      githubSignInPoll,
      githubSignOut,
      azureStatus: (target) => azureAuth.status(target),
      azureSignIn: (target) => azureAuth.signIn(target),
      repos: repoService,
      repositoryContexts: repositoryContextCoordinator,
      repoInsights: repoInsightsService,
      provisionRepo: provisionRepoInput,
      listGithubRepos: listGithubReposFor,
      listAzureRepos: listAzureReposFor,
      prFeatures: prFeatureService,
      prReviews: prReviewService,
      prComments: prCommentsService,
      prApprovals: prApprovalService,
      context: contextService,
      logger,
    }),
  );
  app.use(apiConfig.basePath, router);

  app.get(`${apiConfig.basePath}/stream`, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const off = subscribeStream(bus, {
      send: (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      },
    });
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, apiConfig.sseHeartbeatMs);
    req.on('close', () => {
      clearInterval(heartbeat);
      off();
      res.end();
    });
  });

  // First-run agency install, streamed as SSE so the UI can show live progress.
  // A shared in-flight promise dedupes concurrent connections (e.g. UI reconnect)
  // onto a single install run.
  let agencyInstall: Promise<void> | null = null;
  app.get(`${apiConfig.basePath}/agency/install`, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const send = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    if (!agencyInstall) {
      agencyInstall = agencyBootstrapper
        .install((event) => send(event))
        .then((status) => {
          if (status.installed) {
            refreshAgencyPath();
          }
        })
        .catch((error) => {
          // Surface the failure to the subscriber and log it, instead of
          // leaving an unhandled rejection.
          logger.error('Agency install failed', error);
          try {
            send({ kind: 'error', line: 'Installation failed. Please retry.' });
          } catch {
            /* subscriber already disconnected — nothing to notify */
          }
        })
        .finally(() => {
          // Always clear the in-flight marker so a failed install can be
          // retried; otherwise every later connection would wedge forever on
          // the "already in progress" branch.
          agencyInstall = null;
        });
    } else {
      // Already installing from another connection; report current status so a
      // late subscriber is not left hanging on a stream with no terminal event.
      send(
        agencyBootstrapper.status().installed
          ? { kind: 'done' }
          : { kind: 'line', line: 'Installation already in progress…' },
      );
    }
    req.on('close', () => {
      res.end();
    });
  });

  // Serve the packaged UI same-origin (desktop app) when a dist dir is given,
  // so the renderer's relative /api and SSE calls need no CORS.
  const uiDist = process.env.CW_UI_DIST;
  if (uiDist && existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith(apiConfig.basePath)) {
        next();
        return;
      }
      res.sendFile(pathJoin(uiDist, 'index.html'));
    });
    logger.info(`Serving desktop UI from ${uiDist}`);
  }

  const server = app.listen(apiConfig.port, apiConfig.host, () => {
    logger.info(
      `AI Project Studio API listening on http://${apiConfig.host}:${apiConfig.port}${apiConfig.basePath}`,
    );
  });

  if (terminalConfig.enabled) {
    attachTerminalWs({
      server,
      manager: terminalManager!,
      config: terminalConfig,
      getSession: (id) => sessionRepo.get(id),
      cwd: terminalCwd,
      resolveCwd: (session) => resolveSessionCwd(session.featureId),
      logger,
    });
    logger.info(`Interactive terminal WebSocket at ${terminalConfig.wsPath}`);
  }

  // Graceful shutdown: stop usage tailers, tear down live PTYs, stop accepting
  // connections and close the database so SQLite is not left mid-write when the
  // desktop shell kills the backend process.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down…`);
    for (const tailer of tailers.values()) {
      tailer.stop();
    }
    terminalManager!.shutdown();
    server.close();
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main();
