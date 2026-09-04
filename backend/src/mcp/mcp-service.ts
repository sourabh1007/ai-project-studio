import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { McpSupport } from '../provider/provider-contract.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { McpConfig } from './config.js';
import type {
  McpConfigDocument,
  McpConfigFileStore,
  McpToolEntry,
  McpToolInspection,
  McpToolInspector,
  McpToolToggleInput,
  McpApplyResult,
  McpServerEntry,
  McpServerInput,
  ProviderMcpConfig,
} from './mcp-contract.js';

export interface McpServiceDeps {
  registry: ProviderRegistry;
  /** Used to discover a provider's config-file path via a headless session. */
  meta: MetaRunner;
  files: McpConfigFileStore;
  tools: McpToolInspector;
  config: McpConfig;
  /** Best-effort live reload hook for already-open interactive sessions. */
  liveReload?: (providerId: string, command: string) => number;
}

/**
 * Provider-agnostic management of MCP servers. It locates each provider's MCP
 * config file at runtime through a provider meta-session (never a hardcoded
 * path), reads the current `mcpServers` map, and upserts entries in place while
 * preserving all other file content.
 */
export interface McpService {
  /** Providers that currently expose MCP support, in registration order. */
  listProviders(): { id: string }[];
  /** Current MCP config (path + servers) for a provider. */
  getServers(providerId: string): Promise<ProviderMcpConfig>;
  /** Adds or updates a single MCP server entry, returning the new config. */
  putServer(providerId: string, input: McpServerInput): Promise<ProviderMcpConfig>;
  /** Enables/disables one discovered MCP tool in provider config. */
  setToolEnabled(
    providerId: string,
    input: McpToolToggleInput,
  ): Promise<McpApplyResult>;
  /** Restarts/reloads one MCP server and open provider sessions where possible. */
  restartServer(providerId: string, serverName: string): Promise<McpApplyResult>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rejects if a promise does not settle within `ms`, so a hung CLI can't block. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('MCP config discovery timed out')),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

function configuredTools(spec: Record<string, unknown>): Set<string> | null {
  const tools = spec.tools;
  if (!Array.isArray(tools)) {
    return null;
  }
  const names = tools.filter((tool): tool is string => typeof tool === 'string');
  return names.includes('*') ? null : new Set(names);
}

function toolEntries(
  spec: Record<string, unknown>,
  inspection: McpToolInspection,
): McpToolEntry[] {
  const allowList = configuredTools(spec);
  return inspection.tools
    .map((tool) => ({
      ...tool,
      enabled: allowList === null || allowList.has(tool.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function skippedInspection(message: string): McpToolInspection {
  return { status: 'skipped', message, output: [], tools: [] };
}

function isEnabledServer(spec: Record<string, unknown>): boolean {
  return spec.enabled !== false;
}

/** Surfaces object-valued `mcpServers` entries as a sorted server list. */
async function serversFromDocument(
  document: McpConfigDocument | null,
  inspect: (name: string, spec: Record<string, unknown>) => Promise<McpToolInspection>,
): Promise<McpServerEntry[]> {
  const map = document?.mcpServers;
  if (!isPlainObject(map)) {
    return [];
  }
  const entries = Object.entries(map)
    .filter(([, spec]) => isPlainObject(spec))
    .map(([name, spec]) => ({ name, spec: spec as Record<string, unknown> }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return await Promise.all(
    entries.map(async (entry) => {
      const inspection = isEnabledServer(entry.spec)
        ? await inspect(entry.name, entry.spec)
        : skippedInspection('Server is disabled in provider config');
      return {
        ...entry,
        tools: toolEntries(entry.spec, inspection),
        toolDiscovery: {
          status: inspection.status,
          message: inspection.message,
          output: inspection.output,
        },
      };
    }),
  );
}

export function createMcpService(deps: McpServiceDeps): McpService {
  // Config-file paths rarely move, so cache the discovered path per provider to
  // avoid re-running a full CLI meta-session on every request.
  const pathCache = new Map<string, string>();

  function ensureEnabled(): void {
    if (!deps.config.enabled) {
      throw new ValidationError('MCP server management is disabled');
    }
  }

  function requireSupport(providerId: string): McpSupport {
    // registry.get throws NotFoundError for unknown providers.
    const support = deps.registry.get(providerId).mcp;
    if (!support) {
      throw new NotFoundError(`Provider '${providerId}' does not support MCP`);
    }
    return support;
  }

  async function resolveConfigPath(
    providerId: string,
    support: McpSupport,
  ): Promise<string> {
    const cached = pathCache.get(providerId);
    if (cached) {
      return cached;
    }
    const defaultPath = support.defaultConfigPath();
    let resolved = defaultPath;
    // Fast path: when the documented config file already exists, read it
    // directly and skip the expensive provider meta-session entirely. The CLI
    // is only consulted when the default is absent (e.g. a non-standard
    // location), and even then it is bounded so a slow/hung CLI can't freeze
    // the surface.
    const existing = await deps.files.read(defaultPath);
    if (existing === null) {
      const discovered = await discoverConfigPath(providerId, support);
      if (discovered) {
        resolved = discovered;
      }
    }
    pathCache.set(providerId, resolved);
    return resolved;
  }

  async function discoverConfigPath(
    providerId: string,
    support: McpSupport,
  ): Promise<string | null> {
    try {
      const reply = await withTimeout(
        deps.meta.run({
          featureId: `mcp:${providerId}`,
          prompt: support.configPathPrompt,
          scope: 'internal',
          label: 'MCP config discovery',
        }),
        deps.config.discoveryTimeoutMs,
      );
      return support.parseConfigPath(reply);
    } catch {
      // A failed/timed-out meta-session must not block the surface; fall back
      // to the provider's documented default path.
      return null;
    }
  }

  async function inspectServer(
    name: string,
    spec: Record<string, unknown>,
  ): Promise<McpToolInspection> {
    try {
      return await deps.tools.inspect({
        serverName: name,
        spec,
        timeoutMs: deps.config.discoveryTimeoutMs,
      });
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        output: [],
        tools: [],
      };
    }
  }

  async function toConfig(
    providerId: string,
    configPath: string,
    document: McpConfigDocument | null,
  ): Promise<ProviderMcpConfig> {
    return {
      providerId,
      configPath,
      exists: document !== null,
      servers: await serversFromDocument(document, inspectServer),
    };
  }

  async function readConfig(
    providerId: string,
    support: McpSupport,
  ): Promise<{ configPath: string; document: McpConfigDocument | null }> {
    const configPath = await resolveConfigPath(providerId, support);
    return { configPath, document: await deps.files.read(configPath) };
  }

  function serverSpec(
    document: McpConfigDocument | null,
    serverName: string,
  ): Record<string, unknown> {
    const servers = document?.mcpServers;
    const spec = isPlainObject(servers) ? servers[serverName] : undefined;
    if (!isPlainObject(spec)) {
      throw new NotFoundError(`Unknown MCP server: ${serverName}`);
    }
    return spec;
  }

  function liveReload(providerId: string, support: McpSupport): {
    command: string | null;
    count: number;
  } {
    const command = support.liveReloadCommand ?? null;
    if (!command || !deps.liveReload) {
      return { command, count: 0 };
    }
    return { command, count: deps.liveReload(providerId, command) };
  }

  async function resultFor(
    providerId: string,
    support: McpSupport,
    configPath: string,
    document: McpConfigDocument,
    serverName: string,
  ): Promise<McpApplyResult> {
    const config = await toConfig(providerId, configPath, document);
    const server = config.servers.find((entry) => entry.name === serverName)!;
    const reloaded = liveReload(providerId, support);
    return {
      config,
      server,
      liveReloadedSessions: reloaded.count,
      liveReloadCommand: reloaded.command,
    };
  }

  return {
    listProviders() {
      if (!deps.config.enabled) {
        return [];
      }
      return deps.registry
        .list()
        .filter((provider) => provider.mcp)
        .map((provider) => ({ id: provider.id }));
    },

    async getServers(providerId) {
      ensureEnabled();
      const support = requireSupport(providerId);
      const { configPath, document } = await readConfig(providerId, support);
      return await toConfig(providerId, configPath, document);
    },

    async putServer(providerId, input) {
      ensureEnabled();
      const support = requireSupport(providerId);
      const name = input.name.trim();
      if (!name) {
        throw new ValidationError('MCP server name is required');
      }
      if (!isPlainObject(input.spec)) {
        throw new ValidationError('MCP server configuration must be an object');
      }
      const configPath = await resolveConfigPath(providerId, support);
      const current = (await deps.files.read(configPath)) ?? {};
      const existing = isPlainObject(current.mcpServers) ? current.mcpServers : {};
      const next: McpConfigDocument = {
        ...current,
        mcpServers: { ...existing, [name]: input.spec },
      };
      await deps.files.write(configPath, next);
      return await toConfig(providerId, configPath, next);
    },

    async setToolEnabled(providerId, input) {
      ensureEnabled();
      const support = requireSupport(providerId);
      const serverName = input.serverName.trim();
      const toolName = input.toolName.trim();
      if (!serverName) {
        throw new ValidationError('MCP server name is required');
      }
      if (!toolName) {
        throw new ValidationError('MCP tool name is required');
      }
      const { configPath, document } = await readConfig(providerId, support);
      const spec = serverSpec(document, serverName);
      const current = document!;
      const inspection = await inspectServer(serverName, spec);
      if (inspection.status !== 'ok') {
        throw new ValidationError(
          inspection.message ?? 'MCP tool discovery failed',
        );
      }
      const discovered = inspection.tools.map((tool) => tool.name).sort();
      if (!discovered.includes(toolName)) {
        throw new NotFoundError(`Unknown MCP tool: ${toolName}`);
      }
      const enabled = new Set(
        toolEntries(spec, inspection)
          .filter((tool) => tool.enabled)
          .map((tool) => tool.name),
      );
      if (input.enabled) {
        enabled.add(toolName);
      } else {
        enabled.delete(toolName);
      }
      const nextTools =
        enabled.size === discovered.length
          ? ['*']
          : discovered.filter((tool) => enabled.has(tool));
      const nextSpec = { ...spec, tools: nextTools };
      const existing = current.mcpServers as Record<string, unknown>;
      const next: McpConfigDocument = {
        ...current,
        mcpServers: { ...existing, [serverName]: nextSpec },
      };
      await deps.files.write(configPath, next);
      return await resultFor(providerId, support, configPath, next, serverName);
    },

    async restartServer(providerId, serverNameInput) {
      ensureEnabled();
      const support = requireSupport(providerId);
      const serverName = serverNameInput.trim();
      if (!serverName) {
        throw new ValidationError('MCP server name is required');
      }
      const { configPath, document } = await readConfig(providerId, support);
      serverSpec(document, serverName);
      const current = document!;
      return await resultFor(providerId, support, configPath, current, serverName);
    },
  };
}
