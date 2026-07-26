import { mkdirSync, existsSync, copyFileSync, cpSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import express from 'express';

import { createClock } from './kernel/clock.js';
import { createIdGenerator } from './kernel/id-generator.js';
import { createLogger, type LogLevel } from './kernel/logger.js';
import { createEventBus } from './kernel/event-bus.js';

import { createConfigSchemaRegistry } from './config/config-schema-registry.js';
import { buildConfig } from './config/config-validator.js';
import { envSource } from './config/config-loader.js';

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
import { createSessionRepo } from './persistence/session-repo.js';
import { createUsageRepo } from './persistence/usage-repo.js';
import { createTranscriptRepo } from './persistence/transcript-repo.js';
import { createSummaryRepo } from './persistence/summary-repo.js';
import { createSessionSummaryRepo } from './persistence/session-summary-repo.js';
import { createAggregateRepo } from './persistence/aggregate-repo.js';
import { createFeatureAnalytics } from './aggregation/feature-analytics.js';

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
import { createSkillsRepo } from './persistence/skills-repo.js';
import {
  SKILLS_NAMESPACE,
  skillsConfigSchema,
  skillsDefaults,
  type SkillsConfig,
} from './skills/config.js';
import { createMetaRunner } from './meta/meta-runner.js';
import {
  META_NAMESPACE,
  metaConfigSchema,
  metaDefaults,
  type MetaConfig,
} from './meta/config.js';
import { createFeatureTasksService } from './feature-tasks/feature-tasks-service.js';
import { createTaskPlanRunner } from './feature-tasks/task-plan-runner.js';
import { createFeatureTasksRepo } from './persistence/feature-tasks-repo.js';
import {
  FEATURE_TASKS_NAMESPACE,
  featureTasksConfigSchema,
  featureTasksDefaults,
  type FeatureTasksConfig,
} from './feature-tasks/config.js';
import { createIdeUsageService } from './ide-usage/ide-usage-service.js';
import { createIdeUsageRepo } from './persistence/ide-usage-repo.js';
import {
  IDE_USAGE_NAMESPACE,
  ideUsageConfigSchema,
  ideUsageDefaults,
  type IdeUsageConfig,
} from './ide-usage/config.js';

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
  registry.register({ namespace: SUMMARIZER_NAMESPACE, schema: summarizerConfigSchema, defaults: summarizerDefaults });
  registry.register({ namespace: API_NAMESPACE, schema: apiConfigSchema, defaults: apiDefaults });
  registry.register({ namespace: TERMINAL_NAMESPACE, schema: terminalConfigSchema, defaults: terminalDefaults });
  registry.register({ namespace: COPILOT_HISTORY_NAMESPACE, schema: copilotHistoryConfigSchema, defaults: copilotHistoryDefaults });
  registry.register({ namespace: SESSION_IMPORT_NAMESPACE, schema: sessionImportConfigSchema, defaults: sessionImportDefaults });
  registry.register({ namespace: SKILLS_NAMESPACE, schema: skillsConfigSchema, defaults: skillsDefaults });
  registry.register({ namespace: META_NAMESPACE, schema: metaConfigSchema, defaults: metaDefaults });
  registry.register({ namespace: FEATURE_TASKS_NAMESPACE, schema: featureTasksConfigSchema, defaults: featureTasksDefaults });
  registry.register({ namespace: IDE_USAGE_NAMESPACE, schema: ideUsageConfigSchema, defaults: ideUsageDefaults });

  const config: ConfigObject = buildConfig({
    registry,
    sources: [envSource(process.env, ENV_PREFIX)],
    secretLookup: (name) => process.env[name],
  });

  const copilotConfig = config[COPILOT_NAMESPACE] as CopilotConfig;
  const agencyConfig = config[AGENCY_NAMESPACE] as AgencyConfig;
  const sessionConfig = config[SESSION_NAMESPACE] as SessionConfig;
  const usageConfig = config[USAGE_NAMESPACE] as UsageConfig;
  const creditConfig = config[CREDIT_NAMESPACE] as CreditConfig;
  const aggregationConfig = config[AGGREGATION_NAMESPACE] as AggregationConfig;
  const persistenceConfig = config[PERSISTENCE_NAMESPACE] as PersistenceConfig;
  const summarizerConfig = config[SUMMARIZER_NAMESPACE] as SummarizerConfig;
  const apiConfig = config[API_NAMESPACE] as ApiConfig;
  const terminalConfig = config[TERMINAL_NAMESPACE] as TerminalConfig;
  const copilotHistoryConfig = config[COPILOT_HISTORY_NAMESPACE] as CopilotHistoryConfig;
  const sessionImportConfig = config[SESSION_IMPORT_NAMESPACE] as SessionImportConfig;
  const skillsConfig = config[SKILLS_NAMESPACE] as SkillsConfig;
  const metaConfig = config[META_NAMESPACE] as MetaConfig;
  const featureTasksConfig = config[FEATURE_TASKS_NAMESPACE] as FeatureTasksConfig;
  const ideUsageConfig = config[IDE_USAGE_NAMESPACE] as IdeUsageConfig;

  const logLevel = (process.env.CW_LOG_LEVEL as LogLevel | undefined) ?? 'info';
  const logger = createLogger(logLevel, (record) => {
    // eslint-disable-next-line no-console
    console[record.level === 'debug' ? 'log' : record.level](
      `[${record.level}] ${record.message}`,
      record.data ?? '',
    );
  });
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
  const featureRepo = createFeatureRepo(db);
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
  const aggregateRepo = createAggregateRepo(db, aggregationConfig);
  const featureAnalytics = createFeatureAnalytics({
    reader: aggregateRepo,
    sessions: sessionRepo,
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
  });

  // Interactive terminal: launches the real CLI chat TUI in a PTY per session,
  // reusing the same usage-capture pipeline via session.started/ended events.
  const terminalManager = createTerminalManager({
    spawner: createNodePtySpawner(),
    providers,
    bus: bus as unknown as Parameters<typeof createTerminalManager>[0]['bus'],
    clock,
    config: terminalConfig,
    transcriptStore: transcriptRepo,
    // Lazily resolves the skills service (created below) at launch time.
    skills: {
      instructionsForSession: (id) => skillsService.instructionsForSession(id),
    },
    // Records the files each session creates/edits by parsing the tool's own
    // terminal output (per-session PTY = unambiguous attribution), replacing
    // brittle filesystem watching of a shared working directory.
    sessionFiles: sessionFilesRepo,
    home: homedir(),
  });
  const terminalCwd = process.env.CW_WORKSPACE_CWD ?? process.cwd();

  // Live usage capture: poll the CLI's own usage store for each running session
  // and feed new per-request usage into the same credit/record pipeline. This
  // updates the live AIC/token/model meter for both one-shot and interactive
  // sessions, since the CLI attributes usage to our launch --session-id.
  const tailers = new Map<string, ReturnType<typeof createCliUsageTailer>>();
  const resolveSessionModel = (sessionId: string, resolvedModel: string) => {
    const stored = sessionRepo.get(sessionId);
    if (stored && stored.resolvedModel !== resolvedModel) {
      const updated = { ...stored, resolvedModel };
      sessionRepo.save(updated);
      bus.emit('session.updated', updated);
    }
  };
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
  const featureService = createFeatureService({ repo: featureRepo, ids, clock });
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
  const workspaceAdmin = createWorkspaceAdmin({
    features: featureService,
    sessions: sessionRepo,
    usage: usageRepo,
    transcripts: transcriptRepo,
    summaries: summaryRepo,
    sessionFiles: sessionFilesRepo,
    terminals: terminalManager,
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

  // Shared headless-AI primitive reused by every AI feature (summaries,
  // task plans, …) so they drive the CLI the same config-driven way.
  const metaRunner = createMetaRunner({
    launcher,
    transcripts: transcriptRepo,
    config: metaConfig,
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
      providers,
      aggregates: featureAnalytics,
      summarizer,
      summaries: summaryRepo,
      workSummaries: workSummaryService,
      sessionFiles: sessionFilesRepo,
      sessionSummaries: sessionSummarizer,
      imports: sessionImportService,
      skills: skillsService,
      // Session-scoped skills can only be tagged after the session (and its
      // terminal) is open, so launch-time seeding never sees them. Inject them
      // into the live terminal on tag so they actually take effect.
      injectSessionSkill: (sessionId, skillId) => {
        const instructions = skillsService.instructionsForSkill(skillId);
        if (instructions.length > 0) {
          terminalManager.injectInstructions(sessionId, instructions);
        }
      },
      tasks: featureTasksService,
      ideUsage: ideUsageService,
      configRegistry: registry,
      currentConfig: config,
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
      manager: terminalManager,
      config: terminalConfig,
      getSession: (id) => sessionRepo.get(id),
      cwd: terminalCwd,
      logger,
    });
    logger.info(`Interactive terminal WebSocket at ${terminalConfig.wsPath}`);
  }
}

main();
