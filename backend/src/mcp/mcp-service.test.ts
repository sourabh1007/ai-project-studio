import { describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '../kernel/error-types.js';
import type { IAIProvider, McpSupport } from '../provider/provider-contract.js';
import type { ProviderRegistry } from '../provider/provider-registry.js';
import type { MetaRunner } from '../meta/meta-runner.js';
import type {
  McpConfigDocument,
  McpConfigFileStore,
  McpToolInspection,
  McpToolInspector,
} from './mcp-contract.js';
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
  return { run: vi.fn(run), runDetailed: vi.fn() } as unknown as MetaRunner;
}

function inspector(overrides: Partial<McpToolInspector> = {}): McpToolInspector {
  return {
    inspect: vi.fn(async (): Promise<McpToolInspection> => ({
      status: 'ok',
      message: null,
      output: [],
      tools: [
        { name: 'read', description: 'Read things' },
        { name: 'write', description: null },
      ],
    })),
    ...overrides,
  };
}

const enabled = { enabled: true, discoveryTimeoutMs: 1000 };
const disabled = { enabled: false, discoveryTimeoutMs: 1000 };

describe('createMcpService.listProviders', () => {
  it('returns only providers that expose MCP support', () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support()), provider('other')),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => null),
      config: enabled,
    });
    expect(service.listProviders()).toEqual([{ id: 'agency' }]);
  });

  it('returns nothing when disabled', () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
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
      tools: inspector(),
      files: fileStore(async () => doc),
      config: enabled,
    });
    const result = await service.getServers('agency');
    expect(result).toMatchObject({
      providerId: 'agency',
      configPath: '/default/mcp-config.json',
      exists: true,
      servers: [
        {
          name: 'alpha',
          spec: { command: 'a' },
          toolDiscovery: { status: 'skipped' },
        },
        {
          name: 'zeta',
          spec: { command: 'z' },
          toolDiscovery: { status: 'skipped' },
        },
      ],
    });
    // Listing servers must never spawn a child MCP process.
    expect(meta.run).not.toHaveBeenCalled();
  });

  it('discovers via meta only when the default file is absent', async () => {
    const meta = metaOf(async () => '/discovered/mcp-config.json');
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta,
      tools: inspector(),
      files: fileStore(async (path) =>
        path === '/discovered/mcp-config.json'
          ? { mcpServers: { s: { command: 'x' } } }
          : null,
      ),
      config: enabled,
    });
    const result = await service.getServers('agency');
    expect(result.configPath).toBe('/discovered/mcp-config.json');
    expect(result.servers[0]).toMatchObject({ name: 's', spec: { command: 'x' } });
    expect(meta.run).toHaveBeenCalledOnce();
  });

  it('caches the discovered path across calls', async () => {
    const meta = metaOf(async () => '/discovered/mcp-config.json');
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta,
      tools: inspector(),
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
      tools: inspector(),
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
      tools: inspector(),
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
      tools: inspector(),
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
      tools: inspector(),
      files: fileStore(async () => ({ other: true })),
      config: enabled,
    });
    const result = await service.getServers('agency');
    expect(result.servers).toEqual([]);
  });

  it('does not spawn a child process or annotate tools when listing', async () => {
    const inspect = vi.fn(async (): Promise<McpToolInspection> => ({
      status: 'ok',
      message: null,
      output: [],
      tools: [{ name: 'read', description: null }],
    }));
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector({ inspect }),
      files: fileStore(async () => ({
        mcpServers: { s: { command: 'x', tools: ['read'] } },
      })),
      config: enabled,
    });
    const result = await service.getServers('agency');
    expect(inspect).not.toHaveBeenCalled();
    expect(result.servers[0].tools).toBeUndefined();
    expect(result.servers[0].toolDiscovery?.status).toBe('skipped');
  });

  it('rejects when disabled', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
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
      tools: inspector(),
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
      tools: inspector(),
      files: fileStore(async () => null),
      config: enabled,
    });
    await expect(service.getServers('plain')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('createMcpService.inspectServer', () => {
  it('probes an enabled server and annotates tools from config', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => ({
        mcpServers: { s: { command: 'x', tools: ['read'] } },
      })),
      config: enabled,
    });
    const server = await service.inspectServer('agency', ' s ');
    expect(server).toMatchObject({
      name: 's',
      spec: { command: 'x', tools: ['read'] },
      tools: [
        { name: 'read', description: 'Read things', enabled: true },
        { name: 'write', description: null, enabled: false },
      ],
      toolDiscovery: { status: 'ok', message: null, output: [] },
    });
  });

  it('skips a disabled server without spawning a probe', async () => {
    const inspect = vi.fn(async (): Promise<McpToolInspection> => ({
      status: 'ok',
      message: null,
      output: [],
      tools: [],
    }));
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector({ inspect }),
      files: fileStore(async () => ({
        mcpServers: { off: { command: 'x', enabled: false } },
      })),
      config: enabled,
    });
    const server = await service.inspectServer('agency', 'off');
    expect(inspect).not.toHaveBeenCalled();
    expect(server.toolDiscovery).toEqual({
      status: 'skipped',
      message: 'Server is disabled in provider config',
      output: [],
    });
  });

  it('captures Error and non-Error inspector failures', async () => {
    const boom = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector({
        inspect: vi.fn(async () => {
          throw new Error('boom');
        }),
      }),
      files: fileStore(async () => ({ mcpServers: { s: { command: 'x' } } })),
      config: enabled,
    });
    expect((await boom.inspectServer('agency', 's')).toolDiscovery).toEqual({
      status: 'failed',
      message: 'boom',
      output: [],
    });

    const plain = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector({
        inspect: vi.fn(async () => {
          throw 'plain failure';
        }),
      }),
      files: fileStore(async () => ({ mcpServers: { s: { command: 'x' } } })),
      config: enabled,
    });
    expect(
      (await plain.inspectServer('agency', 's')).toolDiscovery?.message,
    ).toBe('plain failure');
  });

  it('rejects empty, unknown, missing-document, and disabled requests', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => ({ mcpServers: { s: { command: 'x' } } })),
      config: enabled,
    });
    await expect(service.inspectServer('agency', '  ')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      service.inspectServer('agency', 'missing'),
    ).rejects.toBeInstanceOf(NotFoundError);

    const missingDocument = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => null),
      config: enabled,
    });
    await expect(
      missingDocument.inspectServer('agency', 's'),
    ).rejects.toBeInstanceOf(NotFoundError);

    const disabledService = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => null),
      config: disabled,
    });
    await expect(
      disabledService.inspectServer('agency', 's'),
    ).rejects.toBeInstanceOf(ValidationError);
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
      tools: inspector(),
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
      tools: inspector(),
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
      tools: inspector(),
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
      tools: inspector(),
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
      tools: inspector(),
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
      tools: inspector(),
      files: fileStore(async () => null),
      config: disabled,
    });
    await expect(
      service.putServer('agency', { name: 'x', spec: {} }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('createMcpService.setToolEnabled', () => {
  it('writes an explicit tool allow-list and live-reloads running sessions', async () => {
    let written: McpConfigDocument | null = null;
    const liveReload = vi.fn(() => 2);
    const service = createMcpService({
      registry: registryOf(provider('agency', support({ liveReloadCommand: '/restart' }))),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(
        async () => ({ mcpServers: { s: { command: 'x', tools: ['*'] } } }),
        async (_path, doc) => {
          written = doc;
        },
      ),
      config: enabled,
      liveReload,
    });
    const result = await service.setToolEnabled('agency', {
      serverName: ' s ',
      toolName: ' write ',
      enabled: false,
    });
    expect(written).toEqual({
      mcpServers: { s: { command: 'x', tools: ['read'] } },
    });
    expect(liveReload).toHaveBeenCalledWith('agency', '/restart');
    expect(result.liveReloadedSessions).toBe(2);
    expect(result.liveReloadCommand).toBe('/restart');
    expect(result.server.tools).toEqual([
      { name: 'read', description: 'Read things', enabled: true },
      { name: 'write', description: null, enabled: false },
    ]);
  });

  it('leaves sibling servers lazy when toggling one server', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(
        async () => ({
          mcpServers: {
            s: { command: 'x', tools: ['*'] },
            other: { command: 'y' },
          },
        }),
        async () => {},
      ),
      config: enabled,
    });
    const result = await service.setToolEnabled('agency', {
      serverName: 's',
      toolName: 'write',
      enabled: false,
    });
    const sibling = result.config.servers.find((s) => s.name === 'other');
    expect(sibling?.toolDiscovery.status).toBe('skipped');
    expect(sibling?.tools).toBeUndefined();
    expect(result.server.name).toBe('s');
  });

  it('collapses the allow-list back to wildcard when every tool is enabled', async () => {
    let written: McpConfigDocument | null = null;
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(
        async () => ({ mcpServers: { s: { command: 'x', tools: ['read'] } } }),
        async (_path, doc) => {
          written = doc;
        },
      ),
      config: enabled,
    });
    const result = await service.setToolEnabled('agency', {
      serverName: 's',
      toolName: 'write',
      enabled: true,
    });
    expect(written).toEqual({
      mcpServers: { s: { command: 'x', tools: ['*'] } },
    });
    expect(result.liveReloadedSessions).toBe(0);
    expect(result.liveReloadCommand).toBeNull();
  });

  it('rejects invalid toggle inputs and failed discovery', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector({
        inspect: vi.fn(async (): Promise<McpToolInspection> => ({
          status: 'failed',
          message: 'login required',
          output: ['visit https://example'],
          tools: [],
        })),
      }),
      files: fileStore(async () => ({ mcpServers: { s: { command: 'x' } } })),
      config: enabled,
    });
    await expect(
      service.setToolEnabled('agency', {
        serverName: '',
        toolName: 'read',
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.setToolEnabled('agency', {
        serverName: 's',
        toolName: '',
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.setToolEnabled('agency', {
        serverName: 's',
        toolName: 'read',
        enabled: false,
      }),
    ).rejects.toThrow('login required');

    const genericFailure = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector({
        inspect: vi.fn(async (): Promise<McpToolInspection> => ({
          status: 'failed',
          message: null,
          output: [],
          tools: [],
        })),
      }),
      files: fileStore(async () => ({ mcpServers: { s: { command: 'x' } } })),
      config: enabled,
    });
    await expect(
      genericFailure.setToolEnabled('agency', {
        serverName: 's',
        toolName: 'read',
        enabled: false,
      }),
    ).rejects.toThrow('MCP tool discovery failed');
  });

  it('rejects an unknown server or tool and when disabled', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => ({ mcpServers: { s: { command: 'x' } } })),
      config: enabled,
    });
    await expect(
      service.setToolEnabled('agency', {
        serverName: 'missing',
        toolName: 'read',
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.setToolEnabled('agency', {
        serverName: 's',
        toolName: 'missing',
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const disabledService = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => null),
      config: disabled,
    });
    await expect(
      disabledService.setToolEnabled('agency', {
        serverName: 's',
        toolName: 'read',
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const missingDocument = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => null),
      config: enabled,
    });
    await expect(
      missingDocument.setToolEnabled('agency', {
        serverName: 's',
        toolName: 'read',
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('createMcpService.restartServer', () => {
  it('probes the server and live-reloads sessions', async () => {
    const liveReload = vi.fn(() => 1);
    const service = createMcpService({
      registry: registryOf(provider('agency', support({ liveReloadCommand: '/restart' }))),
      meta: metaOf(async () => ''),
      tools: inspector({
        inspect: vi.fn(async (): Promise<McpToolInspection> => ({
          status: 'ok',
          message: null,
          output: ['device code ABCD'],
          tools: [{ name: 'read', description: null }],
        })),
      }),
      files: fileStore(async () => ({ mcpServers: { s: { command: 'x' } } })),
      config: enabled,
      liveReload,
    });
    const result = await service.restartServer('agency', ' s ');
    expect(result.server.toolDiscovery).toEqual({
      status: 'ok',
      message: null,
      output: ['device code ABCD'],
    });
    expect(result.liveReloadedSessions).toBe(1);
  });

  it('rejects invalid, unknown, or disabled restart requests', async () => {
    const service = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => ({ mcpServers: { s: { command: 'x' } } })),
      config: enabled,
    });
    await expect(service.restartServer('agency', '')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(service.restartServer('agency', 'missing')).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const disabledService = createMcpService({
      registry: registryOf(provider('agency', support())),
      meta: metaOf(async () => ''),
      tools: inspector(),
      files: fileStore(async () => null),
      config: disabled,
    });
    await expect(disabledService.restartServer('agency', 's')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
