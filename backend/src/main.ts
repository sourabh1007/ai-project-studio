import {
  mkdirSync,
  existsSync,
  copyFileSync,
  cpSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join as pathJoin, delimiter as pathDelimiter } from 'node:path';
import { access, readdir } from 'node:fs/promises';
import { createSessionLaunchCwdResolver } from './session-worktree/session-launch-cwd.js';
import {
  SESSION_WORKTREE_NAMESPACE, sessionWorktreeConfigSchema, sessionWorktreeDefaults,
  type SessionWorktreeConfig,
} from './session-worktree/config.js';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';

import { createClock } from './kernel/clock.js';
import { createIdGenerator } from './kernel/id-generator.js';
import { createProcessAdmission } from './kernel/process-admission.js';
import {
  PROCESS_ADMISSION_NAMESPACE, processAdmissionConfigSchema, processAdmissionDefaults,
  type ProcessAdmissionConfig,
} from './kernel/process-admission-config.js';
import { createLogger, type LogLevel } from './kernel/logger.js';
import { installProcessFaultGuard } from './kernel/process-fault-guard.js';
import {
  LOGGING_NAMESPACE,
  loggingConfigSchema,
  loggingDefaults,
  createDailyLogPathStrategy,
  type LoggingConfig,
} from './logging/config.js';
import {
  createFileLogSink,
  combineSinks,
} from './logging/log-file-sink.js';
import { createEventBus, type EventBus } from './kernel/event-bus.js';
import { ValidationError, NotFoundError } from './kernel/error-types.js';

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
import { parseAgencyVersion } from './agency-bootstrap/agency-version.js';
import { createAgencyDetector } from './agency-bootstrap/agency-detector.js';
import {
  agencyInstallPaths,
  resolveAgencyExecutable,
} from './agency-bootstrap/agency-install-paths.js';
import { createCopilotBootstrapper } from './copilot-bootstrap/copilot-bootstrapper.js';
import { createCopilotDetector } from './copilot-bootstrap/copilot-detector.js';
import {
  explicitNetworkOverride,
  envIndicatesMicrosoftNetwork,
  resolveMicrosoftNetwork,
} from './provider/network-environment.js';
import { selectDefaultProvider } from './provider/default-provider-selection.js';
import { isProviderExposed } from './provider/default-provider-selection.js';
import { createMicrosoftIdentity } from './provider/microsoft-identity.js';
import { probeMicrosoftInstallEndpoint } from './provider/microsoft-network-probe.js';
import { withTabsDisabled } from './copilot-settings/copilot-settings.js';
import {
  createGithubAuth,
  type GhRunner,
} from './github-auth/github-auth-service.js';
import { buildGithubCredentialEnv } from './github-auth/github-credential-env.js';
import { createGithubDeviceAuth } from './github-auth/github-device-auth.js';
import { resolveGhExecutable } from './github-auth/gh-executable.js';
import {
  createAzureDevOpsAuth,
  type GitRunResult,
} from './azure-auth/azure-devops-auth.js';
import {
  AZURE_DEVOPS_CREDENTIAL_ENV_KEYS,
  buildAzureDevOpsCredentialEnv,
} from './azure-auth/azure-devops-credential-env.js';
import { createCopilotProvider } from './provider/copilot-adapter/copilot-provider.js';
import { createAgencyProvider } from './provider/agency-adapter/agency-provider.js';
import { createCopilotMcpSupport } from './provider/copilot-adapter/copilot-mcp-support.js';
import { enabledMcpServerNames } from './mcp/mcp-server-names.js';
import type { McpConfigDocument } from './mcp/mcp-contract.js';
import { createProviderRegistry } from './provider/provider-registry.js';
import { createProviderResolver } from './provider/provider-resolver.js';

import { createSessionFactory } from './session/session-factory.js';
import { createSessionLauncher } from './session/session-launcher.js';
import { createSessionReconciler } from './session/session-reconciler.js';

import { createNodePtySpawner } from './terminal/node-pty-spawner.js';
import { createTerminalManager } from './terminal/terminal-manager.js';
import { createBootstrapInstructionsWriter } from './terminal/bootstrap-instructions-file-adapter.js';
import { createFeatureEnvironmentResolver } from './feature/feature-environment.js';
import { createGitBranchReader } from './feature/feature-branch-git-adapter.js';
import { attachTerminalWs } from './terminal/terminal-ws-server.js';
import { isTransientProviderFailure } from './pr-review/transient-failure.js';

