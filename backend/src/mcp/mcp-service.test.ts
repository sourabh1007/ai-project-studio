import { describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { IAIProvider, McpSupport } from '../provider/provider-contract.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type { McpConfigDocument, McpConfigFileStore } from './mcp-contract.js';
import { createMcpService } from './mcp-service.js';

function support(overrides: Partial<McpSupport> = {}): McpSupport {
  return {
    configPathPrompt: 'where is your mcp config?',
    parseConfigPath: (reply) => (reply.includes('none') ? null : reply.trim()),
    defaultConfigPath: () => '/default/mcp-config.json',
    ...overrides,
  };
}

function provider(id: string, mcp?: McpSupport): IAIProvider {
  return { id, mcp } as unknown as IAIProvider;
}

function registryOf(...providers: IAIProvider[]): ProviderRegistry {
  const map = new Map(providers.map((p) => [p.id, p]));
  return {
    register: vi.fn(),
    get: (id) => {
      const found = map.get(id);
      if (!found) throw new NotFoundError(`Unknown provider: ${id}`);
      return found;
    },
    has: (id) => map.has(id),
    list: () => [...map.values()],
    ids: () => [...map.keys()],
  };
}

function fileStore(
  read: (path: string) => Promise<McpConfigDocument | null>,
  write?: (path: string, doc: McpConfigDocument) => Promise<void>,
): McpConfigFileStore {
  return { read: vi.fn(read), write: vi.fn(write ?? (async () => {})) };
}

function metaOf(run: MetaRunner['run']): MetaRunner {
  return { run: vi.fn(run) };
}

const enabled = { enabled: true, discoveryTimeoutMs: 1000 };
const disabled = { enabled: false, discoveryTimeoutMs: 1000 };

describe('createMcpService.listProviders', () => {
  it('returns only providers that expose MCP support', () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support()), provider('other')),
      meta: metaOf(async () => ''),
      files: fileStore(async () => null),
      config: enabled,
    });
    expect(service.listProviders()).toEqual([{ id: 'agency' }]);
  });

  it('returns nothing when disabled', () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      files: fileStore(async () => null),
      config: disabled,
    });
    expect(service.listProviders()).toEqual([]);
  });
});

