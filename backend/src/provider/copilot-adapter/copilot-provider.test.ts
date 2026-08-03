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
});
