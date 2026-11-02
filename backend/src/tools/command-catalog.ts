export interface CommandCatalogEntry {
  id: string;
  label: string;
  category: 'provider' | 'repository' | 'mcp' | 'installer' | 'internal' | 'user-owned';
  description: string;
  config?: { namespace: string; keys: readonly string[] };
  required: readonly string[];
  sources: readonly string[];
  owner?: 'module' | 'native' | 'internal' | 'user';
  settingsLink?: 'mcp' | 'automations';
}

/** Metadata only: values, argv containing secrets and native server environments never enter this DTO. */
export function commandCatalog(
  entries: readonly CommandCatalogEntry[],
  exposed: (namespace: string) => boolean,
): CommandCatalogEntry[] {
  return entries.filter((entry) => !entry.config || exposed(entry.config.namespace)).map((entry) => ({
    id: entry.id, label: entry.label, category: entry.category, description: entry.description,
    required: [...entry.required], sources: [...entry.sources],
    ...(entry.config ? { config: { namespace: entry.config.namespace, keys: [...entry.config.keys] } } : {}),
    ...(entry.owner ? { owner: entry.owner } : {}),
    ...(entry.settingsLink ? { settingsLink: entry.settingsLink } : {}),
  }));
}

export const repositoryCommands: readonly CommandCatalogEntry[] = [
  {
    id: 'git', label: 'Git', category: 'repository', owner: 'module',
    description: 'One executable for provisioning, repositories, worktrees, review diffs and task commits. Operation operands and machine-readable formats remain application-owned.',
    config: { namespace: 'git', keys: ['executable'] },
    required: ['Direct argv; repository/path ownership; credential stdin and environment; machine-readable formats; safe checkout/removal guards'],
    sources: [
      'main.ts: gitRun, clone runner, PR diff executor, resource worktree inventory',
      'feature/feature-branch-git-adapter.ts: createGitBranchReader.read',
      'repository-context/git-repository-adapter.ts: getRevision, listTrackedFiles',
      'repo-insights/repo-insights-git-adapter.ts: resolveDefaultBranch, listFiles, readFile, fileExists, lastCommitAuthor',
      'session-worktree/shared-session-checkout.ts: detectDefaultBranch, createSharedCheckoutPreparer',
      'session-worktree/checkout-recovery.ts: createCheckoutRecovery',
      'repo/pr-worktree-provisioner.ts: provisionPrWorktree, reviewInPlace',
      'pr-review/pr-diff-collector.ts: refreshBaseBranch, resolveBaseRef, headIsMergeCommit, resolveDiffRange, collect',
      'worktrees/worktree-service.ts: list, removeAt',
      'new-task/new-task-git.ts: prepareWorktree, commitAll, pushBranch, resolveBaseRev, changedFilesAgainst, fileDiff',
      'desktop/tool-provision.cjs: Git runsOk, overrideBinary, managedIfValid, systemBinary, install, ensure',
    ],
  },
  {
    id: 'github', label: 'GitHub CLI', category: 'repository', owner: 'module',
    description: 'One executable for desktop provisioning, GitHub sign-in, repository and PR operations, and automation CI checks. Tokens are never command settings.',
    config: { namespace: 'githubCli', keys: ['executable'] },
    required: ['Authentication token via stdin; auth environment isolation; JSON/GraphQL response contracts; expected-head approval verification'],
    sources: [
      'main.ts: ghRun, refreshGithubCredentialEnv, githubDeviceAuth.ghLogin, ghInstallHealer.verify',
      'github-auth/github-auth-service.ts: status, token, signOut',
      'repo/github-repo-lister.ts: listGithubRepos',
      'repo/github-pr-lister.ts: listGithubPulls, getGithubPull',
      'repo/github-issue-lister.ts: listGithubIssues',
      'repo/github-pr-comments.ts: listThreadsArgs, setStatusArgs, addThreadArgs, addPrCommentArgs, reactArgs, pullNodeIdArgs; gateway request, list, add, setStatus, react',
      'repo/github-pr-approval.ts: approvePrArgs; gateway read, getHeadSha, approve',
      'repo/github-pr-description.ts: readBodyArgs, writeBodyArgs, getBody, setBody',
      'new-task/new-task-pr.ts: createGithubPr',
      'automation/ci-pipeline-probe-adapter.ts: latestRun',
      'desktop/tool-provision.cjs: GitHub runsOk, overrideBinary, managedIfValid, systemBinary, install, ensure',
    ],
  },
  {
    id: 'azure-credentials', label: 'Git Credential Manager / Azure', category: 'repository', owner: 'internal',
    description: 'Uses the configured Git executable. Azure repository/PR/work-item APIs use HTTP, not an Azure CLI command.',
    required: ['Credential-manager get/erase protocol; secret stdin/output; silent versus explicit interactive sign-in; OAuth/broker policy'],
    sources: ['main.ts: azureAuth credential/config runners', 'azure-auth/azure-devops-auth.ts: configure, check, status, signIn, signOut, token'],
  },
];

