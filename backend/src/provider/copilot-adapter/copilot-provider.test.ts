import { describe, it, expect } from 'vitest';
import { createCopilotProvider } from './copilot-provider.js';
import { copilotDefaults } from './config.js';
import type {
  ProcessHandle,
  ProcessSpawner,
  SpawnRequest,
} from '../process-kernel/process-spawner.js';
import type { SessionSpec } from '../provider-contract.js';

function fakeSpawner() {
  const requests: SpawnRequest[] = [];
  const handle: ProcessHandle = {
    onStdoutLine: () => {},
    onStderrLine: () => {},
    onExit: () => {},
    kill: () => {},
    done: Promise.resolve(0),
    snapshot: () => ({ phase: 'exited' }),
  };
  const spawner: ProcessSpawner = {
    spawn: (req) => {
      requests.push(req);
      return handle;
    },
  };
  return { spawner, requests };
}

const spec: SessionSpec = {
  sessionId: 'sess-1',
  featureId: 'feat-1',
  prompt: 'hello',
  model: 'gpt-5.4',
  kind: 'dev',
  otelFilePath: '/tmp/u.jsonl',
  cwd: '/work',
};

describe('copilot-provider', () => {
  it('builds persistent tool-free ACP commands through the native resolver with usage identity', () => {
    const { spawner } = fakeSpawner();
    for (const resolveCommand of [undefined, ({ args }: { args: string[] }) => ({ command: 'native.exe', args })]) {
      const provider = createCopilotProvider(copilotDefaults, { spawner, baseEnv: {}, resolveCommand });
      const command = provider.buildWarmCommand!({ ...spec, noTools: true }, [], ['custom']);
      expect(command.command).toBe(resolveCommand ? 'native.exe' : copilotDefaults.executable);
      expect(command.args).toContain('--acp');
      expect(command.args).toContain('--available-tools');
      expect(command.args).toContain('--disable-mcp-server');
      expect(command.env.STUDIO_PROVIDER_ID).toBe('copilot');
    }
  });
  it('uses the injected native launcher for both interactive and headless argv without shell expansion', () => {
    const { spawner, requests } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner, baseEnv: {}, mcpServerNames: () => ['plugin:server'],
      resolveCommand: ({ args }) => ({ command: 'node.exe', args: ['loader.js', ...args] }),
    });
    provider.startSession({ ...spec, kind: 'meta' });
    expect(requests[0].command).toBe('node.exe');
    expect(requests[0].args[0]).toBe('loader.js');
    expect(requests[0].args).toContain('--disable-builtin-mcps');
    expect(requests[0].args).toContain('plugin:server');
    expect(provider.buildInteractiveCommand(spec)).toMatchObject({
      command: 'node.exe', args: expect.arrayContaining(['loader.js', '--session-id']),
    });
  });
  it('reports its id and lists configured models', async () => {
    const { spawner } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner,
      baseEnv: {},
    });
    expect(provider.id).toBe('copilot');
    expect(await provider.listModels()).toHaveLength(
      copilotDefaults.models.length,
    );
  });

  it('startSession spawns with the built command, env and cwd', () => {
    const { spawner, requests } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner,
      baseEnv: { PATH: '/bin' },
    });
    const session = provider.startSession(spec);
    expect(session.sessionId).toBe('sess-1');
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.command).toBe('copilot');
    expect(req.args).toContain('--session-id');
    expect(req.cwd).toBe('/work');
    expect(req.env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe('/tmp/u.jsonl');
    expect(req.env.PATH).toBe('/bin');
  });

  it('disables MCP servers for meta sessions using the live server-name source', () => {
    const { spawner, requests } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner,
      baseEnv: {},
      mcpServerNames: (session) => {
        expect(session.cwd).toBe('/work');
        return ['github', 'azure'];
      },
    });

    provider.startSession({ ...spec, kind: 'meta' });
    const req = requests[0];
    expect(req.args).toContain('--disable-builtin-mcps');
    expect(req.args).toEqual(
      expect.arrayContaining([
        '--disable-mcp-server',
        'github',
        '--disable-mcp-server',
        'azure',
      ]),
    );
  });

  it('uses native MCP configuration only when explicitly configured, while preserving text-only denial', () => {
    const { spawner, requests } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner, baseEnv: {}, mcpPolicy: 'native',
      mcpServerNames: () => { throw new Error('Native mode must not require an isolated inventory'); },
    });
    provider.startSession({ ...spec, kind: 'meta', noTools: true });
    expect(requests[0].input).toBe(spec.prompt);
    expect(requests[0].args).not.toContain(spec.prompt);
    expect(requests[0].args).not.toContain('-p');
    expect(requests[0].args).not.toContain('--disable-builtin-mcps');
    expect(requests[0].args.slice(requests[0].args.indexOf('--allow-all-tools'), requests[0].args.indexOf('--allow-all-tools') + 2))
      .toEqual(['--allow-all-tools', '--available-tools']);
    expect(requests[0].args).not.toContain('--deny-tool');
  });

  it('only evaluates workspace MCP policy for meta work and stamps the actual provider identity', () => {
    const { spawner, requests } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner, baseEnv: { STUDIO_PROVIDER_ID: 'wrong' },
      mcpServerNames: () => { throw new Error('Unverified overlay'); },
    });
    expect(() => provider.startSession(spec)).not.toThrow();
    expect(() => provider.startSession({ ...spec, kind: 'meta' })).toThrow('Unverified overlay');
    expect(requests[0].env.STUDIO_PROVIDER_ID).toBe('copilot');
    expect(provider.buildInteractiveCommand!(spec).env.STUDIO_PROVIDER_ID).toBe('copilot');
    expect(provider.mcp?.defaultConfigPath()).toMatch(/mcp-config\.json$/);
    const plain = createCopilotProvider(copilotDefaults, { spawner, baseEnv: {} });
    expect(() => plain.startSession({ ...spec, kind: 'meta' })).toThrow(/suppression cannot be verified/);
  });

  it('buildInteractiveCommand yields the interactive TUI command + OTel env', () => {
    const { spawner } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner,
      baseEnv: { PATH: '/bin' },
    });
    const ic = provider.buildInteractiveCommand(spec);
    expect(ic.command).toBe('copilot');
    expect(ic.args).toEqual([
      '--model',
      'gpt-5.4',
      '--session-id',
      'sess-1',
      '--allow-all-tools',
    ]);
    expect(ic.env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe('/tmp/u.jsonl');
    expect(ic.env.PATH).toBe('/bin');
  });

  it('createOutputScanner detects file ops the CLI announces in its output', () => {
    const { spawner } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner,
      baseEnv: {},
    });
    const scanner = provider.createOutputScanner?.({
      home: 'C:\\Users\\me',
      cwd: '/work',
    });
    expect(scanner?.feed('Created C:\\Users\\me\\a.md\n')).toEqual([
      { path: 'C:\\Users\\me\\a.md', tool: 'create' },
    ]);
  });

  it('createModelChangeScanner detects a mid-session model switch', () => {
    const { spawner } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner,
      baseEnv: {},
    });
    const scanner = provider.createModelChangeScanner?.();
    expect(scanner?.feed('Model changed from auto to claude-opus-4.8\n')).toEqual(
      ['claude-opus-4.8'],
    );
  });

  it('createMcpErrorScanner detects an MCP connection failure', () => {
    const { spawner } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner,
      baseEnv: {},
    });
    const scanner = provider.createMcpErrorScanner?.();
    expect(
      scanner?.feed('Failed to connect to MCP server "Azure": boom\n'),
    ).toEqual([{ server: 'Azure', reason: 'boom' }]);
  });

  it('createRestartScanner detects a CLI session-restart request', () => {
    const { spawner } = fakeSpawner();
    const provider = createCopilotProvider(copilotDefaults, {
      spawner,
      baseEnv: {},
    });
    const scanner = provider.createRestartScanner?.();
    expect(
      scanner?.feed('MCP server is modified, session needs to restart\n'),
    ).toEqual([{ reason: 'MCP server is modified' }]);
  });
});
