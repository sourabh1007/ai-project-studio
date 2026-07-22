import type { ConfigObject } from '../config/config-contract.js';
import type { ConfigSchemaRegistry } from '../config/config-schema-registry.js';
import type { Logger } from '../kernel/logger.js';
import type { FeatureAnalyticsService } from '../aggregation/feature-analytics.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { ProviderResolver } from '../provider/provider-resolver.js';
import type { SessionConfig } from '../session/config.js';
import type { SessionFactory } from '../session/session-factory.js';
import type { SessionLauncher } from '../session/session-launcher.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { FeatureSummarizer } from '../summarizer/summarizer-contract.js';
import type { SummaryStore } from '../summarizer/summary-store-port.js';
import type { WorkspaceAdmin } from '../workspace/workspace-admin-service.js';
import { createAggregateRoutes } from './aggregate-controller.js';
import { createConfigRoutes } from './config-controller.js';
import { createFeatureRoutes } from './feature-controller.js';
import { createProviderRoutes } from './provider-controller.js';
import { createSessionRoutes } from './session-controller.js';
import { createTerminalRoutes } from './terminal-controller.js';
import { createSummaryRoutes } from './summary-controller.js';
import type { Route } from './http-contract.js';

export interface ApiRoutesDeps {
  features: FeatureService;
  admin: WorkspaceAdmin;
  launcher: SessionLauncher;
  resolver: ProviderResolver;
  factory: SessionFactory;
  sessionConfig: SessionConfig;
  sessions: SessionRepo;
  providers: ProviderRegistry;
  aggregates: FeatureAnalyticsService;
  summarizer: FeatureSummarizer;
  summaries: SummaryStore;
  configRegistry: ConfigSchemaRegistry;
  currentConfig: ConfigObject;
  logger: Logger;
}

/** Assembles the full route table from every controller. */
export function createApiRoutes(deps: ApiRoutesDeps): Route[] {
  return [
    ...createFeatureRoutes({ features: deps.features, admin: deps.admin }),
    ...createSessionRoutes({
      launcher: deps.launcher,
      sessions: deps.sessions,
      admin: deps.admin,
      logger: deps.logger,
    }),
    ...createTerminalRoutes({
      resolver: deps.resolver,
      factory: deps.factory,
      sessions: deps.sessions,
      config: deps.sessionConfig,
    }),
    ...createProviderRoutes({ registry: deps.providers }),
    ...createAggregateRoutes({ analytics: deps.aggregates }),
    ...createSummaryRoutes({
      summarizer: deps.summarizer,
      summaries: deps.summaries,
    }),
    ...createConfigRoutes({
      registry: deps.configRegistry,
      current: deps.currentConfig,
    }),
  ];
}