export const providerCommands: readonly CommandCatalogEntry[] = [
  {
    id: 'copilot', label: 'GitHub Copilot', category: 'provider', owner: 'module',
    description: 'Interactive, headless, version and quota commands. The loginCommand and liveReloadCommand descriptors have no application execution consumers and are not editable actions here.',
    config: { namespace: 'copilot', keys: ['enabled', 'executable', 'defaultModel', 'models', 'allowAllTools', 'silent', 'screenReader', 'extraArgs', 'interactiveArgs', 'headlessArgs', 'commandProfile.usageCommand', 'commandProfile.versionArgs'] },
    required: ['UUID session identity, model/prompt/attachment binding', 'Headless JSON output and no-color', 'No-tools and headless meta MCP isolation'],
    sources: ['provider/copilot-adapter/copilot-cmd-builder.ts: buildCopilotArgs, buildCopilotInteractiveArgs, buildCopilotCommand', 'provider/copilot-adapter/copilot-provider.ts: startSession, buildInteractiveCommand', 'main.ts: readCopilotVersion, resolveCopilotPath', 'provider/copilot-adapter/copilot-mcp-support.ts: createCopilotMcpSupport (configuration-path lookup only)'],
  },
  {
    id: 'agency', label: 'Agency', category: 'provider', owner: 'module',
    description: 'Agency Copilot passthrough. Available only after authorized internal-user opt-in. The unused loginCommand descriptor is not an editable login action.',
    config: { namespace: 'agency', keys: ['enabled', 'executable', 'subcommand', 'defaultModel', 'models', 'allowAllTools', 'silent', 'screenReader', 'extraArgs', 'interactiveArgs', 'headlessArgs', 'commandProfile.usageCommand', 'commandProfile.versionArgs', 'commandProfile.liveReloadCommand'] },
    required: ['Copilot passthrough separator', 'Provider eligibility and exclusive execution', 'Copilot session/output/no-tools contracts'],
    sources: ['provider/agency-adapter/agency-cmd-builder.ts: buildAgencyCommand', 'provider/agency-adapter/agency-provider.ts: startSession, buildInteractiveCommand', 'main.ts: readAgencyVersion, refreshAgencyPath', 'mcp/mcp-service.ts: liveReload; main.ts: liveReload callback'],
  },
  {
    id: 'claude', label: 'Claude Code', category: 'provider', owner: 'module',
    description: 'Native interactive/headless launches and readiness probes. authLoginArgs and usageCommand are native descriptor hints, not IDE-executed login/quota actions. Plan quota is unsupported.',
    config: { namespace: 'claude', keys: ['enabled', 'executable', 'defaultModel', 'models', 'extraArgs', 'interactiveArgs', 'headlessArgs', 'maxCommandLineLength', 'versionArgs', 'authStatusArgs', 'probeTimeoutMs', 'installTimeoutMs', 'historyDirectory', 'historyMaxBytes', 'historyMaxRecords', 'historyMaxSessions', 'historyTimeoutMs', 'historyWorkerMemoryMb', 'historyMaxEntries'] },
    required: ['UUID/resume identity', 'Stream JSON/verbose output; prompt delimiter', 'Native authentication/readiness policy; no-tools/meta MCP isolation'],
    sources: ['provider/claude-adapter/claude-commands.ts: buildClaudeArgs', 'provider/claude-adapter/claude-provider.ts: startSession, buildInteractiveCommand, claudeProbeCommands', 'main.ts: runClaudeProbe, refreshClaudeReadiness, resolveClaudePath'],
  },
  {
    id: 'acp', label: 'Warm ACP and model catalog', category: 'provider', owner: 'module',
    description: 'Optional transport arguments for warm sessions and non-billable model-catalog handshakes. Uses the selected compatible provider route.',
    config: { namespace: 'meta', keys: ['providerId', 'model', 'responseTextKeys', 'timeoutMs', 'warmPool'] },
    required: ['ACP stdio protocol; built-in MCP suppression', 'Execution admission, provider identity and bounded handshake lifecycle'],
    sources: ['meta/acp/acp-process-adapter.ts: constructor', 'meta/model-catalog/acp-model-catalog-probe.ts: fetch', 'main.ts: startWarmPool.createClient, catalogForProvider'],
  },
  {
    id: 'quota', label: 'Plan usage probe', category: 'provider', owner: 'module',
    description: 'Optional arguments for the active provider quota TUI; the slash command references the provider profile above.',
    config: { namespace: 'planUsage', keys: ['extraArgs', 'refreshMinutes', 'failureThreshold'] },
    required: ['UUID/model binding; Agency passthrough; submit keystroke', 'No prompt execution; unsupported-provider rejection'],
    sources: ['plan-usage/plan-usage-command.ts: buildPlanUsageProbeCommand', 'plan-usage/pty-plan-usage-probe.ts: spawnLive, capture', 'main.ts: quotaService'],
  },
  {
    id: 'agency-install', label: 'Agency installer / upgrade', category: 'installer', owner: 'module',
    description: 'Platform launcher paths for the official Agency bootstrap. Payload and package identity are protected.',
    config: { namespace: 'agencyBootstrap', keys: ['windowsExecutable', 'posixExecutable'] },
    required: ['Official bootstrap payload; explicit authorized installation policy'],
    sources: ['agency-bootstrap/agency-install-command.ts: agencyInstallCommand', 'agency-bootstrap/agency-bootstrapper.ts: runInstall, install, upgradeToLatest'],
  },
  {
    id: 'copilot-install', label: 'Copilot installer / upgrade', category: 'installer', owner: 'module',
    description: 'Platform launcher paths for the Copilot npm installation; Windows npm shim handling is preserved.',
    config: { namespace: 'copilotBootstrap', keys: ['windowsExecutable', 'posixExecutable'] },
    required: ['Official package identity; platform launcher semantics; explicit install policy'],
    sources: ['copilot-bootstrap/copilot-install-command.ts: copilotInstallCommand', 'copilot-bootstrap/copilot-bootstrapper.ts: runInstall, install, upgradeToLatest'],
  },
  {
    id: 'claude-install', label: 'Claude installer', category: 'installer', owner: 'module',
    description: 'Platform launcher paths with explicit installation consent. Official payloads are the defaults; legacy trusted custom installer scripts remain compatible but are not exposed as templates here.',
    config: { namespace: 'claude', keys: ['installWindowsExecutable', 'installPosixExecutable'] },
    required: ['Official payload defaults; legacy trusted script compatibility remains outside this editor', 'Explicit consent; platform support and timeout'],
    sources: ['provider/claude-adapter/claude-commands.ts: claudeInstallationPlan, buildClaudeInstallCommand', 'main.ts: claudeBootstrapper.install'],
  },
  {
    id: 'github-install', label: 'GitHub CLI installer', category: 'installer', owner: 'module',
    description: 'Supported package-manager launcher paths used by explicit self-healing installation.',
    config: { namespace: 'selfHeal', keys: ['wingetExecutable', 'brewExecutable'] },
    required: ['Official GitHub CLI package identity and package-manager arguments'],
    sources: ['self-heal/gh-install.ts: buildGhInstallPlan', 'main.ts: ghInstallHealer.heal'],
  },
];