import { createUsageRecorder } from './usage/usage-recorder.js';
import { createCliUsageTailer } from './usage/cli-usage-tailer.js';
import { createMcpLogCapture } from './mcp-usage/mcp-log-capture.js';
import { createCliMcpLogReader } from './provider/cli-store/cli-mcp-log-reader.js';
import { createMcpLogOwners } from './persistence/mcp-log-owners.js';
import { MCP_USAGE_NAMESPACE, mcpUsageConfigSchema, mcpUsageDefaults, type McpUsageConfig } from './mcp-usage/config.js';
import { createSessionModelResolver } from './usage/session-model-resolver.js';

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
import { createSharedCheckoutPreparer } from './session-worktree/shared-session-checkout.js';
import { createSessionRefResolver } from './session-worktree/session-ref-resolver.js';
import { favouriteAzureBranch } from './repo/azure-branch-favorites.js';
import { createPrFeatureService } from './repo/pr-feature-service.js';
import { createGithubCommentsGateway } from './repo/github-pr-comments.js';
import { createAzureCommentsGateway } from './repo/azure-pr-comments.js';
import { createPrCommentsService } from './pr-review/pr-comments-service.js';
import { createGithubApprovalGateway } from './repo/github-pr-approval.js';
import { createAzureApprovalGateway } from './repo/azure-pr-approval.js';
import { createPrApprovalService } from './pr-review/pr-approval-service.js';
import { createGithubDescriptionGateway } from './repo/github-pr-description.js';
import { createAzureDescriptionGateway } from './repo/azure-pr-description.js';
import { createPrDescriptionService } from './pr-review/pr-description-service.js';
import { createWorktreeService } from './worktrees/worktree-service.js';
import { createWorktreeActivityGuard } from './worktrees/worktree-activity.js';
import type { PrDescriptionGatewayResolver } from './pr-review/pr-description-contract.js';
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
import type { AzureTarget } from './azure-auth/azure-devops-auth.js';
import {
  AUTH_WARMER_NAMESPACE,
  authWarmerConfigSchema,
  authWarmerDefaults,
  type AuthWarmerConfig,
} from './auth-warmer/config.js';
import { createCredentialWarmer } from './auth-warmer/credential-warmer.js';
import {
  SELF_RECOVERY_NAMESPACE,
  selfRecoveryConfigSchema,
  selfRecoveryDefaults,
  type SelfRecoveryConfig,
} from './self-recovery/config.js';
import { isRecoverableSessionError } from './self-recovery/recoverable-error.js';
import { createSessionRepo } from './persistence/session-repo.js';
import { createUsageRepo } from './persistence/usage-repo.js';
import { createUsageCaptureRepo } from './persistence/usage-capture-repo.js';
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
import { createLivePromptFsReader } from './copilot-history/copilot-live-prompt-fs-adapter.js';
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
import {
  seedWorkspaceContext,
} from './context-store/workspace-context-seed.js';
import { createContextBroadcaster } from './context-store/context-broadcaster.js';
import { createContextMergeRunner } from './context-store/context-merge-runner.js';
import { createContextMergeAutoTrigger } from './context-store/context-merge-auto.js';
import { createContextRepo } from './persistence/context-repo.js';
import { createConfigOverrideRepo } from './persistence/config-override-repo.js';
import { createConfigOverrideService } from './config/config-override-service.js';
import { createSettingsAssistant } from './config/settings-assistant.js';
import { createSelfHealService } from './self-heal/self-heal-service.js';
import { buildGhInstallPlan } from './self-heal/gh-install.js';
import type { Healer } from './self-heal/self-heal-contract.js';
import { describeNamespaces } from './config/config-schema-describe.js';
import {
  HEALTH_NAMESPACE,
  healthConfigSchema,
  healthDefaults,
  type HealthConfig,
} from './health/config.js';
import { createHealthReportService } from './health/health-report-service.js';
import type { ProviderHealth } from './health/health-contract.js';
import { overridesToConfig } from './config/config-override-store.js';
import { createCliSessionStore } from './provider/cli-store/cli-session-store.js';
import {
  createCliUsageStore,
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
import { createRecordingMetaRunner } from './meta/recording-meta-runner.js';
import { ACTIVE_SESSIONS_NAMESPACE, activeSessionsConfigSchema, activeSessionsDefaults, type ActiveSessionsConfig } from './active-sessions/config.js';
import { createMetaDebugTracker, observeMetaOperations, observeMetaRunner } from './active-sessions/meta-debug-tracker.js';
import { createActiveSessionsService } from './active-sessions/active-sessions-service.js';
import { createActiveSessionsReader } from './persistence/active-sessions-reader-adapter.js';
import { createMetaUsageCapture } from './meta/meta-usage-capture.js';
import { createRecordingSessionLauncher } from './meta/recording-session-launcher.js';
import { createOwnedMetaRunner } from './meta/owned-meta-runner.js';
import { createMetaSettings } from './meta/meta-settings.js';
import {
  createConfiguredWarmRoutePolicy,
  resolveWarmProviderIdentity,
} from './meta/warm-route-policy.js';
import { createMetaUsageRepo } from './persistence/meta-usage-repo.js';
import { createMcpUsageRepo } from './persistence/mcp-usage-repo.js';
import { createMcpAuthObservationRepo } from './persistence/mcp-auth-observation-repo.js';
import { createMetaOperationRepo } from './persistence/meta-operation-repo.js';
import { createMetaOperationOwnership } from './meta/meta-operation-ownership.js';
import { createMetaOperationPhysicalOwnership } from './meta/meta-operation-physical-ownership.js';
import { createMetaOperationRecovery } from './meta/meta-operation-recovery.js';
import {
  META_OPERATIONS_NAMESPACE, metaOperationsConfigSchema, metaOperationsDefaults,
  type MetaOperationsConfig,
} from './meta/meta-operations-config.js';
import { MetaSessionPool } from './meta/acp/acp-pool.js';
import { PoolDemandTracker } from './meta/pool-demand.js';
import { AcpClient } from './meta/acp/acp-client.js';
import { AcpProcessAdapter } from './meta/acp/acp-process-adapter.js';
import { createAcpMetaRunner } from './meta/acp/acp-meta-runner.js';
import {
  createPooledMetaRunner,
  GENERAL_PURPOSE,
  metaPoolsStatus,
  type WarmPool,
} from './meta/pooled-meta-runner.js';
import {
  META_NAMESPACE,
  metaConfigSchema,
  metaDefaults,
  type MetaConfig,
} from './meta/config.js';
import { createMcpService } from './mcp/mcp-service.js';
import { createMcpCategoryService } from './mcp/mcp-category-service.js';
import { createMcpCategories } from './mcp/mcp-categories.js';
import { createAgencyMcpConfigStore, type AgencyMcpConfigRunner } from './mcp/agency-mcp-config-store.js';
import { createAgencyMcpCatalog, AGENCY_PUBLIC_MCPS } from './mcp/agency-mcp-catalog.js';
import { createAgencyMcpBuiltinSetup } from './mcp/agency-mcp-builtin-setup.js';
import { createAgencyMcpCommandRunner } from './mcp/agency-mcp-command-adapter.js';
import { createMcpAuthenticationJobs } from './mcp/mcp-authentication-jobs.js';
import { createAgencyMcpBuiltinRuntime } from './mcp/agency-mcp-builtin-runtime.js';
import { createAgencyMcpOptions } from './mcp/agency-mcp-options.js';
import { createStudioMcpHealth, reconcileStudioMcpRegistrations } from './mcp/studio-mcp-health.js';
import { createMcpConfigWrites } from './mcp/mcp-config-writes.js';
import { resolveExecutable } from './terminal/executable-resolver.js';
import { registerStudioMcpTools } from './automation/mcp/studio-mcp-tools.js';
import type { McpToolEntry } from './mcp/mcp-contract.js';
import { providerLaunchSpec, wrapServerSpec } from './mcp/mcp-proxy-config.js';
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
import { createPlannerService } from './planner/planner-service.js';
import { createPlannerRepo } from './persistence/planner-repo.js';
import {
  AUTOMATION_NAMESPACE,
  automationConfigSchema,
  automationDefaults,
  type AutomationConfig,
} from './automation/config.js';
import { createAutomationRepo } from './persistence/automation-repo.js';
import { createSubagentRepo } from './persistence/subagent-repo.js';
import { createAutomationService } from './automation/automation-service.js';
import type { AutomationEventMap } from './automation/automation-service.js';
import { createSubagentService } from './automation/subagent-service.js';
import { createSubagentReconciler } from './automation/subagent-reconciler.js';
import type { SubagentEventMap } from './automation/subagent-service.js';
import { createCheckRunner } from './automation/check-runner.js';
import { createActionRunner } from './automation/action-runner.js';
import { createAutomationScheduler } from './automation/automation-scheduler.js';
import { createShellExecutor } from './automation/shell-executor-adapter.js';
import { createHttpProbe } from './automation/http-probe-adapter.js';
import { createCiPipelineProbe } from './automation/ci-pipeline-probe-adapter.js';
import { createAutomationAiInvoker } from './automation/meta-ai-invoker.js';
import { createShutdownCoordinator } from './lifecycle/shutdown-coordinator.js';
import { acknowledgeDesktopShutdown, isDesktopShutdownRequest } from './lifecycle/shutdown-acknowledgement.js';
import { requireQuiescence } from './lifecycle/quiescence.js';
import { createMetaOperationShutdown } from './lifecycle/meta-operation-shutdown.js';
import { createApplicationWork } from './lifecycle/application-work.js';
import {
  LIFECYCLE_NAMESPACE,
  lifecycleConfigSchema,
  lifecycleDefaults,
  type LifecycleConfig,
} from './lifecycle/config.js';
import { createStoppedCaptureRecovery } from './lifecycle/stopped-capture-recovery.js';
import {
  FEATURE_TASKS_NAMESPACE,
  featureTasksConfigSchema,
  featureTasksDefaults,
  type FeatureTasksConfig,
} from './feature-tasks/config.js';
import {
  PLANNER_NAMESPACE,
  plannerConfigSchema,
  plannerDefaults,
  type PlannerConfig,
} from './planner/config.js';
import {
  PLANNER_SUMMARY_NAMESPACE,
  plannerSummaryConfigSchema,
  plannerSummaryDefaults,
  type PlannerSummaryConfig,
} from './planner-summary/config.js';
import { createPlannerSummaryRunner } from './planner-summary/planner-summary-runner.js';
import { createFeatureTreeService } from './feature-tree/feature-tree-service.js';
import { createFeatureGroupsRepo } from './persistence/feature-groups-repo.js';
import {
  FEATURE_TREE_NAMESPACE,
  featureTreeConfigSchema,
  featureTreeDefaults,
  type FeatureTreeConfig,
} from './feature-tree/config.js';
import { createIdeUsageService } from './ide-usage/ide-usage-service.js';
import { createPlanUsageService } from './plan-usage/plan-usage-service.js';
import { createPtyPlanUsageProbe } from './plan-usage/pty-plan-usage-probe.js';
import { buildPlanUsageProbeCommand } from './plan-usage/plan-usage-command.js';
import { createModelCatalogService } from './meta/model-catalog/model-catalog-service.js';
import { createAcpModelCatalogProbe } from './meta/model-catalog/acp-model-catalog-probe.js';
import { createAbortTracker } from './kernel/abort-tracker.js';
import { createIdeUsageRepo } from './persistence/ide-usage-repo.js';
import { createUsageRollupRepo } from './persistence/usage-rollup-repo.js';
import { createUsageRollupService } from './usage-rollup/usage-rollup-service.js';
import { createRetainedUsageRepo } from './persistence/retained-usage-repo.js';
import { createUsageAttributionRepo } from './persistence/usage-attribution-repo.js';
import {
  IDE_USAGE_NAMESPACE,
  ideUsageConfigSchema,
  ideUsageDefaults,
  type IdeUsageConfig,
} from './ide-usage/config.js';
import {
  PLAN_USAGE_NAMESPACE,
  planUsageConfigSchema,
  planUsageDefaults,
  type PlanUsageConfig,
} from './plan-usage/config.js';
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
import { createRepoInsightsRepo } from './persistence/repo-insights-repo.js';
import type { RepoInsightsStreamSink } from './repo-insights/repo-insights-contract.js';
import { createRepoInsightsGitAdapter } from './repo-insights/repo-insights-git-adapter.js';
import { createSessionBootstrap } from './session-bootstrap/session-bootstrap.js';
import {
  PR_REVIEW_NAMESPACE,
  prReviewConfigSchema,
  prReviewDefaults,
  type PrReviewConfig,
} from './pr-review/config.js';
import { createPrReviewService } from './pr-review/pr-review-service.js';
import {
  REVIEW_BOARD_NAMESPACE,
  reviewBoardConfigSchema,
  reviewBoardDefaults,
  type ReviewBoardConfig,
} from './review-board/config.js';
import { createReviewBoardService, requireReviewEvidence } from './review-board/review-board-service.js';
import { createReviewBoardQueue } from './review-board/review-board-queue.js';
import type {
  ReviewBoardEventMap,
  ReviewBoardStreamSink,
} from './review-board/review-board-contract.js';
import { createAgentRegistry } from './agents/agent-registry.js';
import { createAgentService } from './agents/agent-service.js';
import { createReviewBoardAgent, REVIEW_BOARD_AGENT_ID } from './agents/review-board-agent.js';
import { createNewTaskAgent } from './agents/new-task-agent.js';
import {
  NEW_TASK_NAMESPACE,
  newTaskConfigSchema,
  newTaskDefaults,
  type NewTaskConfig,
} from './new-task/config.js';
import { createNewTaskService } from './new-task/new-task-service.js';
import { createNewTaskRunHub } from './new-task/new-task-run-hub.js';
import type { NewTaskStreamEvent } from './new-task/new-task-run-hub.js';
import { createNewTaskGit } from './new-task/new-task-git.js';
import { createNewTaskPr } from './new-task/new-task-pr.js';
import { createNewTaskTeam } from './new-task/new-task-team.js';
import { createNewTaskRunRepo } from './persistence/new-task-run-repo.js';
import type { NewTaskEventMap } from './new-task/new-task-contract.js';
import { createBugBashAgent } from './agents/bug-bash-agent.js';
import {
  BUG_BASH_NAMESPACE,
  bugBashConfigSchema,
  bugBashDefaults,
  type BugBashConfig,
} from './bug-bash/config.js';
import { createBugBashService } from './bug-bash/bug-bash-service.js';
import { createBugBashRunHub } from './bug-bash/bug-bash-run-hub.js';
import type { BugBashStreamEvent } from './bug-bash/bug-bash-run-hub.js';
import { createBugBashTeam } from './bug-bash/bug-bash-team.js';
import { createBugBashGenerateTeam } from './bug-bash/bug-bash-generate-team.js';
import { createBugBashRunRepo } from './persistence/bug-bash-run-repo.js';
import type { BugBashEventMap } from './bug-bash/bug-bash-contract.js';
import { createAgentAttachmentRepo } from './persistence/agent-attachment-repo.js';
import { createAgentUsageReader } from './persistence/agent-usage-reader.js';
import { createBackgroundWorkRunner } from './kernel/background-work-runner.js';
import {
  RESOURCE_PRESSURE_NAMESPACE,
  resourcePressureConfigSchema,
  resourcePressureDefaults,
  type ResourcePressureConfig,
} from './resource-pressure/config.js';
import { createSystemResourceSampler } from './resource-pressure/system-resource-sampler.js';
import { RESOURCES_NAMESPACE, resourcesConfigSchema, resourcesDefaults, type ResourcesConfig } from './resources/config.js';
import { createResourcesService } from './resources/resources-service.js';
import { createProcessSampler, resourceFileSystem, startResourceSampling } from './resources/resources-node-adapter.js';
import type { StorageRoot } from './resources/resources-contract.js';
import { defaultWorkspaceDataDir } from './workspace/workspace-paths.js';
import { BACKGROUND_WORK_NAMESPACE, backgroundWorkConfigSchema, backgroundWorkDefaults, type BackgroundWorkConfig } from './kernel/background-work-config.js';
import { spawnChangeGraphWorker, type ChangeGraphWorkInput } from './pr-review/change-graph-worker-adapter.js';
import type { BuiltChangeGraph } from './pr-review/change-graph-builder.js';
import { nodeChangeGraphFs } from './pr-review/change-graph-fs.js';
import { createPrReviewReconciler } from './pr-review/pr-review-reconciler.js';
import { createMetaUsageReader } from './pr-review/meta-usage-reader.js';
import { createPrDiffCollector } from './pr-review/pr-diff-collector.js';
import type { PrReviewEventMap } from './pr-review/pr-review-contract.js';
import { createPrReviewRepo } from './persistence/pr-review-repo.js';

import { createApiRoutes } from './api/routes.js';
import { toErrorResult } from './api/http-error-mapper.js';
import { ownApplicationRoutes } from './api/route-ownership.js';
import { mountRoutes } from './api/express-adapter.js';
import { subscribeStream, type StreamEventMap } from './api/usage-stream.js';
import { createBoundedSse } from './api/bounded-sse.js';
import { SSE_NAMESPACE, sseConfigSchema, sseDefaults, type SseConfig } from './api/sse-config.js';
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
  registry.register({ namespace: SESSION_WORKTREE_NAMESPACE, schema: sessionWorktreeConfigSchema, defaults: sessionWorktreeDefaults });
  registry.register({ namespace: USAGE_NAMESPACE, schema: usageConfigSchema, defaults: usageDefaults });
  registry.register({ namespace: MCP_USAGE_NAMESPACE, schema: mcpUsageConfigSchema, defaults: mcpUsageDefaults });
  registry.register({ namespace: CREDIT_NAMESPACE, schema: creditConfigSchema, defaults: creditDefaults });
  registry.register({ namespace: AGGREGATION_NAMESPACE, schema: aggregationConfigSchema, defaults: aggregationDefaults });
  registry.register({ namespace: PERSISTENCE_NAMESPACE, schema: persistenceConfigSchema, defaults: persistenceDefaults });
  registry.register({ namespace: LOGGING_NAMESPACE, schema: loggingConfigSchema, defaults: loggingDefaults });
  registry.register({ namespace: SUMMARIZER_NAMESPACE, schema: summarizerConfigSchema, defaults: summarizerDefaults });
  registry.register({ namespace: API_NAMESPACE, schema: apiConfigSchema, defaults: apiDefaults });
  registry.register({ namespace: SSE_NAMESPACE, schema: sseConfigSchema, defaults: sseDefaults });
  registry.register({ namespace: BACKGROUND_WORK_NAMESPACE, schema: backgroundWorkConfigSchema, defaults: backgroundWorkDefaults });
  registry.register({ namespace: RESOURCES_NAMESPACE, schema: resourcesConfigSchema, defaults: resourcesDefaults });
  registry.register({ namespace: ACTIVE_SESSIONS_NAMESPACE, schema: activeSessionsConfigSchema, defaults: activeSessionsDefaults });
  registry.register({
    namespace: RESOURCE_PRESSURE_NAMESPACE,
    schema: resourcePressureConfigSchema,
    defaults: resourcePressureDefaults,
  });
  registry.register({
    namespace: PROCESS_ADMISSION_NAMESPACE,
    schema: processAdmissionConfigSchema,
    defaults: processAdmissionDefaults,
  });
  registry.register({ namespace: TERMINAL_NAMESPACE, schema: terminalConfigSchema, defaults: terminalDefaults });
  registry.register({ namespace: COPILOT_HISTORY_NAMESPACE, schema: copilotHistoryConfigSchema, defaults: copilotHistoryDefaults });
  registry.register({ namespace: SESSION_IMPORT_NAMESPACE, schema: sessionImportConfigSchema, defaults: sessionImportDefaults });
  registry.register({ namespace: SKILLS_NAMESPACE, schema: skillsConfigSchema, defaults: skillsDefaults });
  registry.register({ namespace: HEALTH_NAMESPACE, schema: healthConfigSchema, defaults: healthDefaults });
  registry.register({ namespace: META_NAMESPACE, schema: metaConfigSchema, defaults: metaDefaults });
  registry.register({ namespace: MCP_NAMESPACE, schema: mcpConfigSchema, defaults: mcpDefaults });
  registry.register({ namespace: FEATURE_TASKS_NAMESPACE, schema: featureTasksConfigSchema, defaults: featureTasksDefaults });
  registry.register({ namespace: PLANNER_NAMESPACE, schema: plannerConfigSchema, defaults: plannerDefaults });
  registry.register({ namespace: PLANNER_SUMMARY_NAMESPACE, schema: plannerSummaryConfigSchema, defaults: plannerSummaryDefaults });
  registry.register({ namespace: FEATURE_TREE_NAMESPACE, schema: featureTreeConfigSchema, defaults: featureTreeDefaults });
  registry.register({ namespace: IDE_USAGE_NAMESPACE, schema: ideUsageConfigSchema, defaults: ideUsageDefaults });
  registry.register({ namespace: PLAN_USAGE_NAMESPACE, schema: planUsageConfigSchema, defaults: planUsageDefaults });
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
  registry.register({
    namespace: REVIEW_BOARD_NAMESPACE,
    schema: reviewBoardConfigSchema,
    defaults: reviewBoardDefaults,
  });
  registry.register({
    namespace: NEW_TASK_NAMESPACE,
    schema: newTaskConfigSchema,
    defaults: newTaskDefaults,
  });
  registry.register({
    namespace: BUG_BASH_NAMESPACE,
    schema: bugBashConfigSchema,
    defaults: bugBashDefaults,
  });
  registry.register({
    namespace: AUTOMATION_NAMESPACE,
    schema: automationConfigSchema,
    defaults: automationDefaults,
  });
  registry.register({
    namespace: AUTH_WARMER_NAMESPACE,
    schema: authWarmerConfigSchema,
    defaults: authWarmerDefaults,
  });
  registry.register({
    namespace: SELF_RECOVERY_NAMESPACE,
    schema: selfRecoveryConfigSchema,
    defaults: selfRecoveryDefaults,
  });
  registry.register({
    namespace: LIFECYCLE_NAMESPACE,
    schema: lifecycleConfigSchema,
    defaults: lifecycleDefaults,
  });
  registry.register({
    namespace: META_OPERATIONS_NAMESPACE,
    schema: metaOperationsConfigSchema,
    defaults: metaOperationsDefaults,
  });

  // Phase 1 (bootstrap): resolve just enough config from defaults + environment
  // to locate on-disk storage and configure console logging. Persisted overrides live
  // inside the workspace database, which we cannot open until we know its path,
  // so file logging waits until the effective retention policy is available.
  const bootConfig: ConfigObject = buildConfig({
    registry,
    sources: [envSource(process.env, ENV_PREFIX)],
    secretLookup: (name) => process.env[name],
  });
  const persistenceConfig = bootConfig[PERSISTENCE_NAMESPACE] as PersistenceConfig;
  const loggingConfig = bootConfig[LOGGING_NAMESPACE] as LoggingConfig;

  const logLevel =
    (process.env.CW_LOG_LEVEL as LogLevel | undefined) ?? loggingConfig.level;
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
  let logger = createLogger(logLevel, consoleSink);
  // Installed before any service starts: an unhandled rejection during startup
  // would otherwise terminate the backend silently, and the desktop does not
  // respawn it, so the whole IDE would come up dead.
  installProcessFaultGuard({
    process,
    logger: { error: (message, data) => logger.error(message, data) },
  });
  const clock = createClock();
  const STUDIO_MCP_SERVER_NAME = 'ai-project-studio';
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
  const effectiveLogging = config[LOGGING_NAMESPACE] as LoggingConfig;
  const logPaths = createDailyLogPathStrategy(
    effectiveLogging.directory,
    effectiveLogging.filePrefix,
  );
  logger = createLogger(
    (process.env.CW_LOG_LEVEL as LogLevel | undefined) ?? effectiveLogging.level,
    effectiveLogging.toFile
      ? combineSinks(consoleSink, createFileLogSink({
        filePath: logPaths.resolve(new Date(), 0),
        pathStrategy: logPaths,
        maxFileBytes: effectiveLogging.maxFileBytes,
        retainedFileCount: effectiveLogging.retainedFileCount,
        maxRecordBytes: effectiveLogging.maxRecordBytes,
      }))
      : consoleSink,
  );
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
  const resourceMonitor = createSystemResourceSampler(
    config[RESOURCE_PRESSURE_NAMESPACE] as ResourcePressureConfig,
  );
  const processAdmission = createProcessAdmission(config[PROCESS_ADMISSION_NAMESPACE] as ProcessAdmissionConfig);
  const sse = createBoundedSse({ config: config[SSE_NAMESPACE] as SseConfig, logger });
  const terminalConfig = config[TERMINAL_NAMESPACE] as TerminalConfig;
  const copilotHistoryConfig = config[COPILOT_HISTORY_NAMESPACE] as CopilotHistoryConfig;
  const sessionImportConfig = config[SESSION_IMPORT_NAMESPACE] as SessionImportConfig;
  const skillsConfig = config[SKILLS_NAMESPACE] as SkillsConfig;
  const metaConfig = config[META_NAMESPACE] as MetaConfig;
  const mcpConfig = config[MCP_NAMESPACE] as McpConfig;
  const featureTasksConfig = config[FEATURE_TASKS_NAMESPACE] as FeatureTasksConfig;
  const plannerConfig = config[PLANNER_NAMESPACE] as PlannerConfig;
  const plannerSummaryConfig = config[
    PLANNER_SUMMARY_NAMESPACE
  ] as PlannerSummaryConfig;
  const featureTreeConfig = config[FEATURE_TREE_NAMESPACE] as FeatureTreeConfig;
  const ideUsageConfig = config[IDE_USAGE_NAMESPACE] as IdeUsageConfig;
  const repositoryContextConfig = config[
    REPOSITORY_CONTEXT_NAMESPACE
  ] as RepositoryContextConfig;
  const repoInsightsConfig = config[REPO_INSIGHTS_NAMESPACE] as RepoInsightsConfig;
  const prReviewConfig = config[PR_REVIEW_NAMESPACE] as PrReviewConfig;
  const reviewBoardConfig = config[REVIEW_BOARD_NAMESPACE] as ReviewBoardConfig;
  const newTaskConfig = config[NEW_TASK_NAMESPACE] as NewTaskConfig;
  const bugBashConfig = config[BUG_BASH_NAMESPACE] as BugBashConfig;
  const automationConfig = config[AUTOMATION_NAMESPACE] as AutomationConfig;
  const authWarmerConfig = config[AUTH_WARMER_NAMESPACE] as AuthWarmerConfig;
  const selfRecoveryConfig = config[
    SELF_RECOVERY_NAMESPACE
  ] as SelfRecoveryConfig;
  const lifecycleConfig = config[LIFECYCLE_NAMESPACE] as LifecycleConfig;
  const metaOperationsConfig = config[META_OPERATIONS_NAMESPACE] as MetaOperationsConfig;
  const applicationWork = createApplicationWork();

  const featureRepo = createFeatureRepo(db);
  const repoRepo = createRepoRepo(db);
  const repoService = createRepoService({ repo: repoRepo, ids, clock });
  const repositoryContextRepo = createRepositoryContextRepo(db);
  const sessionRepo = createSessionRepo(db);
  const sessionReconciler = createSessionReconciler({
    sessions: sessionRepo,
    clock,
  });
  const reconciledCount = sessionReconciler.reconcileOrphans();
  if (reconciledCount > 0) {
    logger.info('Reconciled orphaned sessions from previous run', {
      count: reconciledCount,
    });
  }
  const hiddenMetaCount = sessionReconciler.hideBackgroundMetaSessions();
  if (hiddenMetaCount > 0) {
    logger.info('Hid legacy feature-scoped background meta sessions', {
      count: hiddenMetaCount,
    });
  }
  const usageRepo = createUsageRepo(db);
  const usageCaptureRepo = createUsageCaptureRepo(db);
  const metaUsageRepo = createMetaUsageRepo(db);
  const mcpUsageRepo = createMcpUsageRepo(db);
  const mcpAuthObservationRepo = createMcpAuthObservationRepo(db);
  const activeSessionsConfig = config[ACTIVE_SESSIONS_NAMESPACE] as ActiveSessionsConfig;
  const metaDebugTracker = createMetaDebugTracker(activeSessionsConfig);
  const persistedMetaOperations = createMetaOperationRepo(db);
  const metaOperationRepo = {
    ...persistedMetaOperations,
    ...observeMetaOperations(persistedMetaOperations, metaDebugTracker),
  };
  const metaPhysicalOwnership = createMetaOperationPhysicalOwnership({ newOwnerId: () => ids.next() });
  const metaOperationOwnership = createMetaOperationOwnership({ physical: metaPhysicalOwnership });
  const metaOperationRecovery = createMetaOperationRecovery({ operations: metaOperationRepo, clock });
  let recoveryCursor: string | null = null;
  do {
    const page = metaOperationRecovery.recoverPage(recoveryCursor, metaOperationsConfig.recoveryPageSize);
    recoveryCursor = page.nextCursor;
  } while (recoveryCursor !== null);
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
  // Consolidated day/week/month/year rollups across every usage source (live
  // CLI turns, warm-ACP meta snapshots, and retained deletions) for the
  // workspace, the IDE's own metasession overhead, and each feature.
  const usageRollupService = createUsageRollupService({
    reader: createUsageRollupRepo(db, ideUsageConfig),
  });
  // Durable retention ledger + move-time attribution keep usage correct across
  // deletions (summarize, never shrink) and drag-and-drop moves (follow the
  // session onto its new feature).
  const retainedUsageRepo = createRetainedUsageRepo(db);
  const usageAttributionRepo = createUsageAttributionRepo(db);

  // The plan AI-credit budget (used / total / available) is scraped from the
  // provider's `/usage` TUI panel — the only surface exposing quota. Wired
  // below, after `metaSettings`, so the probe can follow the active provider.
  const planUsageEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      planUsageEnv[key] = value;
    }
  }

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
  // Reads the installed agency version by spawning `agency --version` off the
  // event loop (never execFileSync — AGENTS rule #8). Resolves null when agency
  // isn't resolvable or prints nothing parseable, so a failed probe simply
  // suppresses the "was updated" popup rather than blocking the upgrade.
  const readAgencyVersion = async (): Promise<string | null> => {
    const exe = resolveAgencyExecutable(currentAgencyPaths(), existsSync);
    if (!exe) {
      return null;
    }
    const handle = spawner.spawn({
      command: exe,
      args: ['--version'],
      env: process.env as Record<string, string>,
    });
    const lines: string[] = [];
    handle.onStdoutLine((line) => lines.push(line));
    handle.onStderrLine((line) => lines.push(line));
    const code = await handle.done;
    if (code !== 0) {
      return null;
    }
    return parseAgencyVersion(lines.join('\n'));
  };
  const agencyBootstrapper = createAgencyBootstrapper({
    platform: process.platform,
    detect: createAgencyDetector({
      paths: currentAgencyPaths,
      pathExists: existsSync,
    }),
    spawner,
    env: process.env as Record<string, string>,
    readVersion: readAgencyVersion,
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

  // Keep the agency CLI current automatically so it never nags for an upgrade
  // inside a working session. When agency is already installed we re-run the
  // InstallTool bootstrap in the background (it fast-paths when already latest);
  // the fresh version lands in a new versioned folder without disrupting running
  // sessions, and we refresh PATH so subsequently-spawned terminals pick it up.
  // A not-installed agency is handled by the first-run install gate instead.
  if (agencyBootstrapper.status().installed) {
    void agencyBootstrapper
      .upgradeToLatest((event) => {
        if (event.kind === 'line') {
          logger.debug('agency upgrade', { line: event.line });
        } else if (event.kind === 'error') {
          logger.warn('agency upgrade failed', { message: event.message });
        }
      })
      .then((status) => {
        if (status.installed) {
          refreshAgencyPath();
        }
      })
      .catch((error) => {
        logger.error('agency auto-upgrade crashed', error);
      });
  }

  // GitHub Copilot CLI bootstrapper — mirrors the agency path so the IDE can
  // auto-install and keep the `copilot` CLI current. Detection resolves the
  // configured executable against the live PATH (the npm-global `copilot` lands
  // next to the provisioned Node, which the desktop shell already adds to PATH).
  const resolveCopilotPath = (command: string): string | null => {
    const resolved = resolveExecutable(command);
    return existsSync(resolved) ? resolved : null;
  };
  const copilotDetector = createCopilotDetector({
    executable: copilotConfig.executable,
    resolve: resolveCopilotPath,
  });
  const readCopilotVersion = async (): Promise<string | null> => {
    const exe = resolveCopilotPath(copilotConfig.executable);
    if (!exe) {
      return null;
    }
    const handle = spawner.spawn({
      command: exe,
      args: ['--version'],
      env: process.env as Record<string, string>,
    });
    const lines: string[] = [];
    handle.onStdoutLine((line) => lines.push(line));
    handle.onStderrLine((line) => lines.push(line));
    const code = await handle.done;
    if (code !== 0) {
      return null;
    }
    return parseAgencyVersion(lines.join('\n'));
  };
  const copilotBootstrapper = createCopilotBootstrapper({
    platform: process.platform,
    detect: copilotDetector,
    spawner,
    env: process.env as Record<string, string>,
    readVersion: readCopilotVersion,
  });
  // Prepend the installed copilot executable's directory to PATH so node-pty can
  // resolve a bare `copilot` without an app restart after a first-run install.
  const refreshCopilotPath = (): void => {
    const exe = resolveCopilotPath(copilotConfig.executable);
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
  refreshCopilotPath();
  // Keep copilot current in the background when it is already installed, mirroring
  // the agency auto-upgrade. A not-installed copilot is handled by the first-run
  // install gate (which installs whichever provider is the network default).
  if (copilotConfig.enabled && copilotBootstrapper.status().installed) {
    void copilotBootstrapper
      .upgradeToLatest((event) => {
        if (event.kind === 'line') {
          logger.debug('copilot upgrade', { line: event.line });
        } else if (event.kind === 'error') {
          logger.warn('copilot upgrade failed', { message: event.message });
        }
      })
      .then((status) => {
        if (status.installed) {
          refreshCopilotPath();
        }
      })
      .catch((error) => {
        logger.error('copilot auto-upgrade crashed', error);
      });
  }

  // Decide the default AI provider by environment. Microsoft corpnet defaults to
  // Agency; everywhere else defaults to the GitHub Copilot CLI. Strong signals
  // (explicit override, corp-domain env vars) resolve synchronously; a weak,
  // best-effort endpoint-reachability probe refines the decision shortly after
  // startup without blocking it. Both providers stay registered so the user can
  // switch (or run across) CLIs at any time.
  const networkOverride = explicitNetworkOverride(process.env);
  const envMicrosoft = envIndicatesMicrosoftNetwork(process.env);
  const installedProviderIds = (): Set<string> => {
    const ids = new Set<string>();
    if (copilotConfig.enabled && copilotBootstrapper.status().installed) {
      ids.add('copilot');
    }
    if (agencyConfig.enabled && agencyBootstrapper.status().installed) {
      ids.add('agency');
    }
    return ids;
  };
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
  const GH_NOT_FOUND_MESSAGE =
    'GitHub CLI (gh) was not found. Install it from https://cli.github.com and make sure it is on your PATH, then try again.';
  // Resolve `gh` to a concrete path once, searching PATH plus well-known install
  // dirs. A GUI-launched desktop app often inherits a narrower PATH than a shell
  // (missing `C:\Program Files\GitHub CLI`), so a bare `execFile('gh')` would
  // ENOENT even though `gh` works in a terminal. Resolving up-front makes every
  // gh invocation below (status, token, sign-in) find the binary regardless.
  const ghCommand = resolveGhExecutable();
  // The GitHub token we propagate to sessions is injected into THIS process's
  // env (below). But `gh` itself reads `GH_TOKEN`/`GITHUB_TOKEN` from its env
  // and, when present, treats that as the active credential — which makes
  // `gh auth logout` a no-op and keeps `gh auth status` reporting signed-in even
  // after the keyring credential is gone. So every `gh` invocation runs with the
  // token vars stripped, so gh always reflects the real keyring state (sign-out
  // works, external logouts are detected) while sessions still inherit the token
  // from process.env.
  const ghEnvWithoutToken = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    return env;
  };
  const ghRun: GhRunner = (args) =>
    new Promise((resolve) => {
      // `gh auth status` / `logout` can stall on a locked keyring or a hidden
      // credential prompt; without a timeout that blocks the single-threaded
      // backend (and any awaiting /github/status request) indefinitely. Bound
      // it and treat "gh not found" as a clear, non-hanging failure.
      execFile(
        ghCommand,
        args,
        {
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          env: ghEnvWithoutToken(),
        },
        (err, stdout, stderr) => {
          const enoent =
            !!err && (err as { code?: unknown }).code === 'ENOENT';
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? ((err as { code: number }).code)
              : err
                ? 1
                : 0;
          resolve({
            code,
            stdout: stdout ?? '',
            stderr: enoent ? GH_NOT_FOUND_MESSAGE : stderr ?? '',
          });
        },
      );
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
        ghCommand,
        ['auth', 'token'],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15_000,
          env: ghEnvWithoutToken(),
        },
        (err, stdout) => {
          const token = !err ? (stdout ?? '').trim() : '';
          if (token) {
            for (const [key, value] of Object.entries(
              buildGithubCredentialEnv(token),
            )) {
              process.env[key] = value;
            }
            logger.info('GitHub auth propagated to sessions', {});
          } else {
            // No keyring token (signed out here or elsewhere): drop the stale
            // propagated credential so new sessions don't inherit a revoked
            // token and /github/status reflects the signed-out state.
            for (const key of Object.keys(buildGithubCredentialEnv('token'))) {
              delete process.env[key];
            }
          }
          resolve();
        },
      );
    });
  void refreshGithubCredentialEnv();
  // A unified background credential warm loop (created after azureAuth below)
  // re-reads the GitHub token and silently refreshes the Azure OAuth tokens on a
  // single interval, so a long-running IDE never spawns sessions with an expired
  // credential and never needs an interactive re-authentication mid-session.

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
          ghCommand,
          ['auth', 'login', '--with-token'],
          { windowsHide: true, timeout: 20_000, env: ghEnvWithoutToken() },
          (err, _stdout, stderr) => {
            const enoent =
              !!err && (err as { code?: unknown }).code === 'ENOENT';
            const code =
              err && typeof (err as { code?: unknown }).code === 'number'
                ? (err as { code: number }).code
                : err
                  ? 1
                  : 0;
            resolve({ code, stderr: enoent ? GH_NOT_FOUND_MESSAGE : stderr ?? '' });
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
    opts: { stdin?: string; interactive?: boolean; longRunning?: boolean; timeoutMs?: number; signal?: AbortSignal; onProgress?: (message: string) => void } = {},
  ): Promise<GitRunResult> =>
    new Promise((resolve) => {
      const child = execFile(
        'git',
        args,
        {
          windowsHide: true,
          signal: opts.signal,
          // Quick auth/status checks stay small; a worktree checkout of a large
          // monorepo streams megabytes of "Updating files: X%" progress to
          // stderr, which would blow a 1 MB cap (ENOBUFS kills the process), so
          // long-running git operations get a much larger buffer.
          maxBuffer: opts.longRunning ? 512 * 1024 * 1024 : 1024 * 1024,
          // A silent status check must never hang the sidebar "checking…" pill;
          // an interactive sign-in legitimately waits on the browser (through
          // an account picker + MFA), and a worktree checkout of a huge repo
          // legitimately runs for minutes — but none may hang *forever* if git
          // or GCM stalls on a network read, a wedged browser handshake, or a
          // credential wait, so each gets a generous finite ceiling rather than
          // no timeout at all. Without this, a stalled interactive sign-in kept
          // the /azure/signin request (and its "Signing in…" spinner) spinning
          // indefinitely with no way to recover.
          timeout: opts.timeoutMs ?? (opts.interactive ? 300_000 : opts.longRunning ? 900_000 : 20_000),
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
          const diagnostic = err && (err as { killed?: boolean }).killed && opts.timeoutMs
            ? `Git ${args.includes('fetch') ? 'fetch' : 'checkout'} exceeded ${opts.timeoutMs / 1000}s and was stopped. Check repository connectivity and retry.`
            : stderr ?? '';
          resolve({ code, stdout: stdout ?? '', stderr: diagnostic });
        },
      );
      if (opts.onProgress) {
        let lastProgress = 0;
        child.stderr?.on('data', (chunk: Buffer) => {
          const now = Date.now();
          if (now - lastProgress < 500) return;
          const message = chunk.toString().split(/[\r\n]+/).filter(Boolean).at(-1);
          if (message) {
            lastProgress = now;
            opts.onProgress!(message.slice(0, 500));
          }
        });
      }
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
  // Make every git subprocess that inherits THIS process's environment -- the
  // spawned CLI sessions, MCP servers and meta-sessions -- acquire Azure DevOps
  // credentials non-interactively. Those children have no TTY/parent window, so
  // if GCM ever went interactive it would pop a browser (or hang) in the middle
  // of a session or MCP tool call. With GCM_INTERACTIVE=never inherited, GCM
  // instead silently refreshes the OAuth access token from its cached refresh
  // token (a background token exchange, no UI) and only fails fast if that is
  // impossible -- so a session/MCP server never blocks on re-authentication.
  // We set it on process.env (not the user's global git config) so the user's
  // OWN terminal git keeps its normal interactive prompts. The IDE's explicit
  // sign-in overrides this per-call via GCM_INTERACTIVE=auto in gitRun's env.
  process.env.GCM_INTERACTIVE = 'never';
  // Track every Azure DevOps target the IDE actually talks to so the warm loop
  // can refresh exactly those OAuth tokens. The account-level target is always
  // present so warming keeps the shared Entra refresh token alive even before
  // any org-scoped call happens.
  const azureWarmTargets = new Map<string, AzureTarget>();
  const rememberAzureTarget = (target: AzureTarget): void => {
    azureWarmTargets.set(`${target.host}|${target.org ?? ''}`, target);
  };
  const applyAzureCredentialEnv = (token: string | null): void => {
    if (token) {
      for (const [key, value] of Object.entries(
        buildAzureDevOpsCredentialEnv(token),
      )) {
        process.env[key] = value;
      }
      logger.info('Azure DevOps auth propagated to sessions and MCP servers', {});
      return;
    }
    for (const key of AZURE_DEVOPS_CREDENTIAL_ENV_KEYS) {
      delete process.env[key];
    }
    process.env.GCM_INTERACTIVE = 'never';
    process.env.GIT_TERMINAL_PROMPT = '0';
    process.env.GCM_MSAUTH_USEBROKER = 'false';
    process.env.GCM_AZREPOS_CREDENTIALTYPE = 'oauth';
  };
  const azureTokenFor = async (input: string): Promise<string | null> => {
    const target = parseAzureTarget(input);
    rememberAzureTarget(target);
    const token = await azureAuth.token(target);
    if (token) {
      applyAzureCredentialEnv(token);
    }
    return token;
  };
  const refreshAzureDevOpsCredentialEnv = async (): Promise<void> => {
    for (const target of azureWarmTargets.values()) {
      const token = await azureAuth.token(target);
      if (token) {
        applyAzureCredentialEnv(token);
        return;
      }
    }
    applyAzureCredentialEnv(null);
  };
  rememberAzureTarget({ host: 'dev.azure.com', org: null });
  void refreshAzureDevOpsCredentialEnv();
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
      // A real clone of a sizable repo runs for minutes and streams megabytes
      // of "Receiving objects: X%" progress to stderr. Without longRunning it
      // gets the 20s / 1 MB ceilings, so a slow clone is killed mid-flight and
      // surfaces git's partial "Cloning into…" stderr as a failure while the
      // dialog's submit button re-enables before the checkout ever completes.
      longRunning: true,
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
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
  const azureHttpDelete = (url: string, token: string) =>
    azureHttpSend('DELETE', url, token, undefined);
  const listAzureReposFor = (org: string) =>
    listAzureRepos(
      {
        token: azureTokenFor,
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
    token: azureTokenFor,
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

  // Resolves the branch a newly opened session defaults to (a PR feature's PR
  // branch, otherwise master) and which existing checkout it shares
  // from. Repo-less legacy features resolve to null and keep the pre-worktree
  // cwd behaviour.
  const sessionRefResolver = createSessionRefResolver({
    isPrFeature: (featureId) => prReviewService.find(featureId) !== null,
    getPrBranch: (featureId) => prReviewService.find(featureId)?.pull.sourceBranch ?? null,
    getFeature: (featureId) => featureRepo.get(featureId),
    getRepo: (repoId) => repoService.list().find((r) => r.id === repoId) ?? null,
    branch: createGitBranchReader(),
  });

  const sessionWorktreeConfig = config[SESSION_WORKTREE_NAMESPACE] as SessionWorktreeConfig;
  const prepareSharedCheckout = createSharedCheckoutPreparer({
    git: (args, onProgress) => gitRun(args, {
      longRunning: args.includes('checkout'),
      timeoutMs: args.includes('checkout') ? sessionWorktreeConfig.checkoutTimeoutMs : sessionWorktreeConfig.gitTimeoutMs,
      onProgress,
    }),
    checkoutWorkers: sessionWorktreeConfig.checkoutWorkers,
  });
  const sessionPathExists = async (path: string): Promise<boolean> => {
    try { await access(path); return true; } catch { return false; }
  };
  const resolveSessionLaunchCwd = createSessionLaunchCwdResolver({
    own: (session, prepare) => applicationWork.own(prepare, { sessionId: session.id, featureId: session.featureId }),
    getSession: (id) => sessionRepo.get(id),
    pathExists: sessionPathExists,
    resolveTarget: (featureId) => sessionRefResolver.resolve(featureId),
    fallbackCwd: resolveSessionCwd,
    prepare: (session, target, report) => prepareSharedCheckout(target, report, session.startedAt === null),
  });
  // the cross-feature move consent dialog to show the branch a session switches
  // to. The IDE owns this so a session always follows its feature's checkout.
  const featureEnvironmentResolver = createFeatureEnvironmentResolver({
    resolveCwd: resolveSessionCwd,
    branch: createGitBranchReader(),
  });

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
  const mcpUsageConfig = config[MCP_USAGE_NAMESPACE] as McpUsageConfig;
  const mcpLogCapture = createMcpLogCapture({
    ...mcpUsageConfig,
    owners: createMcpLogOwners(db),
    reader: createCliMcpLogReader(pathJoin(homedir(), copilotHistoryConfig.subdir, 'session-state')),
    usage: mcpUsageRepo,
    logger: { warn: (message, data) => logger.warn(message, data) },
  });
  const mcpUsageTimer = setInterval(() => { void mcpLogCapture.tick(); }, mcpUsageConfig.pollIntervalMs);
  mcpUsageTimer.unref();
  const metaUsageCapture = createMetaUsageCapture({
    operations: metaOperationRepo,
    read: (sessionId, operation, cursor, limit) => cliUsageStore.readUsagePage(sessionId, {
      featureId: operation.featureId,
      provider: operation.providerId ?? '',
      requestedModel: operation.requestedModel ?? '',
    }, cursor, limit),
    now: () => clock.isoNow(),
    onChanged: (operation) => bus.emit('meta.usage.updated', {
      featureId: operation.featureId, operationId: operation.operationId,
    }),
    pageSize: usageConfig.capturePageSize,
    maxPages: usageConfig.finalDrainPages,
  });
  const metaUsageTimer = setInterval(() => {
    try { metaUsageCapture.tick(); }
    catch (error) { logger.error('Meta usage reconciliation failed', error); }
  }, usageConfig.livePollIntervalMs);
  metaUsageTimer.unref();
  // Headless meta sessions disable MCP so servers never trigger their own
  // interactive browser OAuth (which they can't complete anyway). We read the
  // shared copilot mcp-config.json live so config edits apply without restart.
  const mcpConfigPath = createCopilotMcpSupport().defaultConfigPath();
  const readMcpServerNames = (): readonly string[] => {
    try {
      const raw = readFileSync(mcpConfigPath, 'utf8');
      return enabledMcpServerNames(JSON.parse(raw) as McpConfigDocument);
    } catch {
      return [];
    }
  };
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
        createCopilotProvider(copilotConfig, {
          spawner,
          baseEnv: process.env,
          mcpServerNames: readMcpServerNames,
        }),
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
          mcpServerNames: readMcpServerNames,
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

  // Initial default from the synchronous (strong) signals; the async endpoint
  // probe below refines it in place if the environment is still ambiguous.
  // Agency is an internal Microsoft tool, so it is only ever exposed/selected
  // when the user is signed in with a Microsoft identity (Azure DevOps). The
  // identity store flips live on sign-in/sign-out, and the default is recomputed
  // in place so Agency appears/disappears everywhere with no restart.
  const microsoftIdentity = createMicrosoftIdentity(false);
  const enabledProviderIds = enabledProviders.map((provider) => provider.id);
  let lastEndpointReachable: boolean | null = null;
  const computeDefaultProvider = (endpointReachable: boolean | null): string =>
    selectDefaultProvider({
      microsoftNetwork: resolveMicrosoftNetwork({
        override: networkOverride,
        envMicrosoft,
        endpointReachable,
      }),
      enabled: enabledProviderIds,
      installed: installedProviderIds(),
      microsoftSignedIn: microsoftIdentity.isSignedIn(),
    });
  const resolverConfig = {
    defaultProvider: computeDefaultProvider(null),
    defaultModelByProvider,
  };
  const resolver = createProviderResolver(providers, resolverConfig);
  // Recompute the default live whenever the Microsoft identity flips so new
  // sessions and the first-run UI immediately reflect Agency becoming available
  // (sign-in) or hidden (sign-out).
  microsoftIdentity.onChange(() => {
    resolverConfig.defaultProvider = computeDefaultProvider(lastEndpointReachable);
    logger.info('provider exposure changed', {
      microsoftSignedIn: microsoftIdentity.isSignedIn(),
      defaultProvider: resolverConfig.defaultProvider,
    });
  });

  // When the environment is ambiguous (no override, env not Microsoft), run the
  // best-effort reachability probe and refine the default in place. The resolver
  // reads `defaultProvider` live, so later sessions pick up the refined default
  // without a restart. Skipped when a strong signal already decided it.
  if (networkOverride === null && !envMicrosoft) {
    void probeMicrosoftInstallEndpoint()
      .then((reachable) => {
        if (reachable) {
          lastEndpointReachable = true;
          resolverConfig.defaultProvider = computeDefaultProvider(true);
        }
      })
      .catch((error) => {
        logger.debug('microsoft network probe failed', { error });
      });
  }
  logger.info('default AI provider selected', {
    defaultProvider: resolverConfig.defaultProvider,
    envMicrosoft,
    override: networkOverride,
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
    physicalOwnership: metaPhysicalOwnership,
    processAdmission,
    resolver,
    factory,
    transcriptStore: transcriptRepo,
    bus: bus as unknown as Parameters<typeof createSessionLauncher>[0]['bus'],
    clock,
    config: sessionConfig,
    logger,
    bootstrap: {
      assertFeatureReady: (featureId) =>
        sessionBootstrap.assertFeatureReady(featureId),
      composeForSession: (session) =>
        sessionBootstrap.composeForSession(session),
    },
  });

  // Background `meta` launches that bypass the recording MetaRunner (feature and
  // session summaries, context merge) go through this decorator so every
  // metasession — and the provider credits it spends — is visible in the
  // operations history, exactly like the metaAi-routed operations. The raw
  // `launcher` stays wired to the MetaRunner below to avoid double-recording.
  const recordingLauncher = createRecordingSessionLauncher({
    base: launcher,
    operations: metaOperationRepo,
    clock,
    newOperationId: () => ids.next(),
  });

  // Reconciles a session's persisted resolved model with a freshly-observed
  // one (from a usage row or a CLI model-change announcement), persisting and
  // broadcasting only on a real change so the UI's per-session model label
  // stays in lockstep with the CLI.
  const sessionModelResolver = createSessionModelResolver({
    sessions: sessionRepo,
    usage: usageRepo,
    publish: (updated) => bus.emit('session.updated', updated),
  });

  let terminalManager: ReturnType<typeof createTerminalManager> | null = null;
  // Self-recovery metasession analyzer, assigned once the meta runner is built
  // below (it is created after the terminal manager). Rejecting when unset — or
  // when the meta runner itself cannot spin up — is the signal the coordinator
  // uses to report that automatic analysis was unavailable.
  let analyzeSessionError:
    | ((errorText: string) => Promise<string | null>)
    | undefined;
  // Interactive terminal: launches the real CLI chat TUI in a PTY per session,
  // reusing the same usage-capture pipeline via session.started/ended events.
  terminalManager = createTerminalManager({
    logger,
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
    // Delivers that composed context to the CLI as a silently-discovered
    // custom-instructions file (via COPILOT_CUSTOM_INSTRUCTIONS_DIRS) instead of
    // typing the whole block into the terminal, so the user never watches a wall
    // of injected prompt text scroll past. Files live under the OS temp dir and
    // are removed when the session ends.
    bootstrapInstructions: createBootstrapInstructionsWriter(),
    // Records the files each session creates/edits by parsing the tool's own
    // terminal output (per-session PTY = unambiguous attribution), replacing
    // brittle filesystem watching of a shared working directory.
    sessionFiles: sessionFilesRepo,
    // Mirror mid-session model switches the CLI prints (e.g. "Model changed …
    // to <model>") onto the session's resolved model, so the UI updates as soon
    // as the user changes model in the CLI, not just on the next usage row.
    onModelResolved: (sessionId, resolvedModel) =>
      sessionModelResolver.observeAuthoritative(sessionId, resolvedModel),
    home: homedir(),
    // Auto-heal interactive sessions. With self-recovery on, a broadened
    // classifier also treats corrupted-conversation errors (e.g. a 400 the CLI
    // rejects, a slow MCP handshake) as recoverable; otherwise only the shared
    // transient upstream blips (5xx / 429 / network) trigger a re-submit.
    isTransientFailure: selfRecoveryConfig.enabled
      ? isRecoverableSessionError
      : isTransientProviderFailure,
    // Escalation ladder once a confirmed replay-safe request has spent its
    // non-destructive re-submits: analyze via a metasession, then restart the
    // CLI in a fresh conversation replaying that same request, then report to
    // the status bar if even that could not recover it.
    selfRecovery: {
      enabled: selfRecoveryConfig.enabled,
      useMetaAnalysis: selfRecoveryConfig.useMetaAnalysis,
      analyze: (errorText) =>
        analyzeSessionError
          ? analyzeSessionError(errorText)
          : Promise.reject(new Error('self-recovery analysis unavailable')),
      report: (sessionId, message) =>
        bus.emit('session.notice', { sessionId, level: 'error', message }),
    },
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
      sessionId: session.id,
      sourceId: cliUsageStore.sourceId,
      read: (cursor, limit) =>
        cliUsageStore.readUsagePage(
          session.id,
          {
            featureId: session.featureId,
            provider: session.provider,
            requestedModel: session.requestedModel,
          },
          cursor,
          limit,
        ),
      recorder: {
        reconcile: (event, kind) => {
          const stored = usageRecorder.reconcile(event, kind);
          sessionModelResolver.observeUsage(stored ?? event);
          return stored;
        },
      },
      captures: usageCaptureRepo,
      kind: session.kind,
      pageSize: usageConfig.capturePageSize,
      finalDrainPages: usageConfig.finalDrainPages,
    });
  const stoppedCaptureRecovery = createStoppedCaptureRecovery({
    captures: usageCaptureRepo,
    sessions: sessionRepo,
    makeTailer: makeUsageTailer,
    hasLiveTailer: (sessionId) => tailers.has(sessionId),
    pageSize: lifecycleConfig.stoppedCaptureRecoveryPageSize,
    intervalMs: lifecycleConfig.stoppedCaptureRecoveryIntervalMs,
    logger,
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
    if (!sessionRepo.get(session.id)) {
      logger.warn('Ignoring completion for a removed session', { sessionId: session.id });
      releaseTailer(session.id);
      return;
    }
    sessionRepo.save(session);
    const tailer = tailers.get(session.id);
    if (!tailer) {
      stoppedCaptureRecovery.finalize();
      return;
    }
    try {
      tailer.finalize();
    } catch (error) {
      logger.error('Final usage flush failed', error);
    } finally {
      releaseTailer(session.id);
      stoppedCaptureRecovery.finalize();
    }
  });
  bus.on('session.discarded', (sessionId: string) => {
    // The session is being deleted: release its live usage tailer without a
    // final drain (its usage rows are being purged) and without re-persisting.
    releaseTailer(sessionId);
  });

  /** Stops and forgets a session's live usage tailer (no final drain). */
  function releaseTailer(sessionId: string): void {
    const tailer = tailers.get(sessionId);
    if (!tailer) {
      return;
    }
    tailers.delete(sessionId);
    tailer.stop();
  }

  stoppedCaptureRecovery.start();

  // Feature + summarizer.
  const featureGroupsRepo = createFeatureGroupsRepo(db);
  const featureService = createFeatureService({
    repo: featureRepo,
    ids,
    clock,
    repos: repoService,
    groups: featureGroupsRepo,
  });
  // Layered shared-context store: durable, curated instructions injected at
  // launch and live-pushed into running sessions. The broadcaster fans context
  // writes out to affected running terminals; the merge runner curates a
  // feature's document from each completed dev session.
  const contextBroadcaster = createContextBroadcaster({
    features: featureService,
    sessions: sessionRepo,
    inject: (sessionId, instructions) =>
      terminalManager!.injectInstructions(
        sessionId,
        instructions,
        'Workspace context',
      ),
    config: contextConfig,
  });
  const contextService = createContextService({
    store: contextRepo,
    clock,
    config: contextConfig,
    onUpdated: (doc) => contextBroadcaster.onUpdated(doc),
  });
  // Seed the editable workspace context with the standing response prompt
  // whenever the workspace document is absent or blank, so fresh (or cleared)
  // workspaces are always populated by default. The default text is config —
  // `context.defaultWorkspaceContext` — not hardcoded, and never overwrites a
  // document the user has filled in.
  seedWorkspaceContext({
    contexts: contextService,
    content: contextConfig.defaultWorkspaceContext,
  });
  const contextMerger = createContextMergeRunner({
    sessions: sessionRepo,
    features: featureService,
    transcripts: transcriptRepo,
    launcher: recordingLauncher,
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
    const scope = { featureId: session.featureId, sessionId: session.id };
    if (applicationWork.accepts(scope) && sessionRepo.get(session.id)) {
      void applicationWork.own((signal) => contextMergeAuto.onSessionEnded(session, signal), scope)
        .catch((error) => logger.error('Auto context merge admission failed', error));
    }
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
    livePrompts: createLivePromptFsReader({
      sessionStateDir: pathJoin(
        homedir(),
        copilotHistoryConfig.subdir,
        copilotHistoryConfig.sessionStateDir,
      ),
      eventsFile: copilotHistoryConfig.eventsFile,
      tailBytes: copilotHistoryConfig.livePromptTailBytes,
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
    launcher: recordingLauncher,
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
    launcher: recordingLauncher,
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
    const scope = { featureId: session.featureId, sessionId: session.id };
    if (applicationWork.accepts(scope) && sessionRepo.get(session.id)) {
      void applicationWork.own((signal) => sessionSummaryAuto.onSessionEnded(session, signal), scope)
        .catch((error) => logger.error('Auto session summary admission failed', error));
    }
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

  // Runtime-mutable meta AI provider/model. Seeded from the persisted `meta`
  // config; the status bar reads and updates it so the model powering new
  // metasessions can change without an IDE restart. The cold `metaRunner` reads
  // it fresh on every run, so changes apply to all *new* metasessions at once.
  const metaSettings = createMetaSettings({
    providerId: metaConfig.providerId,
    model: metaConfig.model,
  });
  // Agency is only exposed to a Microsoft identity, so a persisted Agency
  // metasession default must degrade to the exposed default (Copilot) for a
  // signed-out user. The plan-usage probe, meta runner and the settings view
  // all read through this identity-aware view so no Agency metasession ever runs
  // — and none is ever displayed — without a Microsoft identity. Writes pass
  // through unchanged (persistence keeps the user's real choice).
  //
  // Until the user explicitly picks a provider, the metasession tracks the live
  // default provider instead of the static config seed, so Agency becomes the
  // default as soon as it is available (Microsoft identity + installed) and
  // falls back to Copilot otherwise — matching session launch defaults. An
  // explicit choice (persisted override) always wins, subject to the exposure
  // degrade above.
  const metaProviderExplicitlyChosen = () =>
    (configOverrideService.getOverride(META_NAMESPACE) as { providerId?: unknown }).providerId !== undefined;
  const exposedMetaSettings = {
    get: () => {
      const value = metaSettings.get();
      const providerId = metaProviderExplicitlyChosen()
        ? value.providerId
        : resolverConfig.defaultProvider;
      return isProviderExposed(providerId, microsoftIdentity.isSignedIn())
        ? { ...value, providerId }
        : { ...value, providerId: resolverConfig.defaultProvider };
    },
    set: (patch: Partial<ReturnType<typeof metaSettings.get>>) => metaSettings.set(patch),
    onChange: (listener: (value: ReturnType<typeof metaSettings.get>) => void) =>
      metaSettings.onChange(listener),
  };
  // Signed-in plan AI-credit budget. The probe boots a throwaway TUI for the
  // *active* provider (Agency wraps the same Copilot CLI, so its `/usage` panel
  // is the same underlying budget) and reuses one long-lived, admission-gated
  // session across refreshes so it stops losing the resource race with the warm
  // pool — the failure that flashed "plan usage unavailable".
  const planUsageConfig = config[PLAN_USAGE_NAMESPACE] as PlanUsageConfig;
  const planUsageService = createPlanUsageService({
    probe: createPtyPlanUsageProbe({
      spawner: createNodePtySpawner(),
      resolveCommand: () => {
        const active = exposedMetaSettings.get();
        return buildPlanUsageProbeCommand({
          providerId: active.providerId,
          model: active.model || copilotConfig.defaultModel,
          sessionId: randomUUID(),
          copilot: { executable: copilotConfig.executable },
          agency: {
            executable: agencyConfig.executable,
            subcommand: agencyConfig.subcommand,
          },
        });
      },
      env: planUsageEnv,
      admission: processAdmission,
    }),
    now: () => new Date(),
    ttlMs: planUsageConfig.refreshMinutes * 60 * 1000,
    failureThreshold: planUsageConfig.failureThreshold,
  });

  const shutdownOwner = createAbortTracker();
  // Shared headless-AI primitive reused by every AI feature (summaries,
  // task plans, …) so they drive the CLI the same config-driven way.
  const coldMetaRunner = createMetaRunner({
    physicalOwnership: metaPhysicalOwnership,
    launcher,
    transcripts: transcriptRepo,
    config: metaConfig,
    settings: exposedMetaSettings,
  });
  // Warm ACP metasession pools. When enabled they keep several live
  // `copilot --acp` sessions ready — one pool per configured purpose — so every
  // meta AI turn (summaries, repo context, PR review, review board, monitors, …)
  // leases a warm session instead of cold-spawning a CLI (MCP proxies + auth)
  // per request. The cold `metaRunner` stays the automatic fallback while a pool
  // is warming or before a warm prompt is actually dispatched, so enabling the
  // pools only adds speed without duplicating uncertain in-flight work.
  const warmPoolCfg = metaConfig.warmPool;
  const warmExecutable =
    warmPoolCfg.executable === 'copilot'
      ? copilotConfig.executable
      : warmPoolCfg.executable;
  const warmProviderIdentity = resolveWarmProviderIdentity({
    warmExecutable,
    copilotExecutable: copilotConfig.executable,
    agencyExecutable: agencyConfig.executable,
  });
  // Selectable AI model catalog (ids, names + the CLI's own pricing hints)
  // offered for metasessions. The only surface advertising the full model list
  // with pricing is the CLI itself: a throwaway `copilot --acp` session returns
  // it in its `session/new` result, so it is fetched once over ACP and cached
  // (the fetch costs seconds; the catalog rarely changes).
  const modelCatalogService = createModelCatalogService({
    probe: createAcpModelCatalogProbe({
      executable: warmExecutable,
      // The CLI's `session/new` requires a working directory to open a session;
      // any valid directory yields the same account-wide model catalog.
      cwd: process.cwd(),
      // Fail fast: the catalog handshake is lightweight (builtin MCPs are
      // disabled), so a slow/unhealthy CLI should give up quickly rather than
      // hold the request open.
      initializeTimeoutMs: 60_000,
      turnTimeoutMs: 30_000,
    }),
    now: () => Date.now(),
    ttlMs: 10 * 60 * 1000,
  });
  const warmDemand = new PoolDemandTracker({
    now: () => Date.now(),
    windowMs: warmPoolCfg.demandWindowMs,
    maxSize: warmPoolCfg.maxSuggestedSize,
  });
  let metaPoolsStatusFn: () => ReturnType<typeof metaPoolsStatus> = () =>
    metaPoolsStatus(false);
  // The single live warm pool, so the Settings page can resize it without a
  // restart. Empty until warm pools are enabled/built below.
  const allWarmPools = new Set<MetaSessionPool>();
  let resizeMetaPoolFn: (size: number) => ReturnType<
    typeof metaPoolsStatus
  > = () => {
    throw new NotFoundError('Warm metasession pools are disabled');
  };
  let rawMetaAi: typeof coldMetaRunner = coldMetaRunner;
  let warmInlinePrompts = false;
  if (warmPoolCfg.enabled) {
    const supportsWarm = createConfiguredWarmRoutePolicy({
      settings: metaSettings,
      metaConfig,
      copilotConfig,
      agencyConfig,
    });
    const pool = new MetaSessionPool({
      physicalOwnership: metaPhysicalOwnership,
      processAdmission,
      size: warmPoolCfg.size,
      createClient: () =>
        new AcpClient(new AcpProcessAdapter({ executable: warmExecutable }), {
          initializeTimeoutMs: warmPoolCfg.initializeTimeoutMs,
          turnTimeoutMs: warmPoolCfg.turnTimeoutMs,
        }),
    });
    allWarmPools.add(pool);
    pool.start().catch((error: unknown) => {
      logger.error('Warm ACP pool failed to start; using cold path', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const warmRunner = createAcpMetaRunner({
      pool,
      newSessionId: () => `acp-${randomUUID()}`,
      purpose: GENERAL_PURPOSE,
      providerId: warmProviderIdentity ?? COPILOT_NAMESPACE,
      defaultModel: () => metaSettings.get().model,
    });
    const warmPool: WarmPool = {
      stats: () => pool.stats(),
      runDetailed: (request) => warmRunner.runDetailed(request),
    };
    rawMetaAi = createPooledMetaRunner({
      physicalOwnership: metaPhysicalOwnership,
      pool: warmPool,
      fallback: coldMetaRunner,
      defaultTimeoutMs: metaConfig.timeoutMs,
      demand: warmDemand,
      supportsWarm,
      onFallback: (error) =>
        logger.warn('Warm turn failed; using cold path', {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    warmInlinePrompts = true;
    metaPoolsStatusFn = () =>
      metaPoolsStatus(true, warmPool, warmDemand, metaSettings.get().model);
    resizeMetaPoolFn = (size) => {
      pool.resize(size);
      return metaPoolsStatusFn();
    };
  }
  const activeSessions = createActiveSessionsService({
    config: activeSessionsConfig,
    now: () => Date.now(),
    sessions: createActiveSessionsReader(db),
    pools: metaPoolsStatusFn,
    tracker: metaDebugTracker,
    context: (featureId) => {
      const feature = featureRepo.get(featureId);
      const repoId = feature?.repoId ?? (featureId.startsWith('repository:') ? featureId.slice(11) : null);
      const repo = repoId ? repoRepo.get(repoId) : null;
      return { featureName: feature?.name ?? null, projectName: repo?.name ?? null };
    },
  });
  const metaAi = createOwnedMetaRunner(
    createRecordingMetaRunner({
      base: observeMetaRunner(rawMetaAi, metaDebugTracker),
      operations: metaOperationRepo,
      ownership: metaOperationOwnership,
      newOperationId: () => ids.next(),
      resolveIdentity: (request) => {
        const defaults = exposedMetaSettings.get();
        return {
          providerId: request.providerId ?? defaults.providerId,
          requestedModel: request.model ?? defaults.model,
        };
      },
      clock,
    }),
    shutdownOwner,
  );
  // Wire the self-recovery analyzer now that the meta runner is final. Runs a
  // read-only diagnosis turn; a thrown error (meta cannot spin up) propagates to
  // the coordinator, which then reports that automatic analysis was unavailable.
  analyzeSessionError = async (errorText) => {
    const diagnosis = await metaAi.run({
      featureId: 'self-recovery',
      scope: 'internal',
      prompt:
        'An interactive AI coding CLI session just failed with the error ' +
        'output below. In 1-2 short sentences, state the most likely cause ' +
        'and whether restarting the session should clear it. Be concise; do ' +
        'not use tools.\n\n---\n' +
        errorText,
      cwd: terminalCwd,
      noTools: true,
      purpose: 'self-recovery',
      label: 'Self-recovery diagnosis',
    });
    const trimmed = diagnosis.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  // Provider-agnostic MCP server management. The provider's own CLI reports
  // where its MCP config lives (via a meta-session), so no path is hardcoded.
  const sessionMcpService = createMcpService({
    registry: providers,
    meta: metaAi,
    files: createMcpConfigFileStore(),
    tools: createMcpToolInspector(),
    config: mcpConfig,
    microsoftSignedIn: () => microsoftIdentity.isSignedIn(),
    healDiagnose: async (serverName, message, output) => {
      try {
        const detail = [message ?? '', ...output].join('\n').trim();
        const diagnosis = await metaAi.run({
          featureId: 'self-heal',
          scope: 'internal',
          prompt:
            `The MCP (Model Context Protocol) server "${serverName}" failed ` +
            'to start and its tools could not be discovered, even after an ' +
            'automatic retry. From the failure output below, in 1-2 short ' +
            'sentences state the most likely cause and the concrete fix (for ' +
            'example a missing command or script path, a package that failed ' +
            'to download, a crash on startup, or a permissions problem). Be ' +
            'concise; do not use tools.\n\n---\n' +
            (detail.length > 0 ? detail : 'No diagnostic output was captured.'),
          noTools: true,
          purpose: 'self-heal',
          label: 'Self-healing MCP diagnosis',
        });
        const trimmed = diagnosis.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    },
    healRemediate: async (serverName, message, output) => {
      try {
        const detail = [message ?? '', ...output].join('\n').trim();
        const report = await metaAi.run({
          featureId: 'self-heal',
          scope: 'internal',
          prompt:
            `The MCP (Model Context Protocol) server "${serverName}" failed ` +
            'to start, even after an automatic retry. The failure output below ' +
            'often states exactly how to fix it (for example "run /mcp show ' +
            `${serverName}", a missing command such as \`spawn npx ENOENT\`, a ` +
            'missing package, a missing path, or a permissions problem). Act as ' +
            'a self-healing agent: read the output, follow the remediation it ' +
            'prescribes, and apply the fix using your tools. Only take safe, ' +
            'idempotent actions (for example verifying a command resolves, ' +
            'creating a missing directory, or installing the named package); do ' +
            'not delete data, change unrelated configuration, or run long or ' +
            'destructive operations. When done, reply with one short sentence ' +
            'stating exactly what you changed, or — if nothing could be safely ' +
            'done — reply with the single word NONE.\n\n---\n' +
            (detail.length > 0 ? detail : 'No diagnostic output was captured.'),
          purpose: 'self-heal',
          label: 'Self-healing MCP remediation',
        });
        const trimmed = report.trim();
        if (trimmed.length === 0 || /^none\.?$/i.test(trimmed)) {
          return null;
        }
        return trimmed;
      } catch {
        return null;
      }
    },
    liveReload: (providerId, command) => {
      let applied = 0;
      for (const session of sessionRepo.listAll()) {
        if (
          session.provider === providerId &&
          session.status === 'running' &&
          terminalManager?.injectInstructions(
            session.id,
            command,
            'MCP configuration',
          )
        ) {
          applied += 1;
        }
      }
      return applied;
    },
  });
  const categoryFiles = createMcpConfigFileStore();
  const categoryWrites = createMcpConfigWrites();
  const copilotMcpPath = pathJoin(process.env.COPILOT_HOME || pathJoin(homedir(), '.copilot'), 'mcp-config.json');
  const studioMcpScript = pathJoin(dirname(fileURLToPath(import.meta.url)), 'automation', 'mcp', 'studio-mcp-server.js');
  let studioBridgeApiBase: string | null = null;
  const studioBridgeHealth = createStudioMcpHealth({
    launch: () => studioBridgeApiBase ? {
      ...providerLaunchSpec(process.execPath, [studioMcpScript]),
      env: { ELECTRON_RUN_AS_NODE: '1', STUDIO_API_BASE: studioBridgeApiBase, STUDIO_CONTROL_TOKEN: studioControlToken },
    } : null,
    files: categoryFiles,
    writes: categoryWrites,
    registrationPaths: [...new Set([copilotMcpPath, pathJoin(homedir(), '.copilot', 'mcp-config.json')])],
    tools: createMcpToolInspector(),
    timeoutMs: mcpConfig.studioProbeTimeoutMs ?? mcpDefaults.studioProbeTimeoutMs!,
    hostGet: async (url, token, timeoutMs) => {
      const response = await fetch(url, {
        headers: { 'x-studio-control-token': token },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
  });
  const agencyNativeSource = 'agency config get mcps';
  const agencyConfigRunner = (timeoutMs: number): AgencyMcpConfigRunner => createAgencyMcpCommandRunner({
    executable: () => resolveExecutable(agencyConfig.executable), cwd: terminalCwd, timeoutMs,
  });
  const agencyMcpStore = createAgencyMcpConfigStore({
    sourcePath: agencyNativeSource,
    runner: agencyConfigRunner(mcpConfig.discoveryTimeoutMs),
  });
  const agencyCatalog = createAgencyMcpCatalog(
    agencyConfigRunner(mcpConfig.catalogTimeoutMs ?? mcpDefaults.catalogTimeoutMs!), AGENCY_PUBLIC_MCPS,
  );
  const agencyGlobalSource = 'agency config get --global mcps';
  const agencySetupRunner = agencyConfigRunner(mcpConfig.builtinSetupTimeoutMs ?? mcpDefaults.builtinSetupTimeoutMs!);
  const agencyGlobalStore = createAgencyMcpConfigStore({
    sourcePath: agencyGlobalSource, scope: 'global', runner: agencySetupRunner,
  });
  const agencyBuiltinSetup = createAgencyMcpBuiltinSetup({
    runner: agencySetupRunner, catalog: agencyCatalog,
    globalStore: agencyGlobalStore, globalSource: agencyGlobalSource, writes: categoryWrites,
  });
  const studioToolInventory: McpToolEntry[] = [];
  registerStudioMcpTools({
    registerTool: (name, definition) => {
      studioToolInventory.push({ name, description: definition.description, enabled: true });
    },
  }, { request: async () => { throw new Error('Tool inventory does not execute requests'); } });
  const nativeAuthenticationJobs = createMcpAuthenticationJobs({
    id: () => ids.next(), now: () => clock.now().getTime(),
    timeoutMs: mcpConfig.nativeAuthTimeoutMs ?? mcpDefaults.nativeAuthTimeoutMs!,
    maxConcurrent: mcpConfig.nativeAuthMaxConcurrent ?? mcpDefaults.nativeAuthMaxConcurrent!,
    maxRetained: 20,
  });
  const mcpService = createMcpCategoryService({
    categories: createMcpCategories(categoryFiles, agencyMcpStore, {
      copilot: copilotMcpPath,
      claude: pathJoin(homedir(), '.claude.json'),
      workspace: terminalCwd,
      workspaceMcp: pathJoin(terminalCwd, '.mcp.json'),
      workspaceGithubMcp: pathJoin(terminalCwd, '.github', 'mcp.json'),
      claudeManaged: process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\managed-mcp.json' : undefined,
      claudeUnavailableReason: process.env.CLAUDE_CONFIG_DIR
        ? 'CLAUDE_CONFIG_DIR is set. The .claude.json relocation has not been verified; use the native Claude configuration instead of editing a guessed path.'
        : undefined,
      agencyNative: agencyNativeSource,
    }, agencyCatalog, { store: agencyGlobalStore, source: agencyGlobalSource, manager: agencyBuiltinSetup },
    createAgencyMcpBuiltinRuntime({ command: () => resolveExecutable(agencyConfig.executable), cwd: terminalCwd }),
    createAgencyMcpOptions({
      runner: agencyConfigRunner(mcpConfig.catalogTimeoutMs ?? mcpDefaults.catalogTimeoutMs!),
      now: () => clock.now().getTime(),
      ttlMs: mcpConfig.optionsCacheTtlMs ?? mcpDefaults.optionsCacheTtlMs!,
      maxConcurrent: 2,
    }))
      // Claude Code is never offered in this IDE (Copilot/Agency only), so the
      // category is dropped from the manager surface while its generic service
      // behaviour stays exercised by createMcpCategories tests.
      .filter((category) => category.info.id !== 'claude'),
    enabled: () => mcpConfig.enabled,
    tools: createMcpToolInspector(),
    probeTimeoutMs: mcpConfig.discoveryTimeoutMs,
    maxConcurrentProbes: mcpConfig.maxConcurrentProbes ?? mcpDefaults.maxConcurrentProbes!,
    writes: categoryWrites,
    authenticationJobs: nativeAuthenticationJobs,
    authenticationTimeoutMs: mcpConfig.nativeAuthTimeoutMs ?? mcpDefaults.nativeAuthTimeoutMs!,
    now: () => clock.now(),
    maxAuthObservations: mcpConfig.authObservationMaxEntries ?? mcpDefaults.authObservationMaxEntries!,
    authObservationStore: mcpAuthObservationRepo,
    // Agency global built-in changes only take effect at launch, so after one is
    // saved we recycle the live Agency terminals and the warm pool (when it runs
    // Agency) so the new configuration applies to running work right away.
    applyGlobalBuiltinChange: async () => {
      let restartedSessions = 0;
      for (const session of sessionRepo.listAll()) {
        if (session.provider !== AGENCY_NAMESPACE) continue;
        if (!terminalManager?.get(session.id)) continue;
        try {
          await terminalManager.relaunch(session, { cwd: await resolveSessionLaunchCwd(session) });
          restartedSessions += 1;
        } catch (error) {
          logger.warn('Failed to restart session after Agency built-in change', {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      let recycledPool = false;
      if (warmProviderIdentity === AGENCY_NAMESPACE) {
        for (const pool of allWarmPools) {
          try {
            pool.resize(0);
            pool.resize(warmPoolCfg.size);
            recycledPool = true;
          } catch (error) {
            logger.warn('Failed to recycle warm pool after Agency built-in change', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return { restartedSessions, recycledPool };
    },
    studio: {
      name: STUDIO_MCP_SERVER_NAME,
      spec: {
        command: process.execPath,
        args: [pathJoin(dirname(fileURLToPath(import.meta.url)), 'automation', 'mcp', 'studio-mcp-server.js')],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      tools: studioToolInventory,
      probe: studioBridgeHealth,
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
        metaAi,
        createTemporaryPromptFileFactory(),
        warmInlinePrompts,
      ),
      config: repositoryContextConfig,
    }),
    clock,
    bus: bus as unknown as EventBus<RepositoryContextEventMap>,
  });
  const repoInsightsService = createRepoInsightsService({
    repos: repoService,
    git: createRepoInsightsGitAdapter(undefined, repoInsightsConfig.gitTimeoutMs),
    clock,
    config: repoInsightsConfig,
    store: createRepoInsightsRepo(db),
    // Each insights section is enriched by its own warmed metasession; the
    // fan-out width scales with the live warm pool (reserving one for other IDE
    // work) and is re-read mid-run so capacity added while scanning is used.
    ai: metaAi,
    liveMetaSessions: () => {
      let live = 0;
      for (const warm of allWarmPools) {
        live += warm.stats().live;
      }
      return live;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    featureExists: (featureId) => featureRepo.get(featureId) !== null,
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
              // A large PR diff can be tens of MB (a giant monorepo PR can top
              // 100 MB). Buffer generously so it is captured in full, and treat
              // an overflow past even this as a truncated success below (the
              // collector only keeps a bounded slice anyway).
              maxBuffer: 256 * 1024 * 1024,
              // Large monorepos (e.g. Azure) can take well over 20s to compute a
              // three-dot diff (merge-base walk + rename detection) on a cold FS
              // cache. A too-tight timeout kills git with SIGTERM, which surfaces
              // as a bogus "git diff failed: exit 1" (killed processes report no
              // exit code and no stderr). Give git a generous budget instead.
              timeout: 180_000,
            },
            (err, stdout, stderr) => {
              // Node reports a maxBuffer overflow with a non-numeric string code
              // and still hands back the captured (truncated) stdout. The diff
              // collector clamps the patch to its own budget, so a truncated but
              // present diff is fine — surface it as success instead of a bogus
              // "git diff failed: exit 1". The exact code has varied across Node
              // versions (`ERR_CHILD_PROCESS_STDOUT_MAXBUFFER` in older releases,
              // `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` in current ones), so match any
              // MAXBUFFER code rather than a single spelling.
              const errCode = (err as { code?: unknown } | null)?.code;
              const overflowed =
                typeof errCode === 'string' && errCode.includes('MAXBUFFER');
              // A timeout/kill leaves `err.killed` set with a null exit code and
              // empty stderr. Synthesise a meaningful message so the review shows
              // "git diff timed out" instead of an opaque "exit 1".
              const killed = Boolean(
                (err as { killed?: boolean } | null)?.killed,
              );
              const code =
                overflowed || !err
                  ? 0
                  : typeof errCode === 'number'
                    ? errCode
                    : 1;
              const resolvedStderr =
                killed && !overflowed && !(stderr ?? '').trim()
                  ? `git ${args[0] ?? 'command'} timed out after 180s`
                  : (stderr ?? '');
              resolve({ code, stdout: stdout ?? '', stderr: resolvedStderr });
            },
          );
        }),
    },
    config: prReviewConfig,
  });
  const backgroundWorkConfig = config[BACKGROUND_WORK_NAMESPACE] as BackgroundWorkConfig;
  const backgroundRunner = createBackgroundWorkRunner<ChangeGraphWorkInput, BuiltChangeGraph>({
    config: backgroundWorkConfig,
    spawn: (input, progress) => spawnChangeGraphWorker(input, progress, backgroundWorkConfig.workerMemoryMb),
  });
  const prReviewService = createPrReviewService({
    reviews: prReviewRepo,
    diffs: prDiffCollector,
    buildGraph: (input, options) => backgroundRunner.run(input, options),
    changeGraphFs: nodeChangeGraphFs,
    ai: metaAi,
    inlinePrompts: warmInlinePrompts,
    metaUsage: createMetaUsageReader({
      usage: usageRepo,
      warmUsage: metaUsageRepo,
    }),
    temporaryPrompts: createTemporaryPromptFileFactory(),
    clock,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    bus: bus as unknown as EventBus<PrReviewEventMap>,
    config: prReviewConfig,
  });
  const reviewBoardService = createReviewBoardService({
    reviews: {
      get: (featureId) => prReviewService.get(featureId),
      save: (review) => prReviewRepo.save(review),
    },
    // Feed the reviewer the PR's already-posted threads and replies so it skips
    // concerns already raised and treats answered ones as resolved. Lazy closure
    // because prCommentsService is composed further below in this root.
    prComments: { list: (featureId) => prCommentsService.list(featureId) },
    config: reviewBoardConfig,
    clock,
    ai: metaAi,
    inlinePrompts: warmInlinePrompts,
    temporaryPrompts: createTemporaryPromptFileFactory(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    bus: bus as unknown as EventBus<ReviewBoardEventMap>,
    // Live warm-session count across every pool, re-read on demand so the
    // server-side board fan-out (analyzeAll) scales with the pool and picks up
    // capacity added mid-run, always reserving one session for other IDE work.
    liveMetaSessions: () => {
      let live = 0;
      for (const warm of allWarmPools) {
        live += warm.stats().live;
      }
      return live;
    },
  });
  // The Agent platform: the Review Board expressed as the first attachable
  // agent. The registry is the single place agents are contributed; the service
  // owns attachment persistence, prerequisite gating and usage roll-up so new
  // agents need no core wiring. Its prerequisite reads the non-throwing PR-review
  // lookup, so the Review Board only attaches where a review exists.
  const agentAttachmentRepo = createAgentAttachmentRepo(db);
  const agentUsageReader = createAgentUsageReader(db);
  const agentRegistry = createAgentRegistry([
    createReviewBoardAgent({
      hasReview: (featureId) => prReviewService.find(featureId) !== null,
    }),
    createNewTaskAgent({
      hasRepo: (featureId) =>
        featureService.list().some(
          (feature) => feature.id === featureId && !!feature.repoId,
        ),
    }),
    createBugBashAgent({
      hasRepo: (featureId) =>
        featureService.list().some(
          (feature) => feature.id === featureId && !!feature.repoId,
        ),
    }),
  ]);
  const agentService = createAgentService({
    registry: agentRegistry,
    attachments: agentAttachmentRepo,
    usage: agentUsageReader,
    clock,
    newId: () => ids.next(),
  });
  // One-shot: attach the Review Board to every pre-existing eligible feature so
  // PR reviews imported before the platform existed keep the board, without ever
  // undoing a later manual detach.
  agentService.backfillAutoAttachments(
    REVIEW_BOARD_AGENT_ID,
    featureService.list().map((feature) => feature.id),
  );

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
          token: azureTokenFor,
          httpGet: azureHttpGet,
          httpPost: azureHttpPost,
          httpPatch: azureHttpPatch,
          httpPut: azureHttpPut,
          httpDelete: azureHttpDelete,
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
          token: azureTokenFor,
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
  const prDescriptionGateways: PrDescriptionGatewayResolver = {
    resolve: (repo, pull) => {
      if (repo.provider === 'github') {
        return createGithubDescriptionGateway(ghRun, {
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
      return createAzureDescriptionGateway(
        {
          token: azureTokenFor,
          httpGet: azureHttpGet,
          httpPatch: azureHttpPatch,
        },
        { ...target, pullRequestId: pull.number },
      );
    },
  };
  const prDescriptionService = createPrDescriptionService({
    reviews: { get: (featureId) => prReviewService.find(featureId) },
    repos: { get: (id) => repoService.list().find((r) => r.id === id) ?? null },
    gateways: prDescriptionGateways,
  });
  const listCheckoutDirectories = async (repoLocalPath: string): Promise<string[]> => {
      const directory = pathJoin(dirname(repoLocalPath), '.ai-worktrees');
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => pathJoin(directory, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
  };
  const worktreeService = createWorktreeService({
    isBusy: createWorktreeActivityGuard({
      repositories: () => repoService.list(),
      sessions: () => sessionRepo.listAll(),
      feature: (id) => featureRepo.get(id),
      reviewPath: (id) => prReviewService.find(id)?.worktreePath ?? null,
      liveTerminal: (id) => {
        const terminal = terminalManager?.get(id);
        return terminal !== undefined && !terminal.exited;
      },
      scopes: () => applicationWork.activeScopes(),
      metaScopes: () => {
        const page = metaOperationRepo.listUnfinishedPage(null, 500);
        const scopes = [...page.items, ...metaOperationOwnership.unconfirmed()];
        if (page.nextCursor) scopes.push({
          featureId: '__unknown_worktree_activity__', originSessionId: null,
          sessionIds: [], operationId: '', automationId: null,
        });
        return scopes;
      },
    }),
    listCheckoutDirectories,
    repos: {
      list: () => repoService.list(),
      get: (id) => repoService.list().find((r) => r.id === id) ?? null,
    },
    reviews: {
      find: (featureId) => {
        const review = prReviewService.find(featureId);
        return review
          ? { repoId: review.repoId, worktreePath: review.worktreePath }
          : null;
      },
    },
    git: { run: (args: string[], cwd: string, signal?: AbortSignal) => gitRun(['-C', cwd, ...args],
      args[0] === 'worktree' && args[1] === 'remove'
        ? { signal, longRunning: true, timeoutMs: 900_000 }
        : { signal, timeoutMs: 5000 }) },
  });
  const resourcesConfig = config[RESOURCES_NAMESPACE] as ResourcesConfig;
  const appDataRoots = [...new Set([currentDataDir, defaultWorkspaceDataDir(), resourcesConfig.desktopDataPath].filter(Boolean))];
  const resourceService = createResourcesService({
    config: resourcesConfig, now: () => Date.now(), backendPid: process.pid,
    host: () => resourceMonitor.snapshot(),
    processes: createProcessSampler(resourcesConfig.processTimeoutMs),
    fs: resourceFileSystem,
    forbiddenRoots: [homedir(), process.env.APPDATA, process.env.LOCALAPPDATA, process.env.SystemRoot].filter((path): path is string => Boolean(path)),
    logs: {
      directory: effectiveLogging.directory, appDataRoots,
      isManagedFile: logPaths.isManagedFile,
      olderThan: Math.min(Date.now() - process.uptime() * 1000, Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)),
    },
    roots: async (signal, reportError) => {
      const roots: StorageRoot[] = appDataRoots.map((path) => ({ category: 'app', path }));
      roots.push({ category: 'logs', path: effectiveLogging.directory });
      if (resourcesConfig.applicationPath) roots.push({ category: 'app', path: resourcesConfig.applicationPath });
      for (const path of resourcesConfig.runtimePaths) roots.push({ category: 'app', path });
      roots.push({ category: 'app', path: dirname(fileURLToPath(import.meta.url)) });
      roots.push({ category: 'app', path: process.execPath });
      if (process.env.CW_UI_DIST) roots.push({ category: 'app', path: process.env.CW_UI_DIST });
      if (resourcesConfig.desktopDataPath) {
        for (const name of ['Cache', 'Code Cache', 'GPUCache']) {
          roots.push({ category: 'cache', path: pathJoin(resourcesConfig.desktopDataPath, name) });
        }
      }
      // These are the install/data locations already used by the Agency bootstrapper,
      // not a walk of the profile. Provider data is shared and never disposable here.
      if (agencyConfig.enabled && process.platform === 'win32') {
        roots.push({ category: 'provider', path: pathJoin(process.env.APPDATA || pathJoin(homedir(), 'AppData', 'Roaming'), 'agency') });
        roots.push({ category: 'provider', path: pathJoin(process.env.LOCALAPPDATA || pathJoin(homedir(), 'AppData', 'Local'), 'agency') });
      }
      try {
        // Reuse authoritative inventory logic with a read-only, scan-scoped
        // command port. Removal's long timeout must not leak into a disk scan.
        const inventory = createWorktreeService({
          repos: {
            list: () => repoService.list(),
            get: (id) => repoService.list().find((repo) => repo.id === id) ?? null,
          },
          reviews: { find: () => null },
          listCheckoutDirectories,
          git: { run: async (args, cwd) => {
            signal.throwIfAborted();
            const result = await gitRun(['-C', cwd, ...args], { signal, timeoutMs: 5000 });
            if (result.code !== 0) throw new Error(`Worktree inventory failed for ${cwd}: ${result.stderr}`);
            return result;
          } },
        });
        for (const worktree of await inventory.list(signal)) roots.push({ category: 'worktrees', path: worktree.path });
      } catch (error) {
        reportError(`Managed worktree inventory is incomplete: ${error instanceof Error ? error.message : String(error)}`);
      }
      return roots;
    },
  });
  const stopResourceSampling = startResourceSampling(resourceService, resourcesConfig.sampleIntervalMs);
  const prFeatureService = createPrFeatureService({
    repos: repoService,
    listPulls: listPullsFor,
    getPull: getPullFor,
    provisionWorktree: (repo, pull, onStatus) =>
      provisionPrWorktree(
        {
          git: (args) => gitRun(args, { longRunning: true }),
          pathExists: existsSync,
          // Azure DevOps only: favourite/publish the source branch first so the
          // git server advertises its ref and the primary fetch resolves it
          // (a pushable worktree). Best-effort — the provisioner swallows any
          // failure and still checks the PR out via its merge ref.
          favouriteBranch:
            repo.provider === 'azure-devops'
              ? async () => {
                  const outcome = await favouriteAzureBranch(
                    {
                      token: azureTokenFor,
                      httpGet: azureHttpGet,
                      httpPost: azureHttpPost,
                    },
                    { remoteUrl: repo.remoteUrl, branch: pull.sourceBranch },
                  );
                  logger.info('Azure DevOps branch favourite attempt', {
                    branch: pull.sourceBranch,
                    status: outcome.status,
                    message: outcome.message,
                  });
                  return {
                    ok:
                      outcome.status === 'favourited' ||
                      outcome.status === 'already',
                    message: outcome.message,
                  };
                }
              : undefined,
        },
        {
          repoLocalPath: repo.localPath,
          provider: repo.provider,
          number: pull.number,
          sourceBranch: pull.sourceBranch,
        },
        onStatus,
      ),
    features: featureService,
    reviews: prReviewService,
    onReviewFeatureCreated: (featureId) =>
      agentService.autoAttach(featureId, REVIEW_BOARD_AGENT_ID),
  });
  // The New Task agent: plan a change, implement it in an isolated worktree,
  // open a pull request, and convert the task into a Review-Board-eligible "PR
  // task" by importing that PR (which nests a review feature and auto-attaches
  // the Review Board). All git/GitHub work runs behind narrow ports.
  const newTaskRunRepo = createNewTaskRunRepo(db);
  const newTaskService = createNewTaskService({
    repo: newTaskRunRepo,
    workspace: {
      resolve: (featureId) => {
        const feature = featureService.get(featureId);
        if (!feature.repoId) {
          throw new ValidationError(
            'This feature has no repository, so New Task cannot open a pull request.',
          );
        }
        const repo = repoService.get(feature.repoId);
        return {
          repoId: repo.id,
          repoLocalPath: repo.localPath,
          baseBranch: repo.defaultBranch ?? 'main',
        };
      },
    },
    git: createNewTaskGit({
      // Bound the network fetch so a slow/unreachable origin fails fast (default
      // ~20s) and falls back to the local base branch instead of stalling
      // planning for up to 15 minutes. Local operations (worktree add, commit,
      // push) keep the long-running budget.
      git: (args) =>
        gitRun(args, { longRunning: !args.includes('fetch') }),
      pathExists: existsSync,
      removeDir: (path) => rmSync(path, { recursive: true, force: true }),
    }),
    pr: createNewTaskPr({
      resolveRepo: (repoId) => repoService.get(repoId),
      gh: ghRun,
      azure: { token: azureTokenFor, httpPost: azureHttpPost },
    }),
    reviews: {
      makeEligible: async ({ repoId, prNumber, featureId }) => {
        const feature = await prFeatureService.convertToPrFeature(
          repoId,
          prNumber,
          featureId,
        );
        return feature.id;
      },
    },
    feature: {
      rename: (featureId, name) => {
        featureService.rename(featureId, name);
      },
    },
    planDoc: {
      write: async ({ worktreePath, path, content }) => {
        writeFileSync(pathJoin(worktreePath, path), content, 'utf8');
      },
    },
    config: newTaskConfig,
    clock,
    ai: metaAi,
    team: createNewTaskTeam({ ai: metaAi, clock, config: newTaskConfig }),
    bus: bus as unknown as EventBus<NewTaskEventMap>,
  });
  const newTaskRunHub = createNewTaskRunHub({ service: newTaskService });
  // The Bug Bash agent: read the feature's repository to generate edge-case
  // scenarios, then run the accepted ones across a team of parallel tester
  // sub-agents and compile a report. It never edits code or opens a PR, so it
  // only needs the repo's local checkout to read/exercise.
  const bugBashRunRepo = createBugBashRunRepo(db);
  const bugBashService = createBugBashService({
    repo: bugBashRunRepo,
    workspace: {
      resolve: (featureId) => {
        const feature = featureService.get(featureId);
        if (!feature.repoId) {
          throw new ValidationError(
            'This feature has no repository, so Bug Bash cannot read its code.',
          );
        }
        const repo = repoService.get(feature.repoId);
        return { repoId: repo.id, repoLocalPath: repo.localPath };
      },
    },
    config: bugBashConfig,
    clock,
    ai: metaAi,
    generateTeam: createBugBashGenerateTeam({
      ai: metaAi,
      clock,
      config: bugBashConfig,
    }),
    team: createBugBashTeam({ ai: metaAi, clock, config: bugBashConfig }),
    bus: bus as unknown as EventBus<BugBashEventMap>,
  });
  const bugBashRunHub = createBugBashRunHub({ service: bugBashService });
  const workspaceAdmin = createWorkspaceAdmin({
    features: featureService,
    sessions: sessionRepo,
    usage: usageRepo,
    usageCaptures: usageCaptureRepo,
    retainedUsage: retainedUsageRepo,
    clock,
    metaUsage: metaUsageRepo,
    mcpUsage: mcpUsageRepo,
    metaOperations: metaOperationRepo,
    quiescence: {
      feature: (id) => requireQuiescence([
        () => applicationWork.quiesceFeature(id, 5_000),
        () => launcher.quiesceFeature(id, 5_000),
        () => terminalManager!.quiesceFeature(id, 5_000),
        () => metaOperationOwnership.quiesceFeature(id, 5_000),
      ]),
      session: (id) => requireQuiescence([
        () => applicationWork.quiesceSession(id, 5_000),
        () => launcher.quiesceSession(id, 5_000),
        () => terminalManager!.quiesceSession(id, 5_000),
        () => metaOperationOwnership.quiesceSession(id, 5_000),
      ]),
    },
    transcripts: transcriptRepo,
    summaries: summaryRepo,
    sessionSummaries: sessionSummaryRepo,
    sessionFiles: sessionFilesRepo,
    terminals: terminalManager!,
    liveUsage: { release: releaseTailer },
    prReviews: prReviewService,
    worktrees: worktreeService,
    sessionWorktrees: { remove: (path) => worktreeService.remove(path) },
    readBranch: (path) => createGitBranchReader().read(path),
    sharedContext: contextService,
    ownedAutomations: {
      deleteByFeature: async (featureId) => {
        await Promise.all(automationService.list()
          .filter((automation) => automation.origin.featureId === featureId)
          .map((automation) => automationService.remove(automation.id)));
      },
      deleteBySession: async (sessionId) => {
        await Promise.all(automationService.list()
          .filter((automation) => automation.origin.sessionId === sessionId)
          .map((automation) => automationService.remove(automation.id)));
      },
    },
    ownedSubagents: {
      deleteByFeature: (featureId) => {
        subagentRepo.deleteByOriginFeature(featureId);
      },
      deleteBySession: (sessionId) => {
        subagentRepo.deleteByOriginSession(sessionId);
      },
    },
    ownedAgents: {
      deleteByFeature: (featureId) => {
        agentService.removeFeature(featureId);
        newTaskRunRepo.deleteByFeature(featureId);
        bugBashRunRepo.deleteByFeature(featureId);
      },
    },
    background: (task) => {
      void task().catch((error) => {
        logger.error('Deferred feature worktree teardown failed', { error });
      });
    },
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
  void applicationWork.own(() => repositoryContextCoordinator.synchronizeSaved()).catch((error) => {
    logger.error('Repository context startup check failed', error);
  });
  const featureTasksRepo = createFeatureTasksRepo(db);
  const featureTasksService = createFeatureTasksService({
    repo: featureTasksRepo,
    runner: createTaskPlanRunner({
      meta: metaAi,
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
  const plannerService = createPlannerService({
    repo: createPlannerRepo(db),
    ids,
    clock,
    config: plannerConfig,
  });
  const plannerSummarizer = createPlannerSummaryRunner({
    planner: plannerService,
    features: featureService,
    meta: metaAi,
    clock,
    config: plannerSummaryConfig,
  });
  const featureTreeService = createFeatureTreeService({
    groups: featureGroupsRepo,
    sessions: sessionRepo,
    features: featureService,
    usage: usageAttributionRepo,
    ids,
    clock,
    config: featureTreeConfig,
  });

  // Monitors & Automations: a background engine that polls a check on an
  // interval and fires an action (metasession/subagent/report/command) when a
  // condition matches. Checks/actions run through the shared meta-runner so
  // their AI usage folds into the existing cost accounting.
  const automationSessionIds = new Map<string, Set<string>>();
  const recordAutomationSession = (automationId: string, sessionId: string): void => {
    const known = automationSessionIds.get(automationId) ?? new Set<string>();
    known.add(sessionId);
    automationSessionIds.set(automationId, known);
  };
  const listAutomationSessions = (automationId: string): string[] => {
    const known = automationSessionIds.get(automationId);
    if (!known) {
      return [];
    }
    return [...known];
  };
  const rawAutomationAi = createAutomationAiInvoker(metaAi);
  const automationAi = {
    run(input: Parameters<typeof rawAutomationAi.run>[0]) {
      if (!input.automationId) {
        return rawAutomationAi.run(input);
      }
      return rawAutomationAi.run({
        ...input,
        onStart: (sessionId) => {
          recordAutomationSession(input.automationId!, sessionId);
          input.onStart?.(sessionId);
        },
      });
    },
  };
  const automationRepo = createAutomationRepo(db);
  const subagentRepo = createSubagentRepo(db);
  const purgeOwnedAutomationSession = async (sessionId: string): Promise<void> => {
    await requireQuiescence([
      () => launcher.quiesceSession(sessionId, 5_000),
      () => terminalManager!.quiesceSession(sessionId, 5_000),
      () => metaOperationOwnership.quiesceSession(sessionId, 5_000),
    ]);
    releaseTailer(sessionId);
    usageCaptureRepo.deleteBySession(sessionId);
    metaUsageRepo.deleteBySession(sessionId);
    metaOperationRepo.deleteBySession(sessionId);
    usageRepo.deleteBySession(sessionId);
    sessionFilesRepo.deleteBySession(sessionId);
    sessionSummaryRepo.delete(sessionId);
    await transcriptRepo.delete(sessionId);
    sessionRepo.delete(sessionId);
  };
  const purgeOwnedAutomationArtifacts = async (automationId: string): Promise<void> => {
    const ownedSessionIds = new Set<string>();
    for (const sessionId of listAutomationSessions(automationId)) {
      ownedSessionIds.add(sessionId);
    }
    for (const run of automationRepo.listRuns(automationId)) {
      if (run.sessionId) {
        ownedSessionIds.add(run.sessionId);
      }
    }
    for (const subagent of subagentRepo.listByAutomation(automationId)) {
      if (subagent.sessionId) {
        ownedSessionIds.add(subagent.sessionId);
      }
    }
    for (const session of sessionRepo.listByFeatureAll(`automation:${automationId}`)) {
      ownedSessionIds.add(session.id);
    }
    let cursor: string | null = null;
    do {
      const page = metaOperationRepo.listPage(
        { automationId }, cursor, metaOperationsConfig.maxPageSize,
      );
      for (const operation of page.items) {
        if (operation.sessionId) ownedSessionIds.add(operation.sessionId);
        for (const sessionId of operation.sessionIds) ownedSessionIds.add(sessionId);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    for (const sessionId of ownedSessionIds) {
      await purgeOwnedAutomationSession(sessionId);
    }
    metaOperationRepo.deleteByAutomation(automationId);
    automationSessionIds.delete(automationId);
  };
  const automationService = createAutomationService({
    repo: automationRepo,
    subagents: subagentRepo,
    ownedArtifacts: { deleteByAutomation: purgeOwnedAutomationArtifacts },
    quiesce: (id) => requireQuiescence([
      () => automationScheduler.quiesce(id, 5_000),
      () => metaOperationOwnership.quiesceAutomation(id, 5_000),
    ]),
    clock,
    ids,
    bus: bus as unknown as EventBus<AutomationEventMap>,
    config: automationConfig,
  });
  const reconciledSubagents = createSubagentReconciler({
    repo: subagentRepo,
    clock,
    bus: bus as unknown as EventBus<SubagentEventMap>,
  }).reconcileOrphans();
  if (reconciledSubagents > 0) {
    logger.info('Reconciled orphaned subagents from previous run', {
      count: reconciledSubagents,
    });
  }
  const subagentService = createSubagentService({
    repo: subagentRepo,
    clock,
    ids,
    bus: bus as unknown as EventBus<SubagentEventMap>,
    ai: automationAi,
    timeoutMs: automationConfig.runTimeoutMs,
  });
  const automationScheduler = createAutomationScheduler({
    repo: automationRepo,
    checks: createCheckRunner({
      shell: createShellExecutor(automationConfig.runTimeoutMs),
      http: createHttpProbe(automationConfig.runTimeoutMs),
      ai: automationAi,
      ci: createCiPipelineProbe(ghRun),
      timeoutMs: automationConfig.runTimeoutMs,
    }),
    actions: createActionRunner({
      ai: automationAi,
      shell: createShellExecutor(automationConfig.runTimeoutMs),
      subagents: subagentService,
      timeoutMs: automationConfig.runTimeoutMs,
    }),
    clock,
    ids,
    bus: bus as unknown as EventBus<AutomationEventMap>,
    config: automationConfig,
    onError: (error) => logger.error('Automation scheduler run failed', error),
  });
  automationScheduler.resume();
  automationScheduler.start();
  // Unified background credential warm loop: keeps the GitHub token and every
  // observed Azure DevOps OAuth token fresh so sessions/MCP servers never block
  // on an interactive re-authentication.
  const credentialWarmer = createCredentialWarmer({
    intervalMs: authWarmerConfig.intervalMs,
    onError: (error) =>
      logger.warn('Credential warm failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    refresh: async () => {
      await refreshGithubCredentialEnv();
      await refreshAzureDevOpsCredentialEnv();
    },
  });
  if (authWarmerConfig.enabled) {
    credentialWarmer.start();
    logger.info('Background credential warm loop started', {
      intervalMs: authWarmerConfig.intervalMs,
    });
  }
  const studioControlToken = randomUUID();

  // HTTP API.
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const settingsAssistant = createSettingsAssistant({ ai: metaAi });

  // Self-healing: environment problems the IDE can fix on the user's behalf
  // (rather than surfacing a dead-end error). Each healer verifies the problem,
  // attempts a fix, and re-verifies; the SSE endpoint below streams progress so
  // the UI can show a live, premium status. Anything that is *not* an actual IDE
  // bug — a missing CLI, an unconfigured model, a fixable config error — belongs
  // here.
  const ghInstallHealer: Healer = {
    info: {
      id: 'github-cli',
      title: 'GitHub CLI',
      description:
        'The GitHub CLI (gh) is required to sign in. Install it automatically.',
      strategy: 'install',
    },
    verify: () =>
      new Promise<boolean>((resolve) => {
        // Re-resolve each time so a freshly installed binary is picked up even
        // though this long-lived process inherited a narrower PATH at launch.
        execFile(
          resolveGhExecutable(),
          ['--version'],
          { windowsHide: true, timeout: 10_000 },
          (err) => resolve(!err),
        );
      }),
    heal: (log) =>
      new Promise<void>((resolve, reject) => {
        const plan = buildGhInstallPlan(process.platform);
        log(plan.help);
        if (!plan.supported) {
          reject(new Error(plan.help));
          return;
        }
        const child = spawn(plan.command, plan.args, { windowsHide: true });
        const onData = (buf: Buffer): void => {
          for (const line of buf.toString().split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.length > 0) {
              log(trimmed);
            }
          }
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (error) =>
          reject(
            error instanceof Error && /ENOENT/.test(error.message)
              ? new Error(
                  `Could not run "${plan.command}". Install GitHub CLI from https://cli.github.com.`,
                )
              : error,
          ),
        );
        child.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Install exited with code ${code ?? 'unknown'}.`));
          }
        });
      }),
  };

  // Heals the "assistant unavailable — configure a model" state by auto-picking
  // the first account-enabled model from the CLI's own catalog and persisting it
  // as the metasession model, so every AI feature starts working immediately.
  const assistantModelHealer: Healer = {
    info: {
      id: 'assistant-model',
      title: 'AI model',
      description:
        'No AI model is configured. Auto-select an available model so AI features work.',
      strategy: 'config',
    },
    verify: async () => {
      const model = metaSettings.get().model;
      return typeof model === 'string' && model.trim().length > 0;
    },
    heal: async (log) => {
      log('Fetching available models from Agency…');
      const models = (await modelCatalogService.read()) ?? [];
      const chosen = models.find((m) => m.enabled) ?? models[0];
      if (!chosen) {
        throw new Error(
          'No models are available from Agency. Make sure you are signed in.',
        );
      }
      log(`Selecting model "${chosen.name}" (${chosen.id}).`);
      const next = metaSettings.set({ model: chosen.id });
      configOverrideService.update(META_NAMESPACE, { model: next.model });
      log('Model configured. AI features are ready.');
    },
  };

  const selfHealService = createSelfHealService({
    healers: [ghInstallHealer, assistantModelHealer],
  });

  // System-health: a representative, bounded set of probes over the backend
  // subsystems the UI depends on, plus each AI provider's install/upgrade state.
  // Every probe is cheap and side-effect-free; a throw or a timeout is reported
  // as `down` so one stuck subsystem never hangs the report. Extend by adding a
  // probe here. Provider health avoids spawning `--version` (which could hang the
  // endpoint) and reuses the version the bootstrapper already resolved, if any.
  const healthConfig = config[HEALTH_NAMESPACE] as HealthConfig;
  const providerHealthSnapshot = (): ProviderHealth[] => {
    const describe = (
      id: string,
      title: string,
      status: { installed: boolean; upgrade?: { phase?: string; version?: string | null } },
    ): ProviderHealth => ({
      id,
      title,
      installed: status.installed,
      ...(status.upgrade?.version ? { version: status.upgrade.version } : {}),
      ...(status.upgrade?.phase ? { upgradePhase: status.upgrade.phase } : {}),
      ...(status.installed
        ? {}
        : { detail: 'Not installed — installs automatically on first use.' }),
    });
    return [
      describe('copilot', 'GitHub Copilot CLI', copilotBootstrapper.status()),
      describe('agency', 'Agency', agencyBootstrapper.status()),
    ];
  };
  const healthReportService = createHealthReportService({
    timeoutMs: healthConfig.probeTimeoutMs,
    providerHealth: providerHealthSnapshot,
    probes: [
      {
        id: 'api',
        title: 'Backend API',
        // Reaching this probe at all proves the HTTP API is serving requests.
        check: () => ({ state: 'ok' }),
      },
      {
        id: 'persistence',
        title: 'Persistence (database)',
        check: () => {
          db.prepare('SELECT 1 AS ok').get();
          return { state: 'ok' };
        },
      },
      {
        id: 'configuration',
        title: 'Configuration',
        check: () => {
          const count = Object.keys(describeNamespaces(registry)).length;
          return count > 0
            ? { state: 'ok', detail: `${count} modules registered` }
            : { state: 'degraded', detail: 'No configuration namespaces registered' };
        },
      },
      {
        id: 'providers',
        title: 'AI providers',
        check: () => {
          const count = providers.list().length;
          return count > 0
            ? { state: 'ok', detail: `${count} registered` }
            : { state: 'down', detail: 'No AI providers registered' };
        },
      },
    ],
  });

  /**
   * Human-readable name for a skill, used as the status line shown while its
   * instruction block is injected. Falls back to a generic label rather than
   * failing: a missing skill must never break the injection it describes.
   */
  const skillLabel = (skillId: string): string => {
    try {
      return `Skill ${skillsService.getSkill(skillId).name}`;
    } catch {
      return 'Skill';
    }
  };

  mountRoutes(
    router,    ownApplicationRoutes(createApiRoutes({
      appResources: resourceService,
      activeSessions,
      resources: () => ({
        ...resourceMonitor.snapshot(),
        backgroundWork: backgroundRunner.stats(),
      }),
      features: featureService,
      admin: workspaceAdmin,
      launcher,
      resolver,
      factory,
      sessionConfig,
      sessions: sessionRepo,
      sessionHistory: copilotHistoryReader,
      resolveSessionCwd,
      resolveSessionEnvironment: (featureId) =>
        featureEnvironmentResolver.resolve(featureId),
      relaunchSession: async (session) => {
        await terminalManager!.relaunch(session, {
          cwd: await resolveSessionLaunchCwd(session),
        });
      },
      providers,
      providerBootstrapInfo: () => {
        const installed = installedProviderIds();
        return {
          defaultProvider: resolverConfig.defaultProvider,
          providers: enabledProviderIds.map((id) => ({
            id,
            installed: installed.has(id),
          })),
        };
      },
      microsoftSignedIn: () => microsoftIdentity.isSignedIn(),
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
          terminalManager!.injectInstructions(
            sessionId,
            instructions,
            skillLabel(skillId),
          );
        }
      },
      // Reverse a session-scoped skill on its live terminal when it is removed,
      // so its guidance is actively undone (negated / plan cancelled).
      removeSessionSkill: (sessionId, skillId) => {
        const prompt = skillsService.removalPromptForSkill(skillId);
        if (prompt.length > 0) {
          terminalManager!.injectInstructions(
            sessionId,
            prompt,
            `${skillLabel(skillId)} removal`,
          );
        }
      },
      tasks: featureTasksService,
      planner: plannerService,
      plannerSummarizer,
      taskLookup: featureTasksRepo,
      tree: featureTreeService,
      groupLookup: featureGroupsRepo,
      ideUsage: ideUsageService,
      usageRollups: usageRollupService,
      metaUsageLookup: metaUsageRepo,
      usageActivityLimit: ideUsageConfig.activityLimit,
      planUsage: planUsageService,
      metaModels: modelCatalogService,
      usageDetail: usageDetailService,
      mcp: mcpService,
      configRegistry: registry,
      currentConfig: config,
      configSecretPaths,
      configOverrides: configOverrideService,
      settingsAssistant,
      selfHeal: selfHealService,
      systemHealth: healthReportService,
      configSchema: () => describeNamespaces(registry),
      metaPools: metaPoolsStatusFn,
      metaOperations: { operations: metaOperationRepo, config: metaOperationsConfig },
      metaPoolsProcessAdmission: () => ({
        ...processAdmission.stats(),
        ...processAdmission.limits(),
      }),
      resizeMetaPool: (size) => resizeMetaPoolFn(size),
      metaSettings: () => ({
        ...exposedMetaSettings.get(),
        warmPoolEnabled: warmPoolCfg.enabled,
      }),
      updateMetaSettings: async (patch) => {
        const current = metaSettings.get();
        const effectiveProviderId = patch.providerId ?? current.providerId;
        const provider = providers.has(effectiveProviderId)
          ? providers.get(effectiveProviderId)
          : null;
        // An explicit model must be valid for the (possibly new) provider —
        // reject it up front rather than persist a combination that fails
        // every metasession the moment it is used.
        if (patch.model !== undefined && patch.model !== 'auto' && provider) {
          const models = await provider.listModels();
          if (!models.some((m) => m.id === patch.model)) {
            throw new ValidationError(
              `Model '${patch.model}' is not available for provider '${effectiveProviderId}'`,
            );
          }
        }
        // Switching provider without an explicit model can silently strand
        // the *previous* provider's model, which is invalid for the new one
        // and would fail every metasession identically. Reset to 'auto' in
        // that case instead of persisting a combination nothing can run.
        let resolvedPatch = patch;
        if (
          patch.providerId !== undefined &&
          patch.model === undefined &&
          current.model !== 'auto' &&
          provider
        ) {
          const models = await provider.listModels();
          if (!models.some((m) => m.id === current.model)) {
            resolvedPatch = { ...patch, model: 'auto' };
          }
        }
        const next = metaSettings.set(resolvedPatch);
        // Persist so the choice survives an IDE restart.
        configOverrideService.update(META_NAMESPACE, { ...resolvedPatch });
        return { ...next, warmPoolEnabled: warmPoolCfg.enabled };
      },
      agencyStatus: () => agencyBootstrapper.status(),
      githubStatus: () => githubAuth.status(),
      githubSignInStart: () => githubDeviceAuth.start(),
      githubSignInPoll,
      githubSignOut,
      azureStatus: async (target) => {
        rememberAzureTarget(target);
        const status = await azureAuth.status(target);
        microsoftIdentity.set(status.authenticated);
        if (status.authenticated) {
          await refreshAzureDevOpsCredentialEnv();
        }
        return status;
      },
      azureSignIn: async (target) => {
        rememberAzureTarget(target);
        const status = await azureAuth.signIn(target);
        microsoftIdentity.set(status.authenticated);
        if (status.authenticated) {
          await refreshAzureDevOpsCredentialEnv();
        }
        return status;
      },
      azureSignOut: async (target) => {
        const status = await azureAuth.signOut(target);
        microsoftIdentity.set(false);
        applyAzureCredentialEnv(null);
        return status;
      },
      repos: repoService,
      repositoryContexts: repositoryContextCoordinator,
      repoInsights: repoInsightsService,
      provisionRepo: provisionRepoInput,
      listGithubRepos: listGithubReposFor,
      listAzureRepos: listAzureReposFor,
      prFeatures: prFeatureService,
      prReviews: prReviewService,
      reviewBoard: reviewBoardService,
      reviewQueue: createReviewBoardQueue(prReviewRepo),
      newTask: newTaskService,
      bugBash: bugBashService,
      agents: agentService,
      prComments: prCommentsService,
      prApprovals: prApprovalService,
      prDescriptions: prDescriptionService,
      worktrees: worktreeService,
      context: contextService,
      automations: automationService,
      automationScheduler,
      subagents: subagentService,
      controlToken: studioControlToken,
      mcpUsage: mcpUsageRepo,
      clock,
      logger,
    }), applicationWork),
    // `logger` is reassigned once the file sink is configured, so the mount
    // captures a stable indirection rather than the value at mount time.
    { error: (message, data) => logger.error(message, data) },
  );
  app.use(apiConfig.basePath, router);

  const openSse = (res: express.Response, onClose: () => void) => {
    const stream = sse.open(res, onClose);
    if (!stream) {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: { kind: 'unavailable', message: 'Live stream connection limit reached' } });
      return null;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    return stream;
  };

  app.get(`${apiConfig.basePath}/stream`, (req, res) => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let off: (() => void) | undefined;
    const stream = openSse(res, () => {
      clearInterval(heartbeat);
      off?.();
    });
    if (!stream) return;
    off = subscribeStream(bus, stream, { includeSessionOutput: req.query.output !== '0' });
    heartbeat = setInterval(() => stream.comment('ping'), apiConfig.sseHeartbeatMs);
    stream.comment('connected');
  });

  // Server-side review-board fan-out. The whole parallel pass runs here and is
  // streamed back as newline-delimited JSON over ONE request, so the number of
  // perspectives reviewed concurrently is bounded by the warm metasession pool
  // (all-but-one) rather than the browser's ~6-connections-per-origin cap that
  // would otherwise hold one socket per in-flight perspective. Each line is a
  // ReviewBoardPerspectiveEvent; live per-lens activity still rides the SSE bus.
  app.post(
    `${apiConfig.basePath}/features/:featureId/review-board/analyze-perspectives`,
    (req, res) => {
      const featureId = req.params.featureId;
      // Validate the review exists before committing to a 200 stream, so a
      // missing PR review returns a normal JSON error with the right status.
      try {
        requireReviewEvidence(prReviewService.get(featureId));
      } catch (error) {
        const result = toErrorResult(error);
        res.status(result.status).json(result.body);
        return;
      }
      const controller = new AbortController();
      let closed = false;
      // Abort only on a genuine *client* disconnect before we finish. This must
      // listen on the response, not the request: `req`'s 'close' fires as soon
      // as express.json() finishes reading the (empty) POST body — which is
      // immediate — and binding the abort there tore down the whole fan-out
      // right after the first wave of events, leaving the warm pool idle while
      // the UI spun forever. `res` 'close' only fires when the response stream
      // ends; `writableFinished` is false only when the socket dropped mid-run.
      res.on('close', () => {
        if (!res.writableFinished) {
          closed = true;
          controller.abort();
        }
      });
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.flushHeaders();
      const sink: ReviewBoardStreamSink = {
        emit: (event) => {
          if (!closed) res.write(`${JSON.stringify(event)}\n`);
        },
      };
      reviewBoardService
        .analyzeAll(featureId, sink, controller.signal)
        .catch((error: unknown) => {
          logger.error('Review Board stream failed', { featureId, error: error instanceof Error ? error.message : String(error) });
          if (!closed) {
            res.write(
              `${JSON.stringify({
                type: 'failed',
                perspectiveId: '',
                error: error instanceof Error ? error.message : String(error),
              })}\n`,
            );
          }
        })
        .finally(() => {
          if (!closed) res.end();
        });
    },
  );

  // Repository insights: fan the four sections (agents, skills, docs, readiness)
  // out across the warm metasession pool — one warmed session per section — and
  // stream each as newline-delimited JSON the moment it settles. Running the
  // whole parallel pass server-side over ONE long-lived request means a large
  // repository fills the page progressively instead of blowing past the single
  // GET timeout, and a slow or self-healing section never blocks the others.
  app.post(`${apiConfig.basePath}/repos/:id/insights/analyze`, (req, res) => {
    const repositoryId = req.params.id;
    // Validate the repository exists before committing to a 200 stream, so an
    // unknown id returns a normal JSON error with the right status.
    try {
      repoService.get(repositoryId);
    } catch (error) {
      const result = toErrorResult(error);
      res.status(result.status).json(result.body);
      return;
    }
    const controller = new AbortController();
    let closed = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        closed = true;
        controller.abort();
      }
    });
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const sink: RepoInsightsStreamSink = {
      emit: (event) => {
        if (!closed) res.write(`${JSON.stringify(event)}\n`);
      },
    };
    repoInsightsService
      .analyzeStream(repositoryId, sink, controller.signal)
      .catch((error: unknown) => {
        if (!closed) {
          res.write(
            `${JSON.stringify({
              type: 'section-failed',
              section: 'readiness',
              error: error instanceof Error ? error.message : String(error),
            })}\n`,
          );
        }
      })
      .finally(() => {
        if (!closed) res.end();
      });
  });

  // PR review checkout with live status: create the PR review feature while
  // streaming coarse checkout phases (favouriting → fetching → preparing) as
  // newline-delimited JSON over ONE request, so the picker overlay shows
  // real-time progress instead of a static spinner. The Azure DevOps favourite
  // step runs first, making an unpublished source branch fetchable. The final
  // line is `{type:'done', feature}` (or `{type:'error', ...}`), matching the
  // shape the streamed client resolves on.
  app.post(`${apiConfig.basePath}/repos/:id/pulls/stream`, (req, res) => {
    const repositoryId = req.params.id;
    let number = NaN;
    let parentFeatureId: string | null = null;
    let parentGroupId: string | null = null;
    try {
      repoService.get(repositoryId);
      const body = (req.body ?? {}) as {
        number?: unknown;
        parentFeatureId?: unknown;
        parentGroupId?: unknown;
      };
      if (typeof body.number !== 'number' || !Number.isFinite(body.number)) {
        throw new ValidationError('A numeric pull request "number" is required.');
      }
      number = body.number;
      parentFeatureId =
        typeof body.parentFeatureId === 'string' ? body.parentFeatureId : null;
      parentGroupId =
        typeof body.parentGroupId === 'string' ? body.parentGroupId : null;
    } catch (error) {
      const result = toErrorResult(error);
      res.status(result.status).json(result.body);
      return;
    }
    let closed = false;
    res.on('close', () => {
      if (!res.writableFinished) closed = true;
    });
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const write = (event: unknown) => {
      if (!closed) res.write(`${JSON.stringify(event)}\n`);
    };
    prFeatureService
      .createFromPull(repositoryId, number, parentFeatureId, parentGroupId, (status) =>
        write({ type: 'status', phase: status.phase, message: status.message }),
      )
      .then((result) =>
        write({
          type: 'done',
          feature: result.feature,
          alreadyImported: result.alreadyImported,
        }),
      )
      .catch((error: unknown) => {
        const result = toErrorResult(error);
        write({ type: 'error', status: result.status, error: result.body });
      })
      .finally(() => {
        if (!closed) res.end();
      });
  });
  // mirroring the implement stream. The request body may carry an optional
  // { baseBranch, suggestion } to cut the branch from a specific base or feed
  // reviewer feedback into a re-plan.
  // Streams a New Task run's buffered + live events to an HTTP response by
  // attaching to the run hub. A client disconnect only detaches this listener —
  // it never cancels the background run, so switching windows can't stop a
  // planning or implementation pass.
  const streamNewTaskRun = (attachmentId: string, res: express.Response): void => {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    let ended = false;
    let detach = (): void => {};
    const finish = (): void => {
      if (ended) return;
      ended = true;
      detach();
      res.end();
    };
    const write = (event: NewTaskStreamEvent): void => {
      if (ended) return;
      res.write(`${JSON.stringify(event)}\n`);
      if (event.type === 'done' || event.type === 'failed' || event.type === 'cancelled')
        finish();
    };
    detach = newTaskRunHub.attach(attachmentId, write);
    if (ended) {
      // A terminal event was replayed synchronously; drop the just-added
      // listener that finish() removed before detach was assigned.
      detach();
    } else {
      res.on('close', () => {
        if (!res.writableFinished) {
          ended = true;
          detach();
        }
      });
    }
  };

  // New Task: produce the reviewable plan — streamed as newline-delimited JSON.
  // The pass runs in the background (via the run hub) so it survives the browser
  // closing this socket; the response replays buffered activity and then tails
  // live events. The request body may carry an optional { baseBranch, suggestion }
  // to cut the branch from a specific base or feed reviewer feedback into a
  // re-plan.
  app.post(
    `${apiConfig.basePath}/features/:featureId/new-task/:attachmentId/plan`,
    (req, res) => {
      const attachmentId = req.params.attachmentId;
      const body = (req.body ?? {}) as {
        baseBranch?: unknown;
        suggestion?: unknown;
      };
      const options = {
        baseBranch:
          typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
        suggestion:
          typeof body.suggestion === 'string' ? body.suggestion : undefined,
      };
      newTaskRunHub.startPlan(attachmentId, options);
      streamNewTaskRun(attachmentId, res);
    },
  );

  // New Task: reconnect to a run already in flight (planning or implementing)
  // WITHOUT starting anything, so a window returning after a switch shows live
  // logs again. When no live run exists the stream ends immediately with no
  // events, letting the UI fall back to its "interrupted — resume" affordance.
  app.get(
    `${apiConfig.basePath}/features/:featureId/new-task/:attachmentId/stream`,
    (req, res) => {
      const attachmentId = req.params.attachmentId;
      // Nothing in flight (e.g. the app restarted mid-run): end at once with an
      // empty body so the UI stops waiting and shows its "interrupted — resume"
      // affordance instead of hanging on an open socket.
      if (!newTaskRunHub.isLive(attachmentId)) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache',
        });
        res.end();
        return;
      }
      streamNewTaskRun(attachmentId, res);
    },
  );

  // New Task: implement the accepted plan, open a PR, and convert the task into
  // a Review-Board-eligible "PR task". The pass runs in the background via the
  // run hub so closing this socket (e.g. switching windows) never stops it;
  // reconnect with the GET stream endpoint to keep watching the live logs.
  app.post(
    `${apiConfig.basePath}/features/:featureId/new-task/:attachmentId/implement`,
    (req, res) => {
      const attachmentId = req.params.attachmentId;
      newTaskRunHub.startImplement(attachmentId);
      streamNewTaskRun(attachmentId, res);
    },
  );

  // New Task: cancel-and-reset the in-flight run. Aborts the background
  // metasession (terminating any attached agent process), then resets the
  // persisted run to a clean draft so the user can retry. Attached stream
  // sockets receive a terminal `cancelled` event and end on their own.
  app.post(
    `${apiConfig.basePath}/features/:featureId/new-task/:attachmentId/cancel`,
    (req, res) => {
      const attachmentId = req.params.attachmentId;
      const cancelled = newTaskRunHub.cancel(attachmentId);
      const run = newTaskService.reset(attachmentId);
      res.json({ cancelled, run });
    },
  );

  // New Task: one plan refine-chat turn. The client posts the full prior
  // conversation plus the new message; the server runs a single AI turn and
  // returns the reply plus any proposed revised plan (awaiting the user's
  // consent — the stored plan is NOT changed here). Plain request/response.
  app.post(
    `${apiConfig.basePath}/features/:featureId/new-task/:attachmentId/refine`,
    async (req, res) => {
      const attachmentId = req.params.attachmentId;
      const body = (req.body ?? {}) as {
        history?: unknown;
        message?: unknown;
      };
      const history = Array.isArray(body.history)
        ? (body.history as Parameters<typeof newTaskService.refine>[1])
        : [];
      const message = typeof body.message === 'string' ? body.message : '';
      try {
        const result = await newTaskService.refine(
          attachmentId,
          history,
          message,
        );
        res.json(result);
      } catch (error) {
        const mapped = toErrorResult(error);
        res.status(mapped.status).json(mapped.body);
      }
    },
  );

  // New Task: clarify the problem statement BEFORE planning. The client posts
  // the current (possibly unsaved) problem + context; the server runs a single
  // lightweight AI turn and returns a clearer rewrite plus the information still
  // missing. Nothing is persisted. Plain request/response.
  app.post(
    `${apiConfig.basePath}/features/:featureId/new-task/:attachmentId/clarify`,
    async (req, res) => {
      const featureId = req.params.featureId;
      const body = (req.body ?? {}) as {
        problem?: unknown;
        context?: unknown;
      };
      const problem = typeof body.problem === 'string' ? body.problem : '';
      const context = typeof body.context === 'string' ? body.context : '';
      try {
        const result = await newTaskService.clarify(featureId, {
          problem,
          context,
        });
        res.json(result);
      } catch (error) {
        const mapped = toErrorResult(error);
        res.status(mapped.status).json(mapped.body);
      }
    },
  );

  // New Task: apply a plan revision the user accepted from the refine chat.
  // This is the consent step for a refine proposal — only now is the plan
  // replaced and persisted. Plain request/response.
  app.post(
    `${apiConfig.basePath}/features/:featureId/new-task/:attachmentId/apply-plan`,
    (req, res) => {
      const attachmentId = req.params.attachmentId;
      const body = (req.body ?? {}) as { plan?: unknown };
      const plan = typeof body.plan === 'string' ? body.plan : '';
      try {
        const run = newTaskService.applyRefinedPlan(attachmentId, plan);
        res.json({ run });
      } catch (error) {
        const mapped = toErrorResult(error);
        res.status(mapped.status).json(mapped.body);
      }
    },
  );

  // Bug Bash: stream a run's buffered + live events to an HTTP response by
  // attaching to its run hub. A client disconnect only detaches this listener —
  // it never cancels the background pass, so switching windows can't stop
  // generation or a run.
  const streamBugBashRun = (
    attachmentId: string,
    res: express.Response,
  ): void => {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    let ended = false;
    let detach = (): void => {};
    const finish = (): void => {
      if (ended) return;
      ended = true;
      detach();
      res.end();
    };
    const write = (event: BugBashStreamEvent): void => {
      if (ended) return;
      res.write(`${JSON.stringify(event)}\n`);
      if (
        event.type === 'done' ||
        event.type === 'failed' ||
        event.type === 'cancelled'
      )
        finish();
    };
    detach = bugBashRunHub.attach(attachmentId, write);
    if (ended) {
      detach();
    } else {
      res.on('close', () => {
        if (!res.writableFinished) {
          ended = true;
          detach();
        }
      });
    }
  };

  // Bug Bash: generate the reviewable scenarios — streamed as newline-delimited
  // JSON. The pass runs in the background (via the run hub) so it survives the
  // browser closing this socket; the response replays buffered activity and then
  // tails live events.
  app.post(
    `${apiConfig.basePath}/features/:featureId/bug-bash/:attachmentId/generate`,
    (req, res) => {
      const attachmentId = req.params.attachmentId;
      bugBashRunHub.startGenerate(attachmentId);
      streamBugBashRun(attachmentId, res);
    },
  );

  // Bug Bash: reconnect to a pass already in flight WITHOUT starting anything,
  // so a window returning after a switch shows live logs again. When no live
  // pass exists the stream ends immediately with no events, letting the UI fall
  // back to its "interrupted — resume" affordance.
  app.get(
    `${apiConfig.basePath}/features/:featureId/bug-bash/:attachmentId/stream`,
    (req, res) => {
      const attachmentId = req.params.attachmentId;
      if (!bugBashRunHub.isLive(attachmentId)) {
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache',
        });
        res.end();
        return;
      }
      streamBugBashRun(attachmentId, res);
    },
  );

  // Bug Bash: run the accepted scenarios across the tester team and compile the
  // report. The pass runs in the background via the run hub so closing this
  // socket never stops it; reconnect with the GET stream endpoint to keep
  // watching the live logs.
  app.post(
    `${apiConfig.basePath}/features/:featureId/bug-bash/:attachmentId/run`,
    (req, res) => {
      const attachmentId = req.params.attachmentId;
      bugBashRunHub.startRun(attachmentId);
      streamBugBashRun(attachmentId, res);
    },
  );

  // Bug Bash: cancel-and-reset the in-flight pass. Aborts the background
  // metasession (terminating any attached agent process), then resets the
  // persisted run so the user can retry. Attached stream sockets receive a
  // terminal `cancelled` event and end on their own.
  app.post(
    `${apiConfig.basePath}/features/:featureId/bug-bash/:attachmentId/cancel`,
    (req, res) => {
      const attachmentId = req.params.attachmentId;
      const cancelled = bugBashRunHub.cancel(attachmentId);
      const run = bugBashService.reset(attachmentId);
      res.json({ cancelled, run });
    },
  );

  // Bug Bash: one refine-chat turn. The user challenges or asks to edit the
  // generated scenarios; the agent replies and, when asked, returns a revised
  // scenario list that replaces the old one. Plain request/response — no stream.
  app.post(
    `${apiConfig.basePath}/features/:featureId/bug-bash/:attachmentId/refine`,
    async (req, res) => {
      const attachmentId = req.params.attachmentId;
      const body = (req.body ?? {}) as {
        history?: unknown;
        message?: unknown;
      };
      const history = Array.isArray(body.history)
        ? (body.history as Parameters<typeof bugBashService.refine>[1])
        : [];
      const message = typeof body.message === 'string' ? body.message : '';
      try {
        const result = await bugBashService.refine(
          attachmentId,
          history,
          message,
        );
        res.json(result);
      } catch (error) {
        const mapped = toErrorResult(error);
        res.status(mapped.status).json(mapped.body);
      }
    },
  );

  // First-run agency install, streamed as SSE so the UI can show live progress.
  // A shared in-flight promise dedupes concurrent connections (e.g. UI reconnect)
  // onto a single install run.
  let agencyInstall: Promise<void> | null = null;
  const installSubscribers = new Map<express.Response, NonNullable<ReturnType<typeof openSse>>>();
  app.get(`${apiConfig.basePath}/agency/install`, (_req, res) => {
    if (!applicationWork.accepting) {
      res.status(409).json({ error: { kind: 'conflict', message: 'Application shutdown is in progress' } });
      return;
    }
    const stream = openSse(res, () => { installSubscribers.delete(res); });
    if (!stream) return;
    installSubscribers.set(res, stream);
    stream.comment('connected');
    const send = (data: unknown): void => {
      for (const subscriber of installSubscribers.values()) subscriber.send(null, data);
    };
    if (!agencyInstall) {
      agencyInstall = applicationWork.own(() => agencyBootstrapper
        .install((event) => send(event))
        .then((status) => {
          if (status.installed) {
            refreshAgencyPath();
          }
        }))
        .catch((error) => {
          // Surface the failure to the subscriber and log it, instead of
          // leaving an unhandled rejection.
          logger.error('Agency install failed', error);
          send({ kind: 'error', line: 'Installation failed. Please retry.' });
        })
        .finally(() => {
          // Always clear the in-flight marker so a failed install can be
          // retried; otherwise every later connection would wedge forever on
          // the "already in progress" branch.
          agencyInstall = null;
          for (const subscriber of installSubscribers.values()) subscriber.end();
        });
    } else {
      // Already installing from another connection; report current status so a
      // late subscriber is not left hanging on a stream with no terminal event.
      stream.send(null,
        agencyBootstrapper.status().installed
          ? { kind: 'done' }
          : { kind: 'line', line: 'Installation already in progress…' },
      );
    }
  });

  // First-run copilot install, streamed as SSE — mirrors `/agency/install` so the
  // first-run gate can install whichever CLI is the network default (and install
  // the other on-demand when the user switches to it).
  let copilotInstall: Promise<void> | null = null;
  const copilotInstallSubscribers = new Map<express.Response, NonNullable<ReturnType<typeof openSse>>>();
  app.get(`${apiConfig.basePath}/copilot/install`, (_req, res) => {
    if (!applicationWork.accepting) {
      res.status(409).json({ error: { kind: 'conflict', message: 'Application shutdown is in progress' } });
      return;
    }
    const stream = openSse(res, () => { copilotInstallSubscribers.delete(res); });
    if (!stream) return;
    copilotInstallSubscribers.set(res, stream);
    stream.comment('connected');
    const send = (data: unknown): void => {
      for (const subscriber of copilotInstallSubscribers.values()) subscriber.send(null, data);
    };
    if (!copilotInstall) {
      copilotInstall = applicationWork.own(() => copilotBootstrapper
        .install((event) => send(event))
        .then((status) => {
          if (status.installed) {
            refreshCopilotPath();
          }
        }))
        .catch((error) => {
          logger.error('Copilot install failed', error);
          send({ kind: 'error', line: 'Installation failed. Please retry.' });
        })
        .finally(() => {
          copilotInstall = null;
          for (const subscriber of copilotInstallSubscribers.values()) subscriber.end();
        });
    } else {
      stream.send(null,
        copilotBootstrapper.status().installed
          ? { kind: 'done' }
          : { kind: 'line', line: 'Installation already in progress…' },
      );
    }
  });

  // Self-heal SSE: verify → fix → re-verify a target, streaming phase/log/done
  // events so the UI shows a live status instead of a dead-end error. Mirrors
  // the `/agency/install` stream shape.
  app.get(`${apiConfig.basePath}/self-heal/:target/run`, (req, res) => {
    if (!applicationWork.accepting) {
      res.status(409).json({ error: { kind: 'conflict', message: 'Application shutdown is in progress' } });
      return;
    }
    const stream = openSse(res, () => {});
    if (!stream) return;
    stream.comment('connected');
    const send = (data: unknown): void => {
      stream.send(null, data);
    };
    applicationWork.own(() => selfHealService
      .heal(String(req.params.target), (event) => send(event)))
      .catch((error) => {
        logger.error('Self-heal failed', error);
        send({
          kind: 'error',
          message: 'Self-heal failed unexpectedly. Please retry.',
        });
      })
      .finally(() => stream.end());
  });

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
    const host =
      apiConfig.host === '0.0.0.0' || apiConfig.host === '::'
        ? '127.0.0.1'
        : apiConfig.host;
    const address = server.address();
    const port =
      typeof address === 'object' && address !== null
        ? address.port
        : apiConfig.port;
    const apiBase = `http://${host}:${port}${apiConfig.basePath}`;
    studioBridgeApiBase = apiBase;
    const script = pathJoin(
      dirname(fileURLToPath(import.meta.url)),
      'automation',
      'mcp',
      'studio-mcp-server.js',
    );
    const mcpProxyScript = pathJoin(
      dirname(fileURLToPath(import.meta.url)),
      'mcp',
      'mcp-proxy.js',
    );
    const studioMcpLaunch = providerLaunchSpec(process.execPath, [script]);
    const studioMcpSpec = {
      command: studioMcpLaunch.command,
      args: studioMcpLaunch.args,
      env: {
        // When Studio is packaged, execPath is the Electron binary; this
        // flag makes it behave as plain Node so the stdio server runs.
        ELECTRON_RUN_AS_NODE: '1',
        STUDIO_API_BASE: apiBase,
        STUDIO_CONTROL_TOKEN: studioControlToken,
      },
    };
    void (async () => {
      try {
        await reconcileStudioMcpRegistrations({
          files: categoryFiles,
          writes: categoryWrites,
          registrationPaths: [...new Set([copilotMcpPath, pathJoin(homedir(), '.copilot', 'mcp-config.json')])],
        }, studioMcpSpec);
      } catch (error: unknown) {
        logger.error('Studio MCP registration reconciliation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      for (const provider of sessionMcpService.listProviders()) {
        try {
          await sessionMcpService.putServer(provider.id, {
            name: STUDIO_MCP_SERVER_NAME,
            spec: studioMcpSpec,
          });
          // Front every OTHER configured stdio server with the measuring proxy
          // so real per-server I/O (bytes/calls/latency) is recorded per feature.
          // The proxy is a transparent pass-through; the wrap is loss-less and
          // undone on shutdown (see unwrapConfiguredMcpServers).
          const current = await sessionMcpService.getServers(provider.id);
          for (const server of current.servers) {
            if (server.name === STUDIO_MCP_SERVER_NAME) {
              continue;
            }
            const wrapped = wrapServerSpec(server.spec, {
              nodePath: process.execPath,
              proxyScript: mcpProxyScript,
              provider: provider.id,
              serverName: server.name,
              apiBase,
              controlToken: studioControlToken,
            });
            if (wrapped !== server.spec) {
              await sessionMcpService.putServer(provider.id, {
                name: server.name,
                spec: wrapped,
              });
            }
          }
        } catch (error: unknown) {
          logger.error('MCP proxy wrapping failed', {
            providerId: provider.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
  });

  let terminalWs: ReturnType<typeof attachTerminalWs> | undefined;
  if (terminalConfig.enabled) {
    terminalWs = attachTerminalWs({
      server,
      manager: terminalManager!,
      config: terminalConfig,
      getSession: (id) => sessionRepo.get(id),
      cwd: terminalCwd,
      resolveCwd: (session, report, signal) => resolveSessionLaunchCwd(session, report, signal),
      // Self-healing diagnosis: when a launch failure cannot be repaired
      // automatically, a read-only metasession explains the likely cause and
      // fix, surfaced in the terminal before the final error. Best-effort.
      diagnose: async (_session, errorText) => {
        try {
          const diagnosis = await metaAi.run({
            featureId: 'self-heal',
            scope: 'internal',
            prompt:
              'An interactive AI coding CLI session failed to start with the ' +
              'error output below. In 1-2 short sentences, state the most ' +
              'likely cause and the concrete fix (for example a missing or ' +
              'deleted working directory, the CLI not being installed, or a ' +
              'permissions problem). Be concise; do not use tools.\n\n---\n' +
              errorText,
            cwd: terminalCwd,
            noTools: true,
            purpose: 'self-heal',
            label: 'Self-healing diagnosis',
          });
          const trimmed = diagnosis.trim();
          return trimmed.length > 0 ? trimmed : null;
        } catch {
          return null;
        }
      },
      logger,
    });
    logger.info(`Interactive terminal WebSocket at ${terminalConfig.wsPath}`);
  }

  // Restore the user's original MCP config (remove the measuring-proxy wrapper)
  // so a wrapped server is never left pointing at the proxy after the app stops.
  // Best-effort: getServers already returns unwrapped specs, so re-persisting
  // them strips the on-disk wrapper.
  const restoreMcpServers = async (): Promise<void> => {
    for (const provider of sessionMcpService.listProviders()) {
      try {
        const current = await sessionMcpService.getServers(provider.id);
        for (const server of current.servers) {
          if (server.name === STUDIO_MCP_SERVER_NAME) {
            continue;
          }
          await sessionMcpService.putServer(provider.id, {
            name: server.name,
            spec: server.spec,
          });
        }
      } catch (error: unknown) {
        logger.error('MCP proxy unwrap failed', {
          providerId: provider.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // Graceful shutdown: stop usage tailers, tear down live PTYs, stop accepting
  // connections and close the database so SQLite is not left mid-write when the
  // desktop shell kills the backend process.
  const shutdownTailers: Iterable<{ stop(): void; finalize?(): unknown }> = {
    *[Symbol.iterator]() {
      yield stoppedCaptureRecovery;
      yield { stop: () => clearInterval(metaUsageTimer) };
      yield { stop: () => { mcpLogCapture.stop(); clearInterval(mcpUsageTimer); } };
      yield* tailers.values();
      yield { stop: () => resourceMonitor.dispose() };
      yield { stop: stopResourceSampling };
    },
  };
  const shutdownNonce = process.env.CW_DESKTOP_SHUTDOWN_NONCE;
  const sendShutdownMessage = process.send?.bind(process);
  const metaOperationShutdown = createMetaOperationShutdown({
    ownership: metaOperationOwnership,
    timeoutMs: 5_000,
    reportError: (error) => logger.error('Meta operation shutdown failed', error),
  });
  const coordinatedShutdown = createShutdownCoordinator({
    admission: processAdmission,
    requests: applicationWork,
    scheduler: automationScheduler,
    headless: launcher,
    owner: {
      abort: () => {
        nativeAuthenticationJobs.close();
        shutdownOwner.abort();
        metaOperationShutdown.abort();
      },
      waitForIdle: (timeoutMs) => shutdownOwner.waitForIdle(timeoutMs),
    },
    pools: [...allWarmPools, {
      closeAndWait: async () => { await backgroundRunner.close(); return true; },
    }],
    tailers: shutdownTailers,
    credentialWarmer,
    terminalManager: terminalManager!,
    server: {
      close: () => new Promise<void>((resolve, reject) => {
        sse.close();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        for (const socket of terminalWs?.clients ?? []) socket.terminate();
        terminalWs?.close();
        server.closeAllConnections();
      }),
    },
    db,
    settleOwnership: () => metaOperationShutdown.settleAfterPhysicalDrain(),
    acknowledge: () => acknowledgeDesktopShutdown(
      shutdownNonce,
      sendShutdownMessage
        ? (message, callback) => { sendShutdownMessage(message, callback); }
        : undefined,
    ),
    exit: (code) => process.exit(code),
    timeoutMs: 5_000,
    reportError: (message, error) => logger.error(message, error),
  });
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down…`);
    await restoreMcpServers();
    if (!await coordinatedShutdown(signal)) {
      logger.error('Shutdown was not confirmed; the backend remains owned and must not be replaced.');
    }
  };
  app.post(`${apiConfig.basePath}/shutdown`, (_req, res) => {
    res.status(202).json({ status: 'shutting-down' });
    setImmediate(() => {
      void shutdown('api:shutdown');
    });
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('message', (message: unknown) => {
    if (isDesktopShutdownRequest(message, shutdownNonce)) {
      void shutdown('desktop:shutdown');
    }
  });
}

main();
