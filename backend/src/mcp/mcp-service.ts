import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { McpSupport } from '../provider/provider-contract.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { McpConfig } from './config.js';
import type {
  McpConfigDocument,
  McpConfigFileStore,
  McpServerEntry,
  McpServerInput,
  ProviderMcpConfig,
} from './mcp-contract.js';

export interface McpServiceDeps {
  registry: ProviderRegistry;
  /** Used to discover a provider's config-file path via a headless session. */
  meta: MetaRunner;
  files: McpConfigFileStore;
  config: McpConfig;
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

/** Surfaces object-valued `mcpServers` entries as a sorted server list. */
function serversFromDocument(document: McpConfigDocument | null): McpServerEntry[] {
  const map = document?.mcpServers;
  if (!isPlainObject(map)) {
    return [];
  }
  return Object.entries(map)
    .filter(([, spec]) => isPlainObject(spec))
    .map(([name, spec]) => ({ name, spec: spec as Record<string, unknown> }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

  function toConfig(
    providerId: string,
    configPath: string,
    document: McpConfigDocument | null,
  ): ProviderMcpConfig {
    return {
      providerId,
      configPath,
      exists: document !== null,
      servers: serversFromDocument(document),
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
      const configPath = await resolveConfigPath(providerId, support);
      const document = await deps.files.read(configPath);
      return toConfig(providerId, configPath, document);
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
      return toConfig(providerId, configPath, next);
    },
  };
}
