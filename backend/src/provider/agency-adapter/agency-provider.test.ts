import { describe, it, expect } from 'vitest';
import { createAgencyProvider } from './agency-provider.js';
import { agencyDefaults } from './config.js';
import type {
  ProcessHandle,
  ProcessSpawner,
  SpawnRequest,
} from '../process-kernel/process-spawner.js';
import type { SessionSpec, ImportableSession } from '../provider-contract.js';
import type { CliSessionStore } from '../cli-store/cli-session-store.js';

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

const importable: ImportableSession[] = [
  {
    externalId: 'ext-1',
    provider: 'agency',
    title: 'Past session',
    cwd: '/work',
    repository: 'org/repo',
    branch: 'main',
    model: 'gpt-5.4',
    messageCount: 3,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
  },
];

function fakeStore(): CliSessionStore {
  return { available: () => true, listImportable: () => importable };
}

const spec: SessionSpec = {
  sessionId: 'sess-1',
  featureId: 'feat-1',
  prompt: 'hello',
  model: 'claude-sonnet-4.5',
  kind: 'dev',
  otelFilePath: '/tmp/u.jsonl',
  cwd: '/work',
};

describe('agency-provider', () => {
  it('builds real persistent Agency ACP workers without bypassing native MCP or changing provider', () => {
    const { spawner } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner, baseEnv: { PATH: 'C:\\npm' }, importStore: fakeStore(),
      nativeCopilot: () => 'C:\\native\\copilot.exe',
    });
    expect(provider.capabilities?.warmTransport).toBe('acp');
    const command = provider.buildWarmCommand!({ ...spec, noTools: true }, [], ['do-not-suppress']);
    expect(command.args.slice(0, 3)).toEqual(['copilot', '--', '--acp']);
    expect(command.args).toContain('--available-tools');
    expect(command.args).not.toContain('--allow-all-tools');
    expect(command.args).not.toContain('--disable-builtin-mcps');
    expect(command.env.PATH).toBe('C:\\native;C:\\npm');
    expect(command.env.STUDIO_PROVIDER_ID).toBe('agency');
    const isolated = createAgencyProvider(agencyDefaults, { spawner, baseEnv: {}, importStore: fakeStore(), mcpPolicy: 'isolated' });
    expect(() => isolated.buildWarmCommand!(spec, [], [])).toThrow(/isolation/);
    const native = createAgencyProvider(agencyDefaults, { spawner, baseEnv: {}, importStore: fakeStore(), mcpPolicy: 'native' });
    expect(native.buildWarmCommand!({ ...spec, noTools: true }, [], []).env.STUDIO_PROVIDER_ID).toBe('agency');
  });
  it('resolves the native Copilot selection afresh for headless and interactive Agency launches', () => {
    const { spawner, requests } = fakeSpawner();
    let native = 'C:\\native-one\\copilot.exe';
    const provider = createAgencyProvider(agencyDefaults, {
      spawner, baseEnv: { PATH: 'C:\\npm' }, importStore: fakeStore(),
      nativeCopilot: () => native,
    });
    provider.startSession({ ...spec, kind: 'meta' });
    expect(requests[0].command).toBe('agency');
    expect(requests[0].env.PATH).toBe('C:\\native-one;C:\\npm');
    native = 'C:\\native-two\\copilot.exe';
    expect(provider.buildInteractiveCommand(spec).env.PATH).toBe('C:\\native-two;C:\\npm');
  });

  it('keeps strict zero-MCP isolation opt-in instead of blocking native Agency automation', () => {
    const { spawner, requests } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner, baseEnv: {}, importStore: fakeStore(),
      mcpPolicy: 'isolated',
    });
    expect(() => provider.startSession({ ...spec, kind: 'meta' })).toThrow(/Agency.*MCP/);
    expect(requests).toHaveLength(0);
    expect(() => provider.startSession(spec)).not.toThrow();
    expect(requests).toHaveLength(1);
  });

  it('reports its id and lists configured models', async () => {
    const { spawner } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: {},
      importStore: fakeStore(),
    });
    expect(provider.id).toBe('agency');
    expect(await provider.listModels()).toHaveLength(
      agencyDefaults.models.length,
    );
  });

  it('startSession spawns the agency passthrough with env and cwd', () => {
    const { spawner, requests } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: { PATH: '/bin' },
      importStore: fakeStore(),
    });
    const session = provider.startSession(spec);
    expect(session.sessionId).toBe('sess-1');
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.command).toBe('agency');
    expect(req.args.slice(0, 2)).toEqual(['copilot', '--']);
    expect(req.cwd).toBe('/work');
    expect(req.env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe('/tmp/u.jsonl');
    expect(req.env.PATH).toBe('/bin');
  });

  it('rejects unverified isolated meta launches without blocking normal native configuration', () => {
    const { spawner, requests } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: {},
      importStore: fakeStore(),
      mcpPolicy: 'isolated',
    });

    expect(() => provider.startSession({ ...spec, kind: 'meta' })).toThrow(/Agency.*MCP/);
    expect(requests).toHaveLength(0);
  });

  it('runs native meta sessions with text-only tool denial and preserves provider identity', () => {
    const { spawner, requests } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner, baseEnv: { STUDIO_PROVIDER_ID: 'wrong' }, importStore: fakeStore(),
      mcpPolicy: 'native',
    });
    expect(() => provider.startSession(spec)).not.toThrow();
    expect(() => provider.startSession({ ...spec, kind: 'meta', noTools: true })).not.toThrow();
    expect(requests[1].input).toBe(spec.prompt);
    expect(requests[1].args).not.toContain(spec.prompt);
    expect(requests[1].args).not.toContain('-p');
    expect(requests[1].args.slice(requests[1].args.indexOf('--allow-all-tools'), requests[1].args.indexOf('--allow-all-tools') + 2))
      .toEqual(['--allow-all-tools', '--available-tools']);
    expect(requests[1].args).not.toContain('--deny-tool');
    expect(requests[1].args).not.toContain('--disable-builtin-mcps');
    expect(requests[0].env.STUDIO_PROVIDER_ID).toBe('agency');
    expect(provider.buildInteractiveCommand!(spec).env.STUDIO_PROVIDER_ID).toBe('agency');
    const plain = createAgencyProvider(agencyDefaults, { spawner, baseEnv: {}, importStore: fakeStore() });
    expect(() => plain.startSession({ ...spec, kind: 'meta' })).not.toThrow();
  });

  it('buildInteractiveCommand wraps interactive args in the agency passthrough', () => {
    const { spawner } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: { PATH: '/bin' },
      importStore: fakeStore(),
    });
    const ic = provider.buildInteractiveCommand(spec);
    expect(ic.command).toBe('agency');
    expect(ic.args.slice(0, 2)).toEqual(['copilot', '--']);
    expect(ic.args).toContain('--model');
    expect(ic.args).toContain('claude-sonnet-4.5');
    expect(ic.args).not.toContain('-p');
    expect(ic.env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe('/tmp/u.jsonl');
    expect(ic.env.PATH).toBe('/bin');
  });

  it('lists importable sessions from the injected store', () => {
    const { spawner } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: {},
      importStore: fakeStore(),
    });
    expect(provider.listImportableSessions?.()).toEqual(importable);
  });

  it('createOutputScanner detects file ops via the reused Copilot scanner', () => {
    const { spawner } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: {},
      importStore: fakeStore(),
    });
    const scanner = provider.createOutputScanner?.({
      home: 'C:\\Users\\me',
      cwd: '/work',
    });
    expect(scanner?.feed('Created /work/a.md\n')).toEqual([
      { path: '/work/a.md', tool: 'create' },
    ]);
  });

  it('createModelChangeScanner detects a model switch via the reused Copilot scanner', () => {
    const { spawner } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: {},
      importStore: fakeStore(),
    });
    const scanner = provider.createModelChangeScanner?.();
    expect(scanner?.feed('Model changed to claude-opus-4.8\n')).toEqual([
      'claude-opus-4.8',
    ]);
  });

  it('createMcpErrorScanner detects an MCP failure via the reused Copilot scanner', () => {
    const { spawner } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: {},
      importStore: fakeStore(),
    });
    const scanner = provider.createMcpErrorScanner?.();
    expect(
      scanner?.feed('Failed to connect to MCP server "Azure": nope\n'),
    ).toEqual([{ server: 'Azure', reason: 'nope' }]);
  });

  it('createRestartScanner detects a restart request via the reused Copilot scanner', () => {
    const { spawner } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: {},
      importStore: fakeStore(),
    });
    const scanner = provider.createRestartScanner?.();
    expect(
      scanner?.feed('MCP server is modified, session needs to restart\n'),
    ).toEqual([{ reason: 'MCP server is modified' }]);
  });

  it('exposes Copilot MCP support', () => {
    const { spawner } = fakeSpawner();
    const provider = createAgencyProvider(agencyDefaults, {
      spawner,
      baseEnv: {},
      importStore: fakeStore(),
    });
    expect(provider.mcp).toBeDefined();
    expect(provider.mcp?.parseConfigPath('/h/.copilot/mcp-config.json')).toBe(
      '/h/.copilot/mcp-config.json',
    );
    expect(provider.mcp?.defaultConfigPath().endsWith('mcp-config.json')).toBe(
      true,
    );
  });
});
