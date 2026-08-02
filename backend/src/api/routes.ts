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
import type {
  DeviceCodeStart,
  DevicePollResult,
} from '../github-auth/github-device-auth.js';
import { createGithubRoutes } from './github-controller.js';
import type {
  AzureDevOpsStatus,
  AzureTarget,
} from '../azure-auth/azure-devops-auth.js';
import { createAzureRoutes } from './azure-controller.js';
import type { RepoService } from '../repo/repo-service.js';
import type { CreateRepositoryInput } from '../repo/repo-contract.js';
import type { RemoteRepo } from '../repo/remote-repo-contract.js';
import type { ProvisionRepoInput } from '../repo/repo-provisioner.js';
import type { PrFeatureService } from '../repo/pr-feature-service.js';
import type { PrReviewService } from '../pr-review/pr-review-service.js';
import type { RepositoryContextCoordinator } from '../repository-context/repository-context-coordinator.js';
import { createRepoRoutes } from './repo-controller.js';
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
import { createPrReviewRoutes } from './pr-review-controller.js';
import { createIdeUsageRoutes } from './ide-usage-controller.js';
import type { Route } from './http-contract.js';
import type { SessionBootstrap } from '../session-bootstrap/session-bootstrap.js';

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
  sessionBootstrap: SessionBootstrap;
  /** Applies a freshly-tagged session skill to that session's live terminal. */
  injectSessionSkill?: (sessionId: string, skillId: string) => void;
  /** Reverses a session skill on its live terminal when it is untagged. */
  removeSessionSkill?: (sessionId: string, skillId: string) => void;
  tasks: FeatureTasksService;
  ideUsage: IdeUsageService;
  configRegistry: ConfigSchemaRegistry;
  currentConfig: ConfigObject;
  /**
   * Dotted config paths whose values were resolved from secret references and
   * must be redacted from `GET /config`.
   */
  configSecretPaths: readonly string[];
  /** Reports whether the bundled `agency` CLI is installed. */
  agencyStatus: () => AgencyStatus;
  /** Reports the IDE's current GitHub authentication status. */
  githubStatus: () => Promise<GithubAuthStatus>;
  /** Begins an in-app GitHub device-flow sign-in. */
  githubSignInStart: () => Promise<DeviceCodeStart>;
  /** Polls an in-app GitHub device-flow sign-in for completion. */
  githubSignInPoll: (deviceCode: string) => Promise<DevicePollResult>;
  /** Logs the IDE's GitHub account out and returns the resulting status. */
  githubSignOut: () => Promise<GithubAuthStatus>;
  /** Reports whether GCM has a cached Azure DevOps credential for a target. */
  azureStatus: (target: AzureTarget) => Promise<AzureDevOpsStatus>;
  /** Triggers an interactive Azure DevOps sign-in and caches the credential. */
  azureSignIn: (target: AzureTarget) => Promise<AzureDevOpsStatus>;
  /** The repository layer the workspace is organized around. */
  repos: RepoService;
  repositoryContexts: RepositoryContextCoordinator;
  /** Clones or attaches an existing checkout, yielding a repo create input. */
  provisionRepo: (input: ProvisionRepoInput) => Promise<CreateRepositoryInput>;
  /** Lists the authenticated user's GitHub repositories. */
  listGithubRepos: () => Promise<RemoteRepo[]>;
  /** Lists repositories across an Azure DevOps organization's projects. */
  listAzureRepos: (org: string) => Promise<RemoteRepo[]>;
  /** Lists a repo's pull requests and turns one into a review feature. */
  prFeatures: PrFeatureService;
  /** Automated AI reviews for PR review features. */
  prReviews: PrReviewService;
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
      bootstrap: deps.sessionBootstrap,
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
    ...createPrReviewRoutes({ prReviews: deps.prReviews }),
    ...createIdeUsageRoutes({ ideUsage: deps.ideUsage }),
    ...createConfigRoutes({
      registry: deps.configRegistry,
      current: deps.currentConfig,
      secretPaths: deps.configSecretPaths,
    }),
    ...createAgencyRoutes({ agencyStatus: deps.agencyStatus }),
    ...createGithubRoutes({
      githubStatus: deps.githubStatus,
      githubSignInStart: deps.githubSignInStart,
      githubSignInPoll: deps.githubSignInPoll,
      githubSignOut: deps.githubSignOut,
    }),
    ...createAzureRoutes({
      azureStatus: deps.azureStatus,
      azureSignIn: deps.azureSignIn,
    }),
    ...createRepoRoutes({
      repos: deps.repos,
      repositoryContexts: deps.repositoryContexts,
      provision: deps.provisionRepo,
      listGithubRepos: deps.listGithubRepos,
      listAzureRepos: deps.listAzureRepos,
      prFeatures: deps.prFeatures,
    }),
  ];
}
