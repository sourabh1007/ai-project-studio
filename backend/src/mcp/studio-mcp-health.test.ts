import { describe, expect, it, vi } from 'vitest';
import { createStudioMcpHealth, reconcileStudioMcpRegistrations } from './studio-mcp-health.js';
import { createMcpConfigWrites } from './mcp-config-writes.js';
import type { McpConfigDocument, McpToolInspection } from './mcp-contract.js';
import { mcpDefaults } from './config.js';

const current = {
  command: 'cmd.exe', args: ['/d', '/s', '/c', '"C:\\node.exe" studio-mcp-server.js'],
  env: { STUDIO_API_BASE: 'http://127.0.0.1:123/api/', STUDIO_CONTROL_TOKEN: 'secret', ELECTRON_RUN_AS_NODE: '1' },
};
const ok: McpToolInspection = { status: 'ok', message: null, output: [], tools: [{ name: 'list_automations', description: null }] };

function setup(document: McpConfigDocument | null = null) {
  const read = vi.fn(async () => structuredClone(document));
  const write = vi.fn(async (_path: string, _doc: McpConfigDocument) => undefined);
  const inspect = vi.fn(async () => ok);
  const hostGet = vi.fn(async (_url: string, _token: string, _timeout: number) => ({
    status: 200, body: { status: 'ok', server: 'ai-project-studio' } as unknown,
  }));
  const launch = vi.fn((): Record<string, unknown> | null => current);
  const health = createStudioMcpHealth({
    files: { read, write }, writes: createMcpConfigWrites(), registrationPaths: ['config.json'],
    tools: { inspect }, hostGet, launch, timeoutMs: 100,
  });
  return { health, read, write, inspect, hostGet, launch };
}

