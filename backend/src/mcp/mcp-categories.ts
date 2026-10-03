import type { McpConfigFileStore } from './mcp-contract.js';
import type { McpCategory, McpCategorySource } from './mcp-category-service.js';
import type { AgencyMcpCatalog } from './agency-mcp-catalog.js';
import type { McpBuiltinSetup } from './agency-mcp-builtin-setup.js';
import type { McpBuiltinRuntime } from './mcp-builtin-runtime.js';
import type { McpOptionsProvider } from './agency-mcp-options.js';

export interface McpCategoryPaths {
  copilot: string;
  claude: string;
  workspace: string;
  workspaceMcp: string;
  agencyNative: string;
  workspaceGithubMcp?: string;
  claudeManaged?: string;
  claudeUnavailableReason?: string;
}

/** Documented sources only; session/plugin/managed overlays are deliberately not guessed. */
export function createMcpCategories(
  files: McpConfigFileStore,
  agency: McpConfigFileStore,
  paths: McpCategoryPaths,
  agencyCatalog?: () => Promise<AgencyMcpCatalog>,
  builtinSetup?: { store: McpConfigFileStore; source: string; manager: McpBuiltinSetup },
  builtinRuntime?: McpBuiltinRuntime,
  options?: McpOptionsProvider,
): McpCategory[] {
  const inherited = 'Inherited source: manage this configuration in its owning category or native CLI.';
  const copilot: McpCategorySource = {
    id: 'user', path: paths.copilot, scope: 'Copilot user', store: files, segments: ['mcpServers'],
    supportsToolAllowList: true,
    forbiddenSpecKeys: ['enabled'],
    toggleReason: 'Use copilot mcp enable NAME or copilot mcp disable NAME when supported by your CLI version. The persistent raw flag is not safely inferred here.',
  };
  const claude: McpCategorySource = {
    id: 'user', path: paths.claude, scope: 'Claude user', store: files, segments: ['mcpServers'],
    forbiddenSpecKeys: ['enabled', 'tools'],
    toggleReason: 'Use Claude /mcp to enable or disable servers in the current project. This manager does not invent spec.enabled.',
    toolToggleReason: 'Use Claude /permissions for native tool permissions; spec.tools is not a supported allow-list.',
    restartReason: 'Use Claude /mcp to reconnect the server in that running session. This app cannot control the native session connection.',
  };
  const agencyNative: McpCategorySource = {
    id: 'native', path: paths.agencyNative, scope: 'Agency resolved native mcps (current workspace)', store: agency,
    segments: ['mcps', 'servers'], supportsToolAllowList: true,
    forbiddenSpecKeys: ['enabled'],
    readOnlyReason: 'Agency resolved configuration has no stable writable provenance. Generic object setters can corrupt TOML and there is no generic unset command. Edit the native configuration at its source; no automatic conversion is performed here.',
    missingNotice: 'Agency reports that the native mcps configuration key is not configured in this workspace. This is not a parse failure. Runtime defaults, agent/plugin-injected servers and active CLI connections are not enumerated by this configuration view.',
  };
  const globalBuiltins: McpCategorySource | undefined = builtinSetup ? {
    ...agencyNative, id: 'global-builtins', path: builtinSetup.source, store: builtinSetup.store,
    scope: 'Agency global built-ins (apply to all sessions unless a workspace overrides them)', segments: ['mcps', 'builtins'],
    builtin: true, builtinScope: 'global', supportsEnabled: true,
    supportsNativeToggle: true,
    missingNotice: 'No global Agency mcps configuration exists yet. Use a catalog card to configure a built-in globally.',
    readOnlyReason: 'Use the dedicated built-in setup form to add or reconfigure global built-ins. Raw JSON editing and removal are not supported here; disable a built-in instead of removing it.',
  } : undefined;
  return [
    {
      info: { id: 'agency', label: 'Agency', kind: 'cli', description: 'Agency configuration and separately labeled inherited sources.' },
      catalog: agencyCatalog,
      builtinRuntime,
      options,
      ...(globalBuiltins ? { builtinSetup: { source: globalBuiltins, manager: builtinSetup!.manager } } : {}),
      sources: [
        agencyNative,
        { ...agencyNative, id: 'native-builtins', scope: 'Agency resolved built-ins', segments: ['mcps', 'builtins'], builtin: true, builtinScope: 'resolved', supportsEnabled: true, forbiddenSpecKeys: [] },
        ...(globalBuiltins ? [globalBuiltins] : []),
        { ...copilot, id: 'copilot-user', scope: 'Inherited Copilot user', readOnlyReason: inherited },
        { id: 'workspace', path: paths.workspaceMcp, scope: 'Workspace .mcp.json (Agency default source)', store: files, segments: ['mcpServers'], readOnlyReason: inherited },
      ],
      notices: [
        'Sources are shown separately, not as a complete merged active-session inventory. Agent, CLI, plugin, opt-in VS Code and managed overrides are not enumerated.',
        'The local workspace is the app terminal working directory. Other sessions can use different workspaces.',
        'The native mcps view is resolved configuration, not authored-file provenance. Only explicitly scoped global built-in setup uses the native --mcp setter; resolved/inherited entries and raw JSON remain read-only.',
        'Agency resolves AGENCY_GLOBAL_CONFIG_PATH and its own configuration formats. No format conversion, raw object setter or invented removal value is used.',
        'Agency configuration access does not establish installation health or a live MCP connection.',
      ],
    },
    {
      info: { id: 'copilot', label: 'Copilot CLI', kind: 'cli', description: 'Copilot user configuration and separately labeled current-workspace files; no CLI installation is required to edit the user file.', documentationUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers' },
      sources: [
        copilot,
        { ...copilot, id: 'workspace', path: paths.workspaceMcp, scope: 'Copilot current workspace .mcp.json', allowBareMap: true, readOnlyReason: 'Workspace MCP files require native trust and precedence evaluation. Edit them in the native workspace configuration.' },
        ...(paths.workspaceGithubMcp ? [{
          ...copilot, id: 'github-workspace', path: paths.workspaceGithubMcp, scope: 'Copilot current workspace .github/mcp.json',
          allowBareMap: true, readOnlyReason: 'Workspace MCP files require native trust and precedence evaluation. Edit them in the native workspace configuration.',
        }] : []),
      ],
      notices: [
        'User and current-workspace files are shown separately, not as an effective inventory. Ancestor workspace files up to the git root, plugins, built-ins, managed and session-only servers are not enumerated.',
        'Copilot prefers the closer workspace configuration and .mcp.json over .github/mcp.json at the same directory; workspace trust and active overlays are not evaluated here.',
        'Use /mcp auth NAME inside Copilot for supported native OAuth. No CLI connection or installation check is performed.',
        'Configured file entries are shown as enabled declarations; the CLI persistent enable/disable state is not inferred from an undocumented raw flag. Check its effective state in Copilot.',
      ],
    },
    {
      info: { id: 'claude', label: 'Claude Code', kind: 'cli', description: 'Claude user, local-project and shared-project configuration.', documentationUrl: 'https://code.claude.com/docs/en/mcp' },
      sources: [
        claude,
        { ...claude, id: 'local', scope: `Claude local project: ${paths.workspace}`, segments: ['projects', paths.workspace, 'mcpServers'] },
        { ...claude, id: 'project', path: paths.workspaceMcp, scope: 'Claude shared project (.mcp.json)', segments: ['mcpServers'] },
      ],
      ...(paths.claudeManaged ? { exclusiveSource: {
        ...claude, id: 'managed', path: paths.claudeManaged, scope: 'Claude exclusive managed MCP',
        readOnlyReason: 'Exclusive managed configuration is administrator-owned. Ordinary user/project edits are suppressed.',
      } } : {}),
      ...(paths.claudeUnavailableReason ? { unavailableReason: paths.claudeUnavailableReason } : {}),
      disabledNamesSource: {
        path: paths.claude, store: files, segments: ['projects', paths.workspace, 'disabledMcpServers'],
      },
      notices: [
        'Shared-project configuration still requires native Claude trust/approval. Tool permissions and enabled/disabled state belong to the native CLI, not invented server fields.',
        'Only the app terminal workspace is shown. Additive managed policy, plugins, claude.ai connectors, other workspaces and active-session overlays are not evaluated. Configuration presence does not mean enabled or permitted.',
        'Configuration can be managed without Claude installed. No installation or live-connection status is inferred.',
        'Enabled flags reflect the current project disabledMcpServers preference, not trust, managed permission, or active-connection readiness.',
        'Removal here removes configuration only and preserves OAuth credentials. Use claude mcp login NAME / logout and native remove --scope for native credential lifecycle.',
      ],
    },
    {
      info: { id: 'studio', label: 'This app', kind: 'app', description: 'App-owned Studio MCP server and its registered tool inventory.' },
      sources: [], notices: [],
    },
  ];
}