describe('createMcpService.getServers', () => {
  it('uses the default path directly (no meta-session) when it exists', async () => {
    const doc: McpConfigDocument = {
      mcpServers: {
        zeta: { command: 'z' },
        alpha: { command: 'a' },
        broken: 'not-an-object',
      },
    };
    const meta = metaOf(async () => '/discovered/mcp-config.json');
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta,
      files: fileStore(async () => doc),
      config: enabled,
    });
    const result = await service.getServers('agency');
    expect(result).toEqual({
      providerId: 'agency',
      configPath: '/default/mcp-config.json',
      exists: true,
      servers: [
        { name: 'alpha', spec: { command: 'a' } },
        { name: 'zeta', spec: { command: 'z' } },
      ],
    });
    expect(meta.run).not.toHaveBeenCalled();
  });

  it('discovers via meta only when the default file is absent', async () => {
    const meta = metaOf(async () => '/discovered/mcp-config.json');
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta,
      files: fileStore(async (path) =>
        path === '/discovered/mcp-config.json'
          ? { mcpServers: { s: { command: 'x' } } }
          : null,
      ),
      config: enabled,
    });
    const result = await service.getServers('agency');
    expect(result.configPath).toBe('/discovered/mcp-config.json');
    expect(result.servers).toEqual([{ name: 's', spec: { command: 'x' } }]);
    expect(meta.run).toHaveBeenCalledOnce();
  });

  it('caches the discovered path across calls', async () => {
    const meta = metaOf(async () => '/discovered/mcp-config.json');
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta,
      files: fileStore(async () => null),
      config: enabled,
    });
    await service.getServers('agency');
    await service.getServers('agency');
    expect(meta.run).toHaveBeenCalledOnce();
  });

  it('falls back to the default path when discovery yields no path', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => 'none here'),
      files: fileStore(async () => null),
      config: enabled,
    });
    const result = await service.getServers('agency');
    expect(result.configPath).toBe('/default/mcp-config.json');
    expect(result.exists).toBe(false);
    expect(result.servers).toEqual([]);
  });

  it('falls back to the default path when the meta-session fails', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => {
        throw new Error('provider offline');
      }),
      files: fileStore(async () => null),
      config: enabled,
    });
    const result = await service.getServers('agency');
    expect(result.configPath).toBe('/default/mcp-config.json');
  });

  it('falls back to the default path when discovery times out', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(() => new Promise<string>(() => {})),
      files: fileStore(async () => null),
      config: { enabled: true, discoveryTimeoutMs: 5 },
    });
    const result = await service.getServers('agency');
    expect(result.configPath).toBe('/default/mcp-config.json');
  });

  it('treats a missing mcpServers map as no servers', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      files: fileStore(async () => ({ other: true })),
      config: enabled,
    });
    const result = await service.getServers('agency');
    expect(result.servers).toEqual([]);
  });

  it('rejects when disabled', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      files: fileStore(async () => null),
      config: disabled,
    });
    await expect(service.getServers('agency')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects an unknown provider', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      files: fileStore(async () => null),
      config: enabled,
    });
    await expect(service.getServers('ghost')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rejects a provider without MCP support', async () => {
    const service = createMcpService({
      registry: registryOf(provider('plain')),
      meta: metaOf(async () => ''),
      files: fileStore(async () => null),
      config: enabled,
    });
    await expect(service.getServers('plain')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('createMcpService.putServer', () => {
  it('upserts an entry, preserving other servers and top-level keys', async () => {
    const current: McpConfigDocument = {
      $schema: 'x',
      mcpServers: { keep: { command: 'k' } },
    };
    let written: { path: string; doc: McpConfigDocument } | null = null;
    const files = fileStore(
      async () => current,
      async (path, doc) => {
        written = { path, doc };
      },
    );
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => '/x/mcp-config.json'),
      files,
      config: enabled,
    });
    const result = await service.putServer('agency', {
      name: '  added  ',
      spec: { command: 'a', args: ['--x'] },
    });
    expect(written).not.toBeNull();
    expect(written!.path).toBe('/default/mcp-config.json');
    expect(written!.doc).toEqual({
      $schema: 'x',
      mcpServers: {
        keep: { command: 'k' },
        added: { command: 'a', args: ['--x'] },
      },
    });
    expect(result.servers.map((s) => s.name)).toEqual(['added', 'keep']);
  });

  it('creates a fresh document when none exists', async () => {
    let written: McpConfigDocument | null = null;
    const files = fileStore(
      async () => null,
      async (_path, doc) => {
        written = doc;
      },
    );
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => '/x/mcp-config.json'),
      files,
      config: enabled,
    });
    await service.putServer('agency', { name: 'solo', spec: { command: 's' } });
    expect(written).toEqual({ mcpServers: { solo: { command: 's' } } });
  });

  it('ignores a non-object existing mcpServers value', async () => {
    let written: McpConfigDocument | null = null;
    const files = fileStore(
      async () => ({ mcpServers: 'bad' }) as unknown as McpConfigDocument,
      async (_path, doc) => {
        written = doc;
      },
    );
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => '/x/mcp-config.json'),
      files,
      config: enabled,
    });
    await service.putServer('agency', { name: 'solo', spec: { command: 's' } });
    expect(written).toEqual({ mcpServers: { solo: { command: 's' } } });
  });

  it('rejects an empty name', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => '/x/mcp-config.json'),
      files: fileStore(async () => null),
      config: enabled,
    });
    await expect(
      service.putServer('agency', { name: '   ', spec: {} }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a non-object spec', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => '/x/mcp-config.json'),
      files: fileStore(async () => null),
      config: enabled,
    });
    await expect(
      service.putServer('agency', {
        name: 'x',
        spec: ['nope'] as unknown as Record<string, unknown>,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects when disabled', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      files: fileStore(async () => null),
      config: disabled,
    });
    await expect(
      service.putServer('agency', { name: 'x', spec: {} }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
