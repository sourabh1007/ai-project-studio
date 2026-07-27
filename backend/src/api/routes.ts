import type { ConfigObject } from '../config/config-contract.js';
import type { ConfigSchemaRegistry } from '../config/config-schema-registry.js';
import type { Logger } from '../kernel/logger.js';
import type { FeatureAnalyticsService } from '../aggregation/feature-analytics.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { FeatureWorkSummaryService } from '../feature/feature-work-summary-contract.js';
import type { SessionFilesStore } from '../session-files/session-files-contract.js';
import type { SessionSummarizer } from '../session-summary/session-summary-contract.js';
import type { SessionImportService } from '../session-import/session-import-contract.js';
import type { SkillsService } from '../skills/skills-service.js';
import type { FeatureTasksService } from '../feature-tasks/feature-tasks-service.js';
import type { IdeUsageService } from '../ide-usage/ide-usage-service.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { ProviderResolver } from '../provider/provider-resolver.js';
import type { SessionConfig } from '../session/config.js';
import type { SessionFactory } from '../session/session-factory.js';
import type { SessionLauncher } from '../session/session-launcher.js';
import type { SessionRepo } from '../session/session-repo-port.js';
import type { FeatureSummarizer } from '../summarizer/summarizer-contract.js';
import type { SummaryStore } from '../summarizer/summary-store-port.js';
import type { WorkspaceAdmin } from '../workspace/workspace-admin-service.js';
import type { AgencyStatus } from '../agency-bootstrap/agency-bootstrapper.js';
import { createAgencyRoutes } from './agency-controller.js';
import type { GithubAuthStatus } from '../github-auth/github-auth-service.js';
import { createGithubRoutes } from './github-controller.js';
import { createAggregateRoutes } from './aggregate-controller.js';
import { createConfigRoutes } from './config-controller.js';
import { createFeatureRoutes } from './feature-controller.js';
import { createProviderRoutes } from './provider-controller.js';
import { createSessionRoutes } from './session-controller.js';
import { createTerminalRoutes } from './terminal-controller.js';
import { createSummaryRoutes } from './summary-controller.js';
import { createWorkSummaryRoutes } from './work-summary-controller.js';
import { createSessionFilesRoutes } from './session-files-controller.js';
import { createSessionSummaryRoutes } from './session-summary-controller.js';
import { createSessionImportRoutes } from './session-import-controller.js';
import { createSkillsRoutes } from './skills-controller.js';
import { createFeatureTasksRoutes } from './feature-tasks-controller.js';
import { createIdeUsageRoutes } from './ide-usage-controller.js';
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
  workSummaries: FeatureWorkSummaryService;
  sessionFiles: Pick<SessionFilesStore, 'list'>;
  sessionSummaries: SessionSummarizer;
  imports: SessionImportService;
  skills: SkillsService;
  /** Applies a freshly-tagged session skill to that session's live terminal. */
  injectSessionSkill?: (sessionId: string, skillId: string) => void;
  /** Reverses a session skill on its live terminal when it is untagged. */
  removeSessionSkill?: (sessionId: string, skillId: string) => void;
  tasks: FeatureTasksService;
  ideUsage: IdeUsageService;
  configRegistry: ConfigSchemaRegistry;
  currentConfig: ConfigObject;
  /** Reports whether the bundled `agency` CLI is installed. */
  agencyStatus: () => AgencyStatus;
  /** Reports the IDE's current GitHub authentication status. */
  githubStatus: () => Promise<GithubAuthStatus>;
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
      skills: deps.skills,
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
    ...createWorkSummaryRoutes({ workSummaries: deps.workSummaries }),
    ...createSessionFilesRoutes({ sessionFiles: deps.sessionFiles }),
    ...createSessionSummaryRoutes({
      sessionSummaries: deps.sessionSummaries,
    }),
    ...createSessionImportRoutes({ imports: deps.imports }),
    ...createSkillsRoutes({
      skills: deps.skills,
      injectSessionSkill: deps.injectSessionSkill,
      removeSessionSkill: deps.removeSessionSkill,
    }),
    ...createFeatureTasksRoutes({ tasks: deps.tasks }),
    ...createIdeUsageRoutes({ ideUsage: deps.ideUsage }),
    ...createConfigRoutes({
      registry: deps.configRegistry,
      current: deps.currentConfig,
    }),
    ...createAgencyRoutes({ agencyStatus: deps.agencyStatus }),
    ...createGithubRoutes({ githubStatus: deps.githubStatus }),
  ];
}