export const internalCommands: readonly CommandCatalogEntry[] = [
  {
    id: 'desktop-runtime', label: 'Desktop Node.js runtime', category: 'internal', owner: 'module',
    description: 'The desktop reads this override before provisioning. Empty selects its managed compatible runtime. CW_NODE_BIN takes precedence; desktop restart required.',
    config: { namespace: 'desktopRuntime', keys: ['nodeExecutable'] },
    required: ['Compatible native-addon ABI; pinned verified downloads; backend entry, IPC and lifecycle identity are read-only'],
    sources: ['desktop/main.cjs: ensureBackendDependencies, startBackend', 'desktop/node-provision.cjs: readNodeVersion, overrideBinary, managedBinaryIfValid, systemBinary, installPinned, ensureNode', 'desktop/dependency-provision.cjs: provisionDependencies'],
  },
  {
    id: 'native-helpers', label: 'Native process and extraction helpers', category: 'internal', owner: 'internal',
    description: 'Internal implementation, not shell templates. Required system helpers and scripts are intentionally read-only.',
    required: ['PowerShell resource sampling script/output schema', 'Owned-PID taskkill tree cleanup', 'tar/PowerShell verified archive extraction', 'Verified desktop installer silent flags'],
    sources: ['resources/resources-node-adapter.ts: createProcessSampler', 'provider/process-kernel/process-tree-kill.ts: killProcessTree', 'desktop/provision-io.cjs: extractArchive', 'desktop/update-manager.cjs: runSilentInstall'],
  },
  {
    id: 'launch-transports', label: 'Process, PTY and worker transports', category: 'internal', owner: 'internal',
    description: 'Transport helpers consume their owning tool configuration; they do not have competing executable settings.',
    required: ['Direct argv and Windows executable resolution', 'Worker module entries and bounded ownership'],
    sources: ['provider/process-kernel/process-spawner.ts: defaultRawSpawn, createProcessSpawner', 'terminal/node-pty-spawner.ts: spawn', 'terminal/executable-resolver.ts: resolveExecutable', 'github-auth/gh-executable.ts: resolveGhExecutable', 'terminal/terminal-manager.ts: spawnTerminal, seedNow', 'logging/log-writer-worker-entry.ts: spawnLogWriterWorker', 'usage-summary/usage-summary-worker-adapter.ts: spawnUsageSummaryWorker', 'pr-review/change-graph-worker-adapter.ts: spawnChangeGraphWorker', 'copilot-history/copilot-live-prompt-fs-adapter.ts: spawnLiveScanWorker', 'provider/claude-adapter/claude-native-history.ts: spawnClaudeHistoryWorker'],
  },
  {
    id: 'user-commands', label: 'User terminal and automation commands', category: 'user-owned', owner: 'user', settingsLink: 'automations',
    description: 'Ordinary terminal input is user-owned. Shell checks/actions are configured per automation, not replaced by global executable profiles.',
    required: ['Per-automation consent, cwd, cancellation and timeout'],
    sources: ['automation/shell-executor-adapter.ts: exec', 'automation/check-runner.ts: runShell, run', 'automation/action-runner.ts: run', 'terminal/terminal-ws-server.ts: terminal input forwarding'],
  },
  {
    id: 'native-ui', label: 'Clipboard and native opening', category: 'internal', owner: 'internal',
    description: 'Electron/browser clipboard, openExternal/openPath and command-palette actions use native/UI APIs, not external command-line programs.',
    required: ['Trusted IPC and native/browser API boundaries'],
    sources: ['desktop/clipboard.cjs: writeClipboard, writeClipboardWithRetry, registerClipboardIpc', 'ui/src/hooks/clipboard-write.ts: browser copy fallback', 'desktop/main.cjs: openDocs, native opening handlers', 'ui/src/components/command-palette.tsx: UI actions'],
  },
];

