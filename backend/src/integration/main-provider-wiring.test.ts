import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../kernel/error-types.js';
import { headlessMcpServerNames } from '../mcp/mcp-server-names.js';
import { connectionDataUrl, parseAuthenticatedUser } from '../repo/azure-pr-lister.js';
import { parseAgencyVersion } from '../agency-bootstrap/agency-version.js';
import { agencyBootstrapConfigSchema, agencyBootstrapDefaults } from '../agency-bootstrap/config.js';
import { copilotBootstrapConfigSchema, copilotBootstrapDefaults } from '../copilot-bootstrap/config.js';
import type { IAIProvider, RunningSession, SessionSpec } from '../provider/provider-contract.js';

const source = ts.createSourceFile('main.ts',
  readFileSync(new URL('../main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true);

// Evaluate the actual composition-root closures with injected ports, without booting the app.
function binding<T>(name: string, deps: Record<string, unknown>): T {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!initializer) throw new Error(`Missing main wiring ${name}`);
  const code = ts.transpileModule(`(${initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return runInNewContext(code, {
    Buffer, AbortController, Error, setTimeout, clearTimeout, ...deps,
  }) as T;
}

function inventory(documents: Record<string, unknown> = {}, plugins: string[] = []) {
  const opened: string[] = [];
  const inspect = binding<(spec: Pick<SessionSpec, 'cwd' | 'kind' | 'noTools'>,
    providerId: string, signal: AbortSignal) => Promise<readonly string[]>>('prepareHeadlessMcpInventory', {
    AGENCY_NAMESPACE: 'agency', CLAUDE_NAMESPACE: 'claude', ValidationError,
    process: { platform: 'win32', env: { ProgramFiles: 'C:\\Programs' }, cwd: () => 'C:\\project\\child' },
    copilotHome: 'C:\\custom-home', homedir: () => 'C:\\home',
    pathJoin: win32.join, pathResolve: win32.resolve, dirname: win32.dirname,
    realpath: async (path: string) => path,
    headlessMcpServerNames,
    open: async (path: string) => {
      opened.push(path);
      if (!(path in documents)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const content = Buffer.from(JSON.stringify(documents[path]));
      return {
        stat: async () => ({ isFile: () => true, size: content.length }),
        // Deliberate short reads verify the complete bounded document is consumed.
        read: async (buffer: Buffer, offset: number, length: number, position: number) => ({
          bytesRead: content.copy(buffer, offset, position, position + Math.min(length, 7)),
        }),
        close: async () => {},
      };
    },
    opendir: async (path: string) => {
      if (!plugins.includes(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { read: async () => ({ name: 'plugin' }), close: async () => {} };
    },
  });
  return { inspect, opened };
}

afterEach(() => { vi.useRealTimers(); });

describe('main provider integration wiring', () => {
  it('uses the configured Agency executable without silently falling back to the standard installation', () => {
    const agencyInstallPaths = vi.fn(() => ['C:\\standard\\agency.exe']);
    const deps = {
      agencyConfig: { executable: 'custom-agency' },
      resolveExecutable: () => 'C:\\custom\\agency.exe',
      agencyInstallPaths, process: { platform: 'win32', env: {} }, homedir: () => '', listDir: vi.fn(),
    };
    expect(binding<() => string[]>('currentAgencyPaths', deps)()).toEqual(['C:\\custom\\agency.exe']);
    expect(agencyInstallPaths).not.toHaveBeenCalled();
    deps.agencyConfig.executable = 'agency';
    expect(binding<() => string[]>('currentAgencyPaths', deps)()).toEqual([
      'C:\\custom\\agency.exe', 'C:\\standard\\agency.exe',
    ]);
  });

  it('bounds async version probes and never invokes Windows batch shims', async () => {
    const end = vi.fn();
    const once = vi.fn();
    const trackProviderProbe = vi.fn();
    const execFile = vi.fn((_exe, _args, _options, callback) => {
      queueMicrotask(() => callback(null, '1.2.3', ''));
      return { stdin: { end }, once, kill: vi.fn() };
    });
    const readVersion = binding<(exe: string, args: string[], timeout: number) => Promise<string | null>>(
      'readInstalledCliVersion', {
        process: { platform: 'win32', env: {} }, execFile, parseAgencyVersion, trackProviderProbe,
      });
    expect(await readVersion('C:\\Program Files\\agency.exe', ['version', '--plain'], 3456)).toBe('1.2.3');
    expect(execFile).toHaveBeenCalledWith('C:\\Program Files\\agency.exe', ['version', '--plain'],
      expect.objectContaining({ timeout: 3456, maxBuffer: 65_536, shell: false, windowsHide: true, killSignal: 'SIGKILL' }),
      expect.any(Function));
    expect(trackProviderProbe).toHaveBeenCalledOnce();
    expect(once).toHaveBeenCalledWith('close', expect.any(Function));
    expect(end).toHaveBeenCalledOnce();
    expect(await readVersion('C:\\agency.cmd', ['--version'], 10)).toBeNull();
    expect(execFile).toHaveBeenCalledOnce();
  });

  it('passes each configured version argv and timeout to the bounded executor', async () => {
    const readInstalledCliVersion = vi.fn(async () => '1.2.3');
    const config = {
      agency: { ...agencyBootstrapDefaults, versionTimeoutMs: 4321 },
      copilot: { ...copilotBootstrapDefaults, versionTimeoutMs: 5432 },
    };
    const agency = binding<() => Promise<string | null>>('readAgencyVersion', {
      currentAgencyPaths: () => ['C:\\custom-agency.exe'],
      resolveAgencyExecutable: (paths: string[]) => paths[0], existsSync: () => true,
      agencyConfig: { commandProfile: { versionArgs: ['version', '--json'] } },
      agencyBootstrapConfigSchema, config, AGENCY_BOOTSTRAP_NAMESPACE: 'agency',
      readInstalledCliVersion,
    });
    const copilot = binding<() => Promise<string | null>>('readCopilotVersion', {
      resolveCopilotPath: () => 'C:\\custom-copilot.exe',
      copilotConfig: { executable: 'custom-copilot', commandProfile: { versionArgs: ['info', '--version'] } },
      copilotBootstrapConfigSchema, config, COPILOT_BOOTSTRAP_NAMESPACE: 'copilot',
      readInstalledCliVersion,
    });
    await Promise.all([agency(), copilot()]);
    expect(readInstalledCliVersion).toHaveBeenCalledWith('C:\\custom-agency.exe', ['version', '--json'], 4321);
    expect(readInstalledCliVersion).toHaveBeenCalledWith('C:\\custom-copilot.exe', ['info', '--version'], 5432);
  });

  it('inventories configured homes and every logical workspace ancestor, including disabled declarations', async () => {
    const { inspect, opened } = inventory({
      'C:\\custom-home\\mcp-config.json': { mcpServers: { custom: {} } },
      'C:\\home\\.copilot\\mcp-config.json': { mcpServers: { user: { enabled: false } } },
      'C:\\project\\child\\.mcp.json': { local: {} },
      'C:\\project\\.copilot\\mcp-config.json': { mcpServers: { ancestor: {} } },
      'C:\\.github\\mcp.json': { root: {} },
    });
    expect(await inspect({ cwd: 'C:\\project\\child', kind: 'meta' }, 'copilot', new AbortController().signal))
      .toEqual(['custom', 'user', 'local', 'ancestor', 'root']);
    expect(opened).toContain('C:\\project\\.copilot\\settings.local.json');
  });

  it('blocks unresolved plugin overlays, Agency injection and administrator-managed strict-profile conflicts', async () => {
    const signal = new AbortController().signal;
    const spec = { cwd: 'C:\\project\\child', kind: 'meta' as const };
    await expect(inventory({}, ['C:\\project\\.copilot\\plugins']).inspect(spec, 'copilot', signal))
      .rejects.toThrow('cannot be verified');
    await expect(inventory({
      'C:\\project\\.copilot\\settings.local.json': { enabledPlugins: { enterprise: true } },
    }).inspect(spec, 'copilot', signal)).rejects.toThrow('settings.local.json');
    await expect(inventory().inspect(spec, 'agency', signal)).rejects.toThrow('Agency native runtime defaults');
    await expect(inventory({
      'C:\\Programs\\ClaudeCode\\managed-mcp.json': { mcpServers: {} },
    }).inspect(spec, 'claude', signal)).rejects.toThrow('will not remove those flags or bypass policy');
  });

  it('gets the Azure viewer identity only from the authorized connectionData identity namespace', async () => {
    const azureHttpGet = vi.fn(async () => ({
      status: 200, body: { authenticatedUser: { id: 'viewer-guid' }, id: 'wrong-profile-id' },
    }));
    const viewer = binding<(org: string) => Promise<string | null>>('azureCommentViewerId', {
      azureTokenFor: async () => 'authorized-token', azureHttpGet, connectionDataUrl, parseAuthenticatedUser,
      logger: { warn: vi.fn() },
    });
    expect(await viewer('example')).toBe('viewer-guid');
    expect(azureHttpGet).toHaveBeenCalledWith(connectionDataUrl('example'), 'authorized-token');
    const unauthenticated = binding<(org: string) => Promise<string | null>>('azureCommentViewerId', {
      azureTokenFor: async () => null, azureHttpGet,
    });
    expect(await unauthenticated('example')).toBeNull();
    expect(azureHttpGet).toHaveBeenCalledOnce();
  });

  it('uses the same physical deduplication key for provider paths aliased through Windows links and casing', async () => {
    const canonicalCheckoutPath = binding<(path: string) => Promise<string>>('canonicalCheckoutPath', {
      realpath: async () => 'C:\\Shared\\MCP-Config.json',
    });
    const physical = binding<(path: string) => Promise<string>>('physicalMcpConfigPath', {
      pathResolve: win32.resolve, canonicalCheckoutPath, process: { platform: 'win32' },
    });
    expect(await physical('C:\\agency-junction\\mcp-config.json')).toBe('c:\\shared\\mcp-config.json');
    expect(await physical('C:\\COPILOT-LINK\\MCP-CONFIG.JSON')).toBe('c:\\shared\\mcp-config.json');
  });

  it('settles automation readiness on policy failure and timeout, never re-enabling after a late check', async () => {
    vi.useFakeTimers();
    const automationReadiness = new Map<string, { supported: boolean; reason: string | null }>();
    let complete!: () => void;
    const prepareHeadlessMcpInventory = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const refresh = binding<(providerId: string) => void>('refreshAutomationReadiness', {
      AGENCY_NAMESPACE: 'agency', CLAUDE_NAMESPACE: 'claude',
      automationReadiness, automationChecks: new Set<string>(),
      checkingAutomation: { supported: false, reason: 'checking' },
      mcpConfig: { discoveryTimeoutMs: 20 },
      prepareHeadlessMcpInventory, process: { env: {}, cwd: () => 'C:\\project' },
    });
    refresh('agency');
    expect(automationReadiness.get('agency')).toMatchObject({ supported: false, reason: expect.stringContaining('interactive-only') });
    expect(prepareHeadlessMcpInventory).not.toHaveBeenCalled();
    refresh('copilot');
    refresh('copilot');
    expect(prepareHeadlessMcpInventory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(21);
    expect(automationReadiness.get('copilot')).toMatchObject({ supported: false, reason: expect.stringContaining('timed out') });
    refresh('copilot');
    expect(prepareHeadlessMcpInventory).toHaveBeenCalledOnce();
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(automationReadiness.get('copilot')?.supported).toBe(false);
    refresh('copilot');
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(automationReadiness.get('copilot')).toEqual({ supported: true, reason: null });
  });

  it('does not spawn after preflight cancellation or acknowledge native cancellation before physical completion', async () => {
    let completeInventory!: (names: string[]) => void;
    let acknowledge!: (code: number | null) => void;
    const kill = vi.fn();
    const startSession = vi.fn(() => ({
      sessionId: 's', kill, onEvent: vi.fn(),
      done: new Promise<number | null>((resolve) => { acknowledge = resolve; }),
    }));
    const wrap = binding<(provider: IAIProvider) => IAIProvider>('withHeadlessMcpInventory', {
      CLAUDE_NAMESPACE: 'claude', mcpConfigPath: 'C:\\home\\mcp-config.json',
      mcpConfig: { discoveryTimeoutMs: 1000 }, headlessInventories: new WeakMap(),
      logger: { warn: vi.fn() },
      prepareHeadlessMcpInventory: () => new Promise<string[]>((resolve) => { completeInventory = resolve; }),
    });
    const wrapped = wrap({ id: 'copilot', startSession } as unknown as IAIProvider);
    const spec = { sessionId: 's', kind: 'meta' } as SessionSpec;
    const cancelled = wrapped.startSession(spec);
    cancelled.kill();
    expect(await cancelled.done).toBeNull();
    completeInventory([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(startSession).not.toHaveBeenCalled();
    const running: RunningSession = wrapped.startSession(spec);
    completeInventory([]);
    await Promise.resolve();
    expect(startSession).toHaveBeenCalledOnce();
    const completed = vi.fn();
    void running.done.then(completed);
    running.kill();
    await Promise.resolve();
    expect(kill).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    acknowledge(null);
    expect(await running.done).toBeNull();
  });
});