describe('explicit Studio MCP health and safe bounded self-healing', () => {
  it('startup reconciliation rewrites stale cmd-wrapper registrations with the current direct argv and port', async () => {
    const canonical = {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\app\\backend\\dist\\automation\\mcp\\studio-mcp-server.js'],
      env: { ELECTRON_RUN_AS_NODE: '1', STUDIO_API_BASE: 'http://127.0.0.1:49677/api', STUDIO_CONTROL_TOKEN: 'fresh' },
    };
    const stale = {
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Program Files\\nodejs\\node.exe" C:\\app\\backend\\dist\\automation\\mcp\\studio-mcp-server.js'],
      env: { ELECTRON_RUN_AS_NODE: '1', STUDIO_API_BASE: 'http://127.0.0.1:63043/api', STUDIO_CONTROL_TOKEN: 'stale' },
    };
    const document = { otherSetting: true, mcpServers: { azure: { command: 'azmcp' }, 'ai-project-studio': stale } };
    const read = vi.fn(async () => structuredClone(document));
    const write = vi.fn(async (_path: string, _doc: McpConfigDocument) => undefined);

    const attempts = await reconcileStudioMcpRegistrations({
      files: { read, write }, writes: createMcpConfigWrites(), registrationPaths: ['C:\\Users\\me\\.copilot\\mcp-config.json'],
    }, canonical);

    expect(attempts).toHaveLength(1);
    expect(write).toHaveBeenCalledWith('C:\\Users\\me\\.copilot\\mcp-config.json', {
      otherSetting: true,
      mcpServers: { azure: { command: 'azmcp' }, 'ai-project-studio': canonical },
    });
  });

  it('startup reconciliation creates missing app-owned registrations and skips already-current entries', async () => {
    const canonical = { command: 'node', args: ['studio-mcp-server.js'], env: { STUDIO_API_BASE: 'http://new', STUDIO_CONTROL_TOKEN: 'token' } };
    const firstWrite = vi.fn(async (_path: string, _doc: McpConfigDocument) => undefined);
    expect(await reconcileStudioMcpRegistrations({
      files: { read: vi.fn(async () => null), write: firstWrite },
      writes: createMcpConfigWrites(),
      registrationPaths: ['missing.json'],
    }, canonical)).toHaveLength(1);
    expect(firstWrite).toHaveBeenCalledWith('missing.json', { mcpServers: { 'ai-project-studio': canonical } });

    const currentWrite = vi.fn(async (_path: string, _doc: McpConfigDocument) => undefined);
    expect(await reconcileStudioMcpRegistrations({
      files: { read: vi.fn(async () => ({ mcpServers: { 'ai-project-studio': canonical } })), write: currentWrite },
      writes: createMcpConfigWrites(),
      registrationPaths: ['current.json'],
    }, canonical)).toEqual([]);
    expect(currentWrite).not.toHaveBeenCalled();
  });

  it('startup reconciliation refuses malformed mcpServers maps rather than deleting user data', async () => {
    await expect(reconcileStudioMcpRegistrations({
      files: { read: vi.fn(async () => ({ mcpServers: 'broken' }) as unknown as McpConfigDocument), write: vi.fn() },
      writes: createMcpConfigWrites(),
      registrationPaths: ['broken.json'],
    }, { command: 'node', args: [], env: {} })).rejects.toThrow('malformed');
  });

  it('gives cold startup three seconds per protocol attempt but aborts retained work at the eight-second total cap', async () => {
    vi.useFakeTimers();
    try {
      expect(mcpDefaults.studioProbeTimeoutMs).toBe(3000);
      const signals: AbortSignal[] = [];
      let attempt = 0;
      const health = createStudioMcpHealth({
        files: { read: async () => null, write: vi.fn() }, writes: createMcpConfigWrites(), registrationPaths: [],
        launch: () => current, timeoutMs: mcpDefaults.studioProbeTimeoutMs!,
        tools: { inspect: async ({ timeoutMs, signal }) => {
          expect(timeoutMs).toBe(3000);
          signals.push(signal!);
          await new Promise((resolve) => setTimeout(resolve, attempt++ === 0 ? 2800 : 2600));
          return attempt === 1 ? { ...ok, status: 'failed', message: 'cold startup' } : ok;
        } },
        hostGet: async () => ({ status: 200, body: { status: 'ok', server: 'ai-project-studio' } }),
      });
      const result = health();
      await vi.advanceTimersByTimeAsync(5400);
      expect((await result).status).toBe('connected');
      expect(signals).toHaveLength(2);

      let runningSignal: AbortSignal | undefined;
      const stalled = createStudioMcpHealth({
        files: { read: async () => null, write: vi.fn() }, writes: createMcpConfigWrites(), registrationPaths: [],
        launch: () => current, timeoutMs: mcpDefaults.studioProbeTimeoutMs!,
        tools: { inspect: async ({ signal }) => { runningSignal = signal; return new Promise(() => undefined); } },
        hostGet: vi.fn(),
      });
      const deadline = stalled();
      await vi.advanceTimersByTimeAsync(8000);
      expect(await deadline).toMatchObject({ status: 'error', message: expect.stringContaining('8000ms total deadline') });
      expect(runningSignal!.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('enforces an overall deadline and never queues recovery or writes after a stalled read', async () => {
    vi.useFakeTimers();
    try {
      const { health, read, write, inspect } = setup();
      let release!: (document: McpConfigDocument | null) => void;
      read.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      const first = health();
      await vi.advanceTimersByTimeAsync(1_400);
      expect(await first).toMatchObject({ status: 'error', message: expect.stringContaining('total deadline') });
      expect((await health()).message).toContain('already in progress');
      release({ mcpServers: { 'ai-project-studio': { ...current, command: 'stale' } } });
      await vi.advanceTimersByTimeAsync(0);
      expect(write).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      expect((await health()).status).toBe('connected');
    } finally { vi.useRealTimers(); }
  });
  it('verifies actual protocol plus authenticated current host without creating absent registrations', async () => {
    const { health, hostGet, inspect, write } = setup();
    const result = await health();
    expect(result.status).toBe('connected');
    expect(result.message).toContain('does not assert');
    expect(inspect).toHaveBeenCalledWith({ serverName: 'ai-project-studio', spec: current, timeoutMs: 100, signal: expect.any(AbortSignal) });
    expect(hostGet).toHaveBeenCalledWith('http://127.0.0.1:123/api/mcp/bridge-health', 'secret', 100);
    expect(write).not.toHaveBeenCalled();
  });

  it('recreates only recognized stale launch fields and preserves other entries/settings', async () => {
    const doc = {
      unrelated: { keep: true },
      mcpServers: {
        other: { command: 'untouched' },
        'ai-project-studio': { ...current, command: 'old', custom: 'keep',
          env: { ...current.env, STUDIO_API_BASE: 'http://old', STUDIO_CONTROL_TOKEN: 'old', KEEP: 'yes' } },
      },
    };
    const { health, write } = setup(doc);
    const result = await health();
    expect(result.status).toBe('connected');
    expect(result.healAttempts![0].action).toContain('Refreshed stale');
    expect(write).toHaveBeenCalledWith('config.json', {
      ...doc, mcpServers: { ...doc.mcpServers, 'ai-project-studio': { ...current, custom: 'keep', env: { ...current.env, KEEP: 'yes' } } },
    });
  });

  it.each([
    { ...current },
    { ...current, args: [...current.args, 'different'] },
    { ...current, env: { ...current.env, STUDIO_CONTROL_TOKEN: 'stale' } },
  ])('compares canonical command/args/environment accurately %j', async (stored) => {
    const { health, write } = setup({ mcpServers: { 'ai-project-studio': stored } });
    expect((await health()).status).toBe('connected');
    expect(write).toHaveBeenCalledTimes(JSON.stringify(stored) === JSON.stringify(current) ? 0 : 1);
  });

  it.each([
    null, {}, { command: 1 }, { command: 'node', args: 'wrong' },
    { command: 'node', args: [1, 'other.js'] },
    { command: 'node', args: ['studio-mcp-server.js'] },
    { command: 'node', args: ['studio-mcp-server.js'], env: [] },
    { command: 'node', args: ['studio-mcp-server.js'], env: { STUDIO_API_BASE: 'x' } },
  ])('never overwrites an unrecognized registration %j', async (stored) => {
    const { health, write, inspect } = setup({ mcpServers: { 'ai-project-studio': stored } });
    expect((await health()).message).toContain('could not be safely');
    expect(write).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('blocks failed configuration reads/writes without exposing details', async () => {
    const { health, read } = setup();
    read.mockRejectedValueOnce(new Error('secret contents'));
    expect(await health()).toMatchObject({ status: 'error' });
    const other = setup({ mcpServers: { 'ai-project-studio': { ...current, command: 'stale' } } });
    other.write.mockRejectedValueOnce(new Error('secret'));
    expect(JSON.stringify(await other.health())).not.toContain('secret');
  });

  it('retries one transient protocol failure and reports recovery without AI remediation', async () => {
    const { health, inspect, hostGet } = setup();
    inspect.mockResolvedValueOnce({ ...ok, status: 'failed', message: 'cold start', output: [] });
    const result = await health();
    expect(result.status).toBe('connected');
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(hostGet).toHaveBeenCalledTimes(1);
    expect(result.healAttempts!.map((step) => step.outcome)).toEqual(['failed', 'recovered']);
  });

  it('stops after two protocol failures and preserves redacted cause', async () => {
    const { health, inspect, hostGet } = setup();
    inspect.mockResolvedValue({ ...ok, status: 'failed', message: 'launch failed secret', output: ["'C:\\Program' not recognized"] });
    const result = await health();
    expect(result.status).toBe('error');
    expect(result.message).toContain("'C:\\Program'");
    expect(result.message).not.toContain('secret');
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(hostGet).not.toHaveBeenCalled();
  });

  it('reports empty diagnostics and unexpected tool inventory rather than declaring healthy', async () => {
    const { health, inspect } = setup();
    inspect.mockResolvedValueOnce({ ...ok, status: 'failed' }).mockResolvedValueOnce({ ...ok, tools: [] });
    const result = await health();
    expect(result.healAttempts![0].detail).toContain('without diagnostic output');
    expect(result.message).toContain('expected Studio bridge tools');
  });

  it.each([
    { status: 404, body: null }, { status: 401, body: null },
    { status: 200, body: null }, { status: 200, body: { status: 'bad' } },
    { status: 200, body: { status: 'ok', server: 'other' } },
  ])('fails closed on unverified host response %j', async (response) => {
    const { health, hostGet } = setup();
    hostGet.mockResolvedValue(response);
    const result = await health();
    expect(result.status).toBe('error');
    expect(result.message).toContain(`HTTP ${response.status}`);
    expect(hostGet).toHaveBeenCalledTimes(2);
  });

  it('bounds thrown launch/host errors and never echoes tokens', async () => {
    const { health, inspect, hostGet } = setup();
    inspect.mockRejectedValueOnce(new Error('secret'));
    hostGet.mockRejectedValueOnce(new Error('secret'));
    expect(await health()).toMatchObject({ status: 'error', message: 'Studio bridge launch or authenticated host request failed or timed out.' });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { env: { STUDIO_API_BASE: '' } }, { env: { STUDIO_API_BASE: 'x' } },
    { env: { STUDIO_API_BASE: 'x', STUDIO_CONTROL_TOKEN: '' } }])('blocks unready canonical launch %j', async (spec) => {
    const { health, launch, inspect } = setup();
    launch.mockReturnValue(spec);
    expect((await health()).status).toBe('error');
    expect(inspect).not.toHaveBeenCalled();
  });
});