export const mcpCommands: readonly CommandCatalogEntry[] = [
  {
    id: 'mcp-definitions', label: 'MCP servers and launchers', category: 'mcp', owner: 'native', settingsLink: 'mcp',
    description: 'Edit server commands and structured arguments in the existing MCP definition editor. Its provider-owned files and environments are never copied into this catalog. Module settings below control explicit, bounded discovery and authentication jobs.',
    config: { namespace: 'mcp', keys: ['enabled', 'discoveryTimeoutMs', 'maxConcurrentProbes', 'studioProbeTimeoutMs', 'catalogTimeoutMs', 'builtinSetupTimeoutMs', 'nativeAuthTimeoutMs', 'nativeAuthMaxConcurrent', 'optionsCacheTtlMs', 'authObservationMaxEntries'] },
    required: ['Native server definition ownership; explicit probe/authentication consent', 'JSON-RPC initialization, tools/list and stdio transport', 'Secret environment isolation and redaction; bounded cancellation and cleanup'],
    sources: ['mcp/mcp-tool-inspector-adapter.ts: createMcpToolInspector.inspect',
      'mcp/mcp-inspector-launch.ts: mcpInspectorLaunch', 'mcp/mcp-category-service.ts: inspectServer, startAuthentication',
      'mcp/mcp-service.ts: discoverConfigPath, getServers, inspectServer, liveReload',
      'mcp/mcp-proxy-config.ts: providerLaunchSpec, wrapServerSpec, unwrapServerSpec',
      'mcp/mcp-proxy.ts: native child spawn', 'mcp/studio-mcp-health.ts: createStudioMcpHealth',
      'main.ts: toolInspector, MCP category runtimes'],
  },
  {
    id: 'agency-native-mcp', label: 'Agency native MCP operations', category: 'mcp', owner: 'native', settingsLink: 'mcp',
    description: 'Uses the Agency executable configured above. Native help, configuration, setup and server/authentication operations are protocol-owned, not editable shell templates. Service credentials remain native; listing tools alone does not establish reusable authentication.',
    config: { namespace: 'agency', keys: ['executable'] },
    required: ['Native mcp/config/help operation and global scope arguments', 'Explicit setup/authentication actions; installed allowlisted catalog', 'No invented token injection, external-server credential export or automated sign-in on page load'],
    sources: ['mcp/agency-mcp-command-adapter.ts: createAgencyMcpCommandRunner.run',
      'mcp/agency-mcp-builtin-runtime.ts: createAgencyMcpBuiltinRuntime.resolve',
      'mcp/agency-mcp-config-store.ts: createAgencyMcpConfigStore.read, write',
      'mcp/agency-mcp-catalog.ts: createAgencyMcpCatalog',
      'mcp/agency-mcp-options.ts: createAgencyMcpOptions',
      'mcp/agency-mcp-builtin-setup.ts: createAgencyMcpBuiltinSetup',
      'main.ts: Agency config/catalog/native runtime wiring'],
  },
];
