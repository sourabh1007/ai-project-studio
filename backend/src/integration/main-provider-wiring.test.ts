import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../kernel/error-types.js';
import { headlessMcpServerNames, nativeMcpServerNames } from '../mcp/mcp-server-names.js';
import { connectionDataUrl, parseAuthenticatedUser } from '../repo/azure-pr-lister.js';
import { parseAgencyVersion } from '../agency-bootstrap/agency-version.js';
import { agencyBootstrapConfigSchema, agencyBootstrapDefaults } from '../agency-bootstrap/config.js';
import { copilotBootstrapConfigSchema, copilotBootstrapDefaults } from '../copilot-bootstrap/config.js';
import { mcpDefaults } from '../mcp/config.js';
import type { HeadlessMcpPolicy, IAIProvider, RunningSession, SessionSpec } from '../provider/provider-contract.js';

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
    Buffer, AbortController, Error, Date, setTimeout, clearTimeout, ...deps,
  }) as T;
}

function inventory(documents: Record<string, unknown> = {}, plugins: string[] = [],
  headlessMcpPolicy: (id: string) => string = () => 'isolated') {
  const opened: string[] = [];
  const inspect = binding<(spec: Pick<SessionSpec, 'cwd' | 'kind' | 'noTools'>,
    providerId: string, signal: AbortSignal, policy?: HeadlessMcpPolicy) => Promise<readonly string[]>>('prepareHeadlessMcpInventory', {
    AGENCY_NAMESPACE: 'agency', CLAUDE_NAMESPACE: 'claude', COPILOT_NAMESPACE: 'copilot', ValidationError,
    headlessMcpPolicy,
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
  it('registers installed providers without probing before execution-policy initialization', () => {
    let registration: ts.ForOfStatement | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isForOfStatement(node) && node.expression.getText(source) === 'providerDescriptors') registration = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(registration).toBeDefined();
    const register = vi.fn();
    const probe = vi.fn(() => { throw new Error('Execution policy is not initialized yet'); });
    const provider = { id: 'claude' };
    const code = ts.transpileModule(registration!.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    runInNewContext(code, {
      providerDescriptors: [{ enabled: true, namespace: 'claude', defaultModel: 'auto', create: () => provider }],
      withHeadlessMcpInventory: (value: unknown) => value, providers: { register },
      enabledProviders: [], defaultModelByProvider: {}, refreshAutomationReadiness: probe,
    });
    expect(register).toHaveBeenCalledWith(provider);
    expect(probe).not.toHaveBeenCalled();
  });

  it('preserves native Agency/Claude startup while unknown providers remain isolated and cancellation still wins', async () => {
    const policy = binding<(id: string) => string>('headlessMcpPolicy', { mcpConfig: mcpDefaults });
    const { inspect, opened } = inventory({}, ['C:\\project\\.copilot\\plugins'], policy);
    const spec = { cwd: 'C:\\project', kind: 'meta' as const };
    const signal = new AbortController().signal;
    await expect(inspect(spec, 'agency', signal)).resolves.toEqual([]);
    await expect(inspect(spec, 'claude', signal)).resolves.toEqual([]);
    expect(opened).toEqual([]);
    await expect(inspect(spec, 'agency', signal, 'isolated')).rejects.toThrow('cannot be verified');
    await expect(inspect(spec, 'future-provider', signal)).rejects.toThrow('cannot be verified');
    const cancelled = new AbortController();
    cancelled.abort(new Error('Cancelled before native launch'));
    await expect(inspect(spec, 'agency', cancelled.signal)).rejects.toThrow('Cancelled before native launch');
  });

  it('passes native meta and no-tools sessions to the actual adapter without an isolation preflight', async () => {
    const prepareHeadlessMcpInventory = vi.fn();
    const kill = vi.fn();
    const running = { sessionId: 'native', kill, done: Promise.resolve(0), onEvent: vi.fn() };
    const startSession = vi.fn(() => running);
    const wrap = binding<(provider: IAIProvider) => IAIProvider>('withHeadlessMcpInventory', {
      headlessMcpPolicy: () => 'native', prepareHeadlessMcpInventory,
    });
    const spec = { sessionId: 'native', kind: 'meta', noTools: true } as SessionSpec;
    const session = wrap({ id: 'agency', startSession } as unknown as IAIProvider).startSession(spec);
    expect(startSession).toHaveBeenCalledWith(spec);
    expect(prepareHeadlessMcpInventory).not.toHaveBeenCalled();
    session.kill();
    expect(kill).toHaveBeenCalledOnce();
    expect(await session.done).toBe(0);
  });

  it('marks native Agency and verified native Claude ready without requiring app-owned API authentication', async () => {
    const automationReadiness = new Map();
    const prepareHeadlessMcpInventory = vi.fn().mockResolvedValue([]);
    const assertClaudeHeadlessAuth = vi.fn(() => { throw new Error('API/cloud credentials required in isolated mode'); });
    const deps = {
      AGENCY_NAMESPACE: 'agency', CLAUDE_NAMESPACE: 'claude', headlessMcpPolicy: () => 'native',
      automationReadiness, automationChecks: new Set(), automationCheckedAt: new Map(),
      checkingAutomation: { supported: false, state: 'checking', reason: 'Checking' },
      mcpConfig: { discoveryTimeoutMs: 1000, readinessCacheMs: 1000 },
      prepareHeadlessMcpInventory, process: { env: {}, cwd: () => 'C:\\project' },
      claudeBootstrapper: { status: () => ({ installed: true }) },
      executionPolicy: { get: () => ({ selectionRequired: false }) },
      resolverConfig: { defaultProvider: 'claude' },
      claudeVersion: { status: 'supported' }, claudeReadiness: null, claudeReadinessError: null,
      claudeAuthMethod: 'claude.ai', assertClaudeHeadlessAuth,
    };
    const refresh = binding<(id: string) => void>('refreshAutomationReadiness', deps);
    refresh('agency');
    refresh('claude');
    expect(automationReadiness.get('agency')).toMatchObject({ supported: true, state: 'ready' });
    expect(automationReadiness.get('claude')).toMatchObject({ supported: true, state: 'ready' });
    expect(prepareHeadlessMcpInventory).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(automationReadiness.get('agency')).toMatchObject({ supported: true, state: 'ready' });
    expect(automationReadiness.get('claude')).toMatchObject({ supported: true, state: 'ready' });
    expect(assertClaudeHeadlessAuth).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deps.automationChecks.size).toBe(0));
    automationReadiness.clear();
    deps.automationCheckedAt.clear();
    binding<(id: string) => void>('refreshAutomationReadiness', {
      ...deps, headlessMcpPolicy: () => 'isolated',
    })('claude');
    await vi.waitFor(() => expect(automationReadiness.get('claude')).toMatchObject({
      supported: false, state: 'blocked', reason: expect.stringContaining('API/cloud credentials required in isolated mode'),
    }));
  });

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
    expect(await inspect({ cwd: 'C:\\project\\child', kind: 'meta' }, 'legacy', new AbortController().signal))
      .toEqual(['custom', 'user', 'local', 'ancestor', 'root']);
    expect(opened).toContain('C:\\project\\.copilot\\settings.local.json');
  });

  it('blocks unresolved plugin overlays, Agency injection and administrator-managed strict-profile conflicts', async () => {
    const signal = new AbortController().signal;
    const spec = { cwd: 'C:\\project\\child', kind: 'meta' as const };
    await expect(inventory({}, ['C:\\project\\.copilot\\plugins']).inspect(spec, 'legacy', signal))
      .rejects.toThrow('cannot be verified');
    await expect(inventory({
      'C:\\project\\.copilot\\settings.local.json': { enabledPlugins: { enterprise: true } },
    }).inspect(spec, 'legacy', signal)).rejects.toThrow('settings.local.json');
    await expect(inventory().inspect(spec, 'agency', signal)).rejects.toThrow('Agency native runtime defaults');
    await expect(inventory({
      'C:\\Programs\\ClaudeCode\\managed-mcp.json': { mcpServers: {} },
    }).inspect(spec, 'claude', signal)).rejects.toThrow('will not remove those flags or bypass policy');
  });

  it('uses native Copilot inventory with bounded no-shell execution and releases admission on failure', async () => {
    const release = vi.fn();
    const acquireCold = vi.fn(async () => ({ release }));
    const end = vi.fn();
    const once = vi.fn();
    const trackProviderProbe = vi.fn();
    const execFile = vi.fn((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, '{"mcpServers":{"plugin-server":{},"disabled-server":{"enabled":false}}}'));
      return { stdin: { end }, once, kill: vi.fn() };
    });
    const inspect = binding<(spec: Pick<SessionSpec, 'cwd' | 'kind'>,
      providerId: string, signal: AbortSignal) => Promise<readonly string[]>>('prepareHeadlessMcpInventory', {
      AGENCY_NAMESPACE: 'agency', COPILOT_NAMESPACE: 'copilot', ValidationError,
      headlessMcpPolicy: () => 'isolated',
      processAdmission: { acquireCold }, copilotConfig: { executable: 'custom-copilot' },
      mcpConfig: { discoveryTimeoutMs: 2345, headlessInventoryMaxBytes: 123456 },
      process: { env: {}, cwd: () => 'C:\\fallback' },
      resolveCopilotNativeCommand: ({ command, args }: { command: string; args: string[] }) => ({ command, args }),
      execFile, nativeMcpServerNames, trackProviderProbe,
    });
    const signal = new AbortController().signal;
    expect(await inspect({ cwd: 'C:\\workspace', kind: 'meta' }, 'copilot', signal))
      .toEqual(['plugin-server', 'disabled-server']);
    expect(acquireCold).toHaveBeenCalledWith(signal);
    expect(execFile).toHaveBeenCalledWith('custom-copilot', ['mcp', 'list', '--json'],
      expect.objectContaining({ cwd: 'C:\\workspace', signal, timeout: 2345, maxBuffer: 123456, shell: false }),
      expect.any(Function));
    expect(end).toHaveBeenCalledOnce();
    expect(trackProviderProbe).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    execFile.mockImplementationOnce((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error('private configuration detail'), ''));
      return { stdin: { end }, once, kill: vi.fn() };
    });
    await expect(inspect({ kind: 'meta' }, 'copilot', signal)).rejects.toThrow('No automated session was launched');
    expect(release).toHaveBeenCalledTimes(2);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(inspect({ kind: 'meta' }, 'copilot', cancelled.signal)).rejects.toThrow();
    expect(execFile).toHaveBeenCalledTimes(2);
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
      headlessMcpPolicy: () => 'isolated',
      automationReadiness, automationChecks: new Set<string>(), automationCheckedAt: new Map<string, number>(),
      checkingAutomation: { supported: false, reason: 'checking' },
      mcpConfig: { discoveryTimeoutMs: 20, readinessCacheMs: 1000 },
      prepareHeadlessMcpInventory, process: { env: {}, cwd: () => 'C:\\project' },
    });
    refresh('agency');
    expect(automationReadiness.get('agency')).toMatchObject({
      supported: false, state: 'blocked',
      reason: expect.stringContaining('selected isolated policy'),
    });
    expect(prepareHeadlessMcpInventory).not.toHaveBeenCalled();
    automationReadiness.set('copilot', { supported: true, reason: null });
    refresh('copilot');
    expect(automationReadiness.get('copilot')).toMatchObject({ supported: false, reason: 'checking' });
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
    expect(prepareHeadlessMcpInventory).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1001);
    refresh('copilot');
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(automationReadiness.get('copilot')).toEqual({ supported: true, state: 'ready', reason: null });
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
      headlessMcpPolicy: () => 'isolated',
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

  it('does not call missing or dormant Claude unsupported, or claim readiness before native verification', () => {
    const automationReadiness = new Map<string, { supported: boolean; reason: string | null; state: string }>();
    let installed = false;
    let selected = false;
    const claudeVersion = { status: 'unknown' };
    const refreshClaudeReadiness = vi.fn();
    const prepareHeadlessMcpInventory = vi.fn();
    const deps = {
      AGENCY_NAMESPACE: 'agency', CLAUDE_NAMESPACE: 'claude',
      automationReadiness, automationChecks: new Set<string>(), automationCheckedAt: new Map<string, number>(),
      checkingAutomation: { supported: false, state: 'checking', reason: 'Checking' },
      mcpConfig: { discoveryTimeoutMs: 20, readinessCacheMs: 1000 },
      claudeBootstrapper: { status: () => ({ installed }) },
      executionPolicy: { get: () => ({ selectionRequired: !selected }) },
      resolverConfig: { get defaultProvider() { return selected ? 'claude' : 'copilot'; } },
      claudeVersion, claudeReadiness: null, claudeReadinessError: null,
      refreshClaudeReadiness, prepareHeadlessMcpInventory,
    };
    const refresh = binding<(providerId: string) => void>('refreshAutomationReadiness', deps);
    refresh('claude');
    expect(automationReadiness.get('claude')).toMatchObject({
      supported: false, state: 'blocked', reason: expect.stringContaining('Install Claude Code'),
    });
    installed = true;
    refresh('claude');
    expect(automationReadiness.get('claude')?.reason).toContain('Select Claude Code');
    expect(refreshClaudeReadiness).not.toHaveBeenCalled();
    selected = true;
    refresh('claude');
    expect(automationReadiness.get('claude')?.state).toBe('checking');
    expect(refreshClaudeReadiness).toHaveBeenCalledOnce();
    expect(prepareHeadlessMcpInventory).not.toHaveBeenCalled();
    binding<(providerId: string) => void>('refreshAutomationReadiness', {
      ...deps, claudeReadinessError: 'Update the unsupported native version',
    })('claude');
    expect(automationReadiness.get('claude')?.reason).toBe('Update the unsupported native version');
  });
});
