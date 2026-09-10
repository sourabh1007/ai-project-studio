import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IAIProvider, McpSupport } from '../provider/provider-contract.js';
import { createProviderRegistry } from '../provider/provider-registry.js';
import { createMcpConfigFileStore } from '../mcp/mcp-config-file-adapter.js';
import { createMcpService } from '../mcp/mcp-service.js';

function createSupport(configPath: string): McpSupport {
  return {
    configPathPrompt: 'print the MCP config path',
    parseConfigPath: (reply) => reply.trim() || null,
    defaultConfigPath: () => configPath,
    liveReloadCommand: '/restart',
  };
}

function createProvider(id: string, mcp: McpSupport): IAIProvider {
  return {
    id,
    mcp,
    listModels: async () => [],
    startSession: () => {
      throw new Error('The integration fake does not start CLI sessions');
    },
    buildInteractiveCommand: () => {
      throw new Error('The integration fake does not build CLI sessions');
    },
  };
}

describe('MCP management integration', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds and edits a real config, discovers and toggles tools, then reloads active sessions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-management-integration-'));
    temporaryDirectories.push(directory);
    const configPath = join(directory, 'copilot', 'mcp-config.json');
    const files = createMcpConfigFileStore();
    await files.write(configPath, {
      $schema: 'https://example.test/mcp.schema.json',
      mcpServers: {
        existing: { command: 'existing-server' },
      },
    });

    const registry = createProviderRegistry();
    registry.register(createProvider('copilot', createSupport(configPath)));

    const inspections: string[] = [];
    const activeSessions = [
      { id: 'session-1', provider: 'copilot', status: 'running' },
      { id: 'session-2', provider: 'copilot', status: 'completed' },
    ];
    const reloads: Array<{ sessionId: string; command: string; reason: string }> = [];
    const terminal = {
      injectInstructions(sessionId: string, command: string, reason: string): boolean {
        const session = activeSessions.find((candidate) => candidate.id === sessionId);
        if (!session || session.status !== 'running') return false;
        reloads.push({ sessionId, command, reason });
        return true;
      },
    };
    const service = createMcpService({
      registry,
      meta: {
        run: async () => configPath,
        runDetailed: async () => ({ text: configPath, sessionId: 'unused' }),
      },
      files,
      tools: {
        async inspect(input) {
          inspections.push(input.serverName);
          return {
            status: 'ok',
            message: null,
            output: ['connected to deterministic MCP server'],
            tools: [
              { name: 'list', description: 'List records' },
              { name: 'write', description: 'Write records' },
            ],
          };
        },
      },
      config: { enabled: true, discoveryTimeoutMs: 1000 },
      liveReload: (providerId, command) => {
        let applied = 0;
        for (const session of activeSessions) {
          if (
            session.provider === providerId &&
            session.status === 'running' &&
            terminal.injectInstructions(session.id, command, 'MCP configuration')
          ) {
            applied += 1;
          }
        }
        return applied;
      },
    });

    const added = await service.putServer('copilot', {
      name: ' records ',
      spec: { command: 'records-server', args: ['--readonly'] },
    });
    expect(added.servers.map((server) => server.name)).toEqual(['existing', 'records']);

    await service.putServer('copilot', {
      name: 'records',
      spec: { command: 'records-server', args: ['--workspace'] },
    });
    const stored = await files.read(configPath);
    expect(stored).toEqual({
      $schema: 'https://example.test/mcp.schema.json',
      mcpServers: {
        existing: { command: 'existing-server' },
        records: { command: 'records-server', args: ['--workspace'] },
      },
    });

    const inspected = await service.inspectServer('copilot', 'records');
    expect(inspected).toMatchObject({
      name: 'records',
      tools: [
        { name: 'list', enabled: true },
        { name: 'write', enabled: true },
      ],
      toolDiscovery: { status: 'ok' },
    });
    expect(inspections).toEqual(['records']);

    const toggled = await service.setToolEnabled('copilot', {
      serverName: 'records',
      toolName: 'write',
      enabled: false,
    });
    expect(toggled.server).toMatchObject({
      name: 'records',
      spec: { tools: ['list'] },
      tools: [
        { name: 'list', enabled: true },
        { name: 'write', enabled: false },
      ],
    });
    expect(toggled.liveReloadedSessions).toBe(1);
    expect(reloads).toEqual([
      { sessionId: 'session-1', command: '/restart', reason: 'MCP configuration' },
    ]);

    const restarted = await service.restartServer('copilot', 'records');
    expect(restarted.server.toolDiscovery?.status).toBe('ok');
    expect(restarted.liveReloadedSessions).toBe(1);
    expect(reloads).toHaveLength(2);
    expect(reloads[1]?.sessionId).toBe('session-1');
  });
});
