import type { ConfigObject } from '../config/config-contract.js';
import type { ConfigSchemaRegistry } from '../config/config-schema-registry.js';
import type { ConfigOverrideService } from '../config/config-override-service.js';
import type { Logger } from '../kernel/logger.js';
import type { FeatureAnalyticsService } from '../aggregation/feature-analytics.js';
import type { FeatureService } from '../feature/feature-service.js';
import type { FeatureWorkSummaryService } from '../feature/feature-work-summary-contract.js';
import type { SessionFilesStore } from '../session-files/session-files-contract.js';
import type { SessionSummarizer } from '../session-summary/session-summary-contract.js';
import type { SessionImportService } from '../session-import/session-import-contract.js';
import type { SkillsService } from '../skills/skills-service.js';
import type { FeatureTasksService } from '../feature-tasks/feature-tasks-service.js';
import type { FeatureTreeService } from '../feature-tree/feature-tree-service.js';
import type { IdeUsageService } from '../ide-usage/ide-usage-service.js';
import type { UsageDetailService } from '../usage-detail/usage-detail-service.js';
import type { McpService } from '../mcp/mcp-service.js';
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
import { createHealthRoutes } from './health-controller.js';
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
import type { PrCommentsService } from '../pr-review/pr-comments-contract.js';
import type { PrApprovalService } from '../pr-review/pr-approval-contract.js';
import type { PrDescriptionService } from '../pr-review/pr-description-contract.js';
import type { RepositoryContextCoordinator } from '../repository-context/repository-context-coordinator.js';
import type { RepoInsightsService } from '../repo-insights/repo-insights-service.js';
import { createRepoRoutes } from './repo-controller.js';
import { createAggregateRoutes } from './aggregate-controller.js';
import { createUsageDetailRoutes } from './usage-detail-controller.js';
import { createConfigRoutes } from './config-controller.js';
import { createFeatureRoutes } from './feature-controller.js';
import { createProviderRoutes } from './provider-controller.js';
import { createMcpRoutes } from './mcp-controller.js';
import { createSessionRoutes } from './session-controller.js';
import { createTerminalRoutes } from './terminal-controller.js';
import { createSummaryRoutes } from './summary-controller.js';
import { createWorkSummaryRoutes } from './work-summary-controller.js';
import { createSessionFilesRoutes } from './session-files-controller.js';
import { createSessionSummaryRoutes } from './session-summary-controller.js';
import { createSessionImportRoutes } from './session-import-controller.js';
import { createSkillsRoutes } from './skills-controller.js';
import { createFeatureTasksRoutes } from './feature-tasks-controller.js';
import { createFeatureTreeRoutes } from './feature-tree-controller.js';
import { createPrReviewRoutes } from './pr-review-controller.js';
import { createAutomationRoutes } from './automation-controller.js';
import type { AutomationService } from '../automation/automation-service.js';
import type { SubagentService } from '../automation/subagent-service.js';
import { createIdeUsageRoutes } from './ide-usage-controller.js';
import { createContextRoutes } from './context-controller.js';
import type { Route } from './http-contract.js';
import type { SessionBootstrap } from '../session-bootstrap/session-bootstrap.js';
import type { ContextService } from '../context-store/context-service.js';
import type { CopilotHistoryReader } from '../copilot-history/copilot-history-contract.js';

export interface ApiRoutesDeps {
  features: FeatureService;
  admin: WorkspaceAdmin;
  launcher: SessionLauncher;
  resolver: ProviderResolver;
  factory: SessionFactory;
  sessionConfig: SessionConfig;
  sessions: SessionRepo;
  sessionHistory: CopilotHistoryReader;
  /**
   * Resolves the working directory a feature's sessions must launch in (PR
   * worktree for PR features, else repo checkout). Threaded to the session
   * launcher so `/features/:id/sessions` pins the cwd like the terminal path.
   */
  resolveSessionCwd?: (featureId: string) => string | undefined;
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
  tree: FeatureTreeService;
  ideUsage: IdeUsageService;
  usageDetail: UsageDetailService;
  mcp: McpService;
  configRegistry: ConfigSchemaRegistry;
  currentConfig: ConfigObject;
  /**
   * Dotted config paths whose values were resolved from secret references and
   * must be redacted from `GET /config`.
   */
  configSecretPaths: readonly string[];
  /** Persisted, per-namespace config override editing. */
  configOverrides: ConfigOverrideService;
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
  repoInsights: RepoInsightsService;
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
  /** Live PR comment threads (list / add / resolve) for the review page. */
  prComments: PrCommentsService;
  /** Live PR approval for the review page. */
  prApprovals: PrApprovalService;
  /** Writes a review's problem statement + change graph into the PR description. */
  prDescriptions: PrDescriptionService;
  /** The layered shared-context store surfaced in the IDE. */
  context: Pick<ContextService, 'get' | 'setContent' | 'remember'>;
  /** Monitors & automations engine surfaced in the Automations menu. */
  automations: AutomationService;
  /** Tracked background AI subagents. */
  subagents: SubagentService;
  /** Per-launch token accepted by Studio MCP control routes. */
  controlToken?: string;
  logger: Logger;
}

/** Assembles the full route table from every controller. */
export function createApiRoutes(deps: ApiRoutesDeps): Route[] {
  return [
    ...createHealthRoutes(),
    ...createFeatureRoutes({ features: deps.features, admin: deps.admin }),
    ...createSessionRoutes({
      launcher: deps.launcher,
      sessions: deps.sessions,
      admin: deps.admin,
      history: deps.sessionHistory,
      logger: deps.logger,
      resolveCwd: deps.resolveSessionCwd,
    }),
    ...createTerminalRoutes({
      resolver: deps.resolver,
      factory: deps.factory,
      sessions: deps.sessions,
      config: deps.sessionConfig,
      bootstrap: deps.sessionBootstrap,
    }),
    ...createProviderRoutes({ registry: deps.providers }),
    ...createMcpRoutes({ mcp: deps.mcp }),
    ...createAggregateRoutes({ analytics: deps.aggregates }),
    ...createUsageDetailRoutes({ usageDetail: deps.usageDetail }),
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
    ...createFeatureTreeRoutes({ tree: deps.tree }),
    ...createPrReviewRoutes({
      prReviews: deps.prReviews,
      prComments: deps.prComments,
      prApprovals: deps.prApprovals,
      prDescriptions: deps.prDescriptions,
    }),
    ...createIdeUsageRoutes({ ideUsage: deps.ideUsage }),
    ...createContextRoutes({ context: deps.context }),
    ...createAutomationRoutes({
      automations: deps.automations,
      subagents: deps.subagents,
      controlToken: deps.controlToken,
    }),
    ...createConfigRoutes({
      registry: deps.configRegistry,
      current: deps.currentConfig,
      secretPaths: deps.configSecretPaths,
      overrides: deps.configOverrides,
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
      repoInsights: deps.repoInsights,
      provision: deps.provisionRepo,
      listGithubRepos: deps.listGithubRepos,
      listAzureRepos: deps.listAzureRepos,
      prFeatures: deps.prFeatures,
    }),
  ];
}
