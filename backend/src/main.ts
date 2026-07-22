import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import express from 'express';
import chokidar from 'chokidar';

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

import { readUsageEvents } from './usage/otel-file-reader.js';
import {
  createUsageTailer,
  type FileWatcher,
} from './usage/otel-file-tailer.js';
import { createUsageRecorder } from './usage/usage-recorder.js';

import { createBuiltinCreditStrategies } from './credit/credit-strategies.js';
import { createCreditCalculator } from './credit/credit-calculator.js';

import { createDatabase } from './persistence/db/connection.js';
import { createFeatureRepo } from './persistence/feature-repo.js';
import { createSessionRepo } from './persistence/session-repo.js';
import { createUsageRepo } from './persistence/usage-repo.js';
import { createTranscriptRepo } from './persistence/transcript-repo.js';
import { createSummaryRepo } from './persistence/summary-repo.js';
import { createAggregateRepo } from './persistence/aggregate-repo.js';
import { createFeatureAnalytics } from './aggregation/feature-analytics.js';

import { createFeatureService } from './feature/feature-service.js';
import { createWorkspaceAdmin } from './workspace/workspace-admin-service.js';

import { createTranscriptCollector } from './summarizer/transcript-collector.js';
import { createSummaryRunner } from './summarizer/summary-runner.js';

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
  const aggregateRepo = createAggregateRepo(db, aggregationConfig);
  const featureAnalytics = createFeatureAnalytics({
    reader: aggregateRepo,
    sessions: sessionRepo,
    clock,
  });

  // Providers.
  const spawner = createProcessSpawner(clock);
  const providers = createProviderRegistry();
  const enabledProviders: IAIProvider[] = [];
  if (copilotConfig.enabled) {
    const p = createCopilotProvider(copilotConfig, { spawner, baseEnv: process.env });
    providers.register(p);
    enabledProviders.push(p);
  }
  if (agencyConfig.enabled) {
    const p = createAgencyProvider(agencyConfig, { spawner, baseEnv: process.env });
    providers.register(p);
    enabledProviders.push(p);
  }
  if (enabledProviders.length === 0) {
    throw new Error('No providers are enabled; enable copilot or agency in config.');
  }

  const resolver = createProviderResolver(providers, {
    defaultProvider: enabledProviders[0].id,
    defaultModelByProvider: {
      [COPILOT_NAMESPACE]: copilotConfig.defaultModel,
      [AGENCY_NAMESPACE]: agencyConfig.defaultModel,
    },
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
  });
  const terminalCwd = process.env.CW_WORKSPACE_CWD ?? process.cwd();

  // Live usage capture: tail each session's OTel file while it runs.
  const watcherFactory = (filePath: string): FileWatcher => {
    const fsWatcher = chokidar.watch(filePath, { ignoreInitial: false });
    return {
      onChange(cb) {
        fsWatcher.on('add', () => void cb());
        fsWatcher.on('change', () => void cb());
      },
      close: () => fsWatcher.close(),
    };
  };
  const tailers = new Map<string, ReturnType<typeof createUsageTailer>>();
  const resolveSessionModel = (sessionId: string, resolvedModel: string) => {
    const stored = sessionRepo.get(sessionId);
    if (stored && stored.resolvedModel !== resolvedModel) {
      sessionRepo.save({ ...stored, resolvedModel });
    }
  };
  bus.on('session.started', (session: Session) => {
    sessionRepo.save(session);
    const tailer = createUsageTailer(session.usageFilePath, {
      watch: watcherFactory,
      readEvents: (path) => readUsageEvents(path, usageConfig),
      onUsage: (event) => {
        resolveSessionModel(event.sessionId, event.resolvedModel);
        usageRecorder.record(event, session.kind);
      },
    });
    tailers.set(session.id, tailer);
    void tailer.start().catch((error) => logger.error('Usage tailer failed', error));
  });
  bus.on('session.ended', (session: Session) => {
    sessionRepo.save(session);
    const tailer = tailers.get(session.id);
    if (!tailer) {
      return;
    }
    tailers.delete(session.id);
    void tailer
      .stop()
      .then(() => readUsageEvents(session.usageFilePath, usageConfig))
      .then((events) => {
        if (events.length > 0) {
          for (const event of events) {
            resolveSessionModel(event.sessionId, event.resolvedModel);
          }
          usageRecorder.recordAll(events, session.kind);
        }
      })
      .catch((error) => logger.error('Final usage flush failed', error));
  });

  // Feature + summarizer.
  const featureService = createFeatureService({ repo: featureRepo, ids, clock });
  const workspaceAdmin = createWorkspaceAdmin({
    features: featureService,
    sessions: sessionRepo,
    usage: usageRepo,
    transcripts: transcriptRepo,
    summaries: summaryRepo,
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
      `Copilot Workspace API listening on http://${apiConfig.host}:${apiConfig.port}${apiConfig.basePath}`,
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
