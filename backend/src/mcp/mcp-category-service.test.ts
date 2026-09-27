import { describe, expect, it, vi } from 'vitest';
import { createMcpCategories, type McpCategoryPaths } from './mcp-categories.js';
import { createMcpCategoryService, type McpCategoryServiceDeps } from './mcp-category-service.js';
import type { McpConfigDocument, McpConfigFileStore, McpToolInspection, McpToolInspector } from './mcp-contract.js';
import type { McpServerStatus } from './mcp-contract.js';
import { createAgencyMcpCatalog } from './agency-mcp-catalog.js';
import { createMcpAuthenticationJobs } from './mcp-authentication-jobs.js';

const paths = {
  copilot: 'copilot.json', claude: 'claude.json', workspace: 'workspace',
  workspaceMcp: 'workspace.mcp.json', agencyNative: 'agency-native',
};
const good: McpToolInspection = {
  status: 'ok', message: null, output: ['never expose subprocess output'],
  tools: [{ name: 'read', description: 'Read' }, { name: 'write', description: null }],
};

function setup(initial: Record<string, McpConfigDocument> = {}, pathOverrides: Partial<McpCategoryPaths> = {}, studioProbe?: () => Promise<McpServerStatus>, overrides: Partial<McpCategoryServiceDeps> = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const files: McpConfigFileStore = {
    read: vi.fn(async (path) => structuredClone(data.get(path) ?? null)),
    write: vi.fn(async (path, value) => { data.set(path, structuredClone(value)); }),
  };
  const categories = createMcpCategories(files, files, { ...paths, ...pathOverrides });
  const inspect = vi.fn(async (_input: Parameters<McpToolInspector['inspect']>[0]) => good);
  let enabled = true;
  const service = createMcpCategoryService({
    categories, enabled: () => enabled, tools: { inspect },
    probeTimeoutMs: 100, maxConcurrentProbes: 1,
    now: () => new Date('2026-09-27T00:00:00Z'), maxAuthObservations: 200,
    studio: { name: 'ai-project-studio', spec: { command: 'node', args: ['studio.js'] },
      tools: [{ name: 'create_monitor', description: 'Create', enabled: true }], probe: studioProbe },
    ...overrides,
  });
  return { service, files, data, inspect, categories, disable: () => { enabled = false; } };
}

describe('MCP categories and observational reads', () => {
  it('exposes canonical app inventory on inherited cards without launching their stored command', async () => {
    const probe = vi.fn(async (): Promise<McpServerStatus> => ({
      name: 'ai-project-studio', status: 'error', toolCount: 0, authRequired: false, authUrl: null, message: 'real failure',
    }));
    const s = setup({ 'copilot.json': { mcpServers: { 'ai-project-studio': { command: 'broken-shell', args: ['never-launch'] } } } }, {}, probe);
    for (const [provider, name] of [['agency', 'copilot-user:ai-project-studio'], ['copilot', 'user:ai-project-studio']]) {
      const entry = (await s.service.getServers(provider)).servers.find((item) => item.name === name)!;
      expect(entry.capabilities!.tools.supported).toBe(true);
      expect(entry.capabilities!.edit.supported).toBe(false);
      expect(await s.service.inspectServer(provider, name)).toMatchObject({
        name, tools: [{ name: 'create_monitor' }], toolDiscovery: { status: 'skipped' },
      });
      expect((await s.service.serverStatus(provider, name)).message).toBe('real failure');
    }
    expect(s.inspect).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
  });
  function withSetup(initial: Record<string, McpConfigDocument> = {}, overrides: Partial<McpCategoryServiceDeps> = {}) {
    const s = setup(initial, {}, undefined, overrides);
    const catalog = createAgencyMcpCatalog({
      run: async () => ({ code: 0, stdout: 'Available MCPs:\n  ado\n  kusto' }),
    }, ['ado', 'kusto'].map((name) => ({ name, description: name, instruction: name })));
    const configure = vi.fn(async (name: string, args: string) => {
      s.data.set('global', { mcps: { builtins: { [name]: { enabled: false, organization: args } } } });
      s.data.set('agency-native', { mcps: { builtins: { [name]: { enabled: false, organization: args } } } });
    });
    s.categories[0] = createMcpCategories(s.files, s.files, paths, catalog, {
      source: 'global', store: s.files, manager: { configure },
    })[0];
    return { ...s, configure };
  }

  function nativeSetup(withJobs = true, timeout = true) {
    const jobs = createMcpAuthenticationJobs({ id: () => 'job', now: () => 0, timeoutMs: 5000, maxConcurrent: 1, maxRetained: 20 });
    const declaration = { mcps: { builtins: { ado: { organization: 'org', type: 'ado' } } } };
    const s = withSetup({ 'agency-native': declaration, global: declaration }, {
      ...(withJobs ? { authenticationJobs: jobs } : {}),
      ...(timeout ? { authenticationTimeoutMs: 5000 } : {}),
    });
    const resolve = vi.fn((_name: string, _spec: Record<string, unknown>): ReturnType<NonNullable<typeof s.categories[0]['builtinRuntime']>['resolve']> =>
      ({ supported: true, launch: { command: 'fixture-native.exe', args: ['mcp', 'ado', '--organization', 'org'] } }));
    s.categories[0].builtinRuntime = { resolve };
    return { ...s, jobs, resolve };
  }

  it('returns cached suggestions for catalog, configured builtin and canonical aliases without probing', async () => {
    const s = nativeSetup();
    const result = { command: 'agency config set --global --mcp', options: [], examples: [], cachedAt: null, stale: false };
    const get = vi.fn(async (_name: string) => result);
    s.categories[0].options = { get };
    expect(await s.service.getServerOptions!('agency', 'global-builtins:ado')).toEqual(result);
    expect(get).toHaveBeenLastCalledWith('ado');
    expect(await s.service.getServerOptions!('agency', 'catalog:kusto')).toEqual(result);
    expect(get).toHaveBeenLastCalledWith('kusto');
    s.data.set('agency-native', { mcps: { builtins: { alias: { type: 'ado' } }, servers: { custom: { command: 'x' } } } });
    expect(await s.service.getServerOptions!('agency', 'native-builtins:alias')).toEqual(result);
    expect(get).toHaveBeenLastCalledWith('ado');
    expect((await s.service.getServerOptions!('agency', 'native:custom')).message).toContain('only for Agency');
    expect((await s.service.getServerOptions!('studio', 'ai-project-studio')).message).toContain('only for Agency');
    expect(s.inspect).not.toHaveBeenCalled();
    expect(s.files.write).not.toHaveBeenCalled();
    s.jobs.close();
  });

  it('allows explicit default-options catalog inspection only with readable native sources and never configures it', async () => {
    const s = nativeSetup();
    const catalog = (await s.service.getServers('agency')).servers.find((entry) => entry.name === 'catalog:kusto')!;
    expect(catalog.capabilities!.tools).toMatchObject({ supported: true, reason: expect.stringContaining('default-options') });
    s.resolve.mockClear();
    const inspected = await s.service.inspectServer('agency', 'catalog:kusto');
    expect(s.resolve).toHaveBeenCalledWith('kusto', {});
    expect(inspected.catalog).toBe(true);
    expect(s.files.write).not.toHaveBeenCalled();
    s.data.set('global', { mcps: { builtins: [] } });
    expect((await s.service.getServers('agency')).servers.find((entry) => entry.name === 'catalog:kusto')!.capabilities!.tools.supported).toBe(false);
    s.data.delete('global');
    s.data.set('agency-native', { mcps: { builtins: [] } });
    expect((await s.service.getServers('agency')).servers.find((entry) => entry.name === 'catalog:kusto')!.capabilities!.tools.supported).toBe(false);
    s.jobs.close();
  });

  it('publishes redacted actual argv and observed auth state while retaining unknown state for changed configuration', async () => {
    const s = nativeSetup();
    s.resolve.mockReturnValue({ supported: true, canonicalName: 'ado', launch: { command: 'C:\\Program Files\\agency.exe', args: ['mcp', 'ado', '--organization', 'org'] } });
    let entry = (await s.service.getServers('agency')).servers.find((item) => item.name === 'global-builtins:ado')!;
    expect(entry.commandPreview).toBe('"C:\\Program Files\\agency.exe" mcp ado --organization org');
    expect(entry.authState).toMatchObject({ state: 'unknown', checkedAt: null });
    s.inspect.mockResolvedValueOnce({ status: 'failed', message: 'Access token has expired', tools: [], output: ['private-token'] });
    entry = await s.service.inspectServer('agency', 'global-builtins:ado');
    expect(entry.authState).toMatchObject({ state: 'expired', checkedAt: '2026-09-27T00:00:00.000Z' });
    expect(entry.authentication!.supported).toBe(true);
    entry.authState!.message = 'external mutation';
    const refreshed = (await s.service.getServers('agency')).servers.find((item) => item.name === 'global-builtins:ado')!;
    expect(refreshed.authState!.message).not.toBe('external mutation');
    expect(refreshed.authentication!.supported).toBe(true);
    const changed = { mcps: { builtins: { ado: { type: 'ado', organization: 'different' } } } };
    s.data.set('global', changed);
    s.data.set('agency-native', changed);
    expect((await s.service.getServers('agency')).servers.find((item) => item.builtinName === 'ado')!.authState!.state).toBe('unknown');
    s.jobs.close();
  });

  it('reuses observations across equivalent canonical alias configurations while keeping distinct profiles separate', async () => {
    const s = nativeSetup();
    const declaration = { mcps: { builtins: {
      ado: { type: 'ado', organization: 'org' }, alias: { organization: 'org', type: 'ado' },
      different: { type: 'ado', organization: 'different' },
    } } };
    s.data.set('global', declaration);
    s.data.set('agency-native', declaration);
    s.resolve.mockReturnValue({ supported: true, canonicalName: 'ado', launch: { command: 'agency.exe', args: ['mcp', 'ado'] } });
    await s.service.inspectServer('agency', 'global-builtins:ado');
    const config = await s.service.getServers('agency');
    expect(config.servers.find((entry) => entry.builtinName === 'alias')!.authState!.state).toBe('ready');
    expect(config.servers.find((entry) => entry.builtinName === 'different')!.authState!.state).toBe('unknown');
    s.jobs.close();
  });

  it('bounds the observation cache and does not reuse evicted state', async () => {
    const s = withSetup({ 'agency-native': { mcps: { builtins: { ado: {}, kusto: {} } } } }, { maxAuthObservations: 1 });
    s.categories[0].builtinRuntime = { resolve: (name) => ({ supported: true, launch: { command: 'agency.exe', args: ['mcp', name] } }) };
    await s.service.inspectServer('agency', 'native-builtins:ado');
    await s.service.inspectServer('agency', 'native-builtins:kusto');
    const config = await s.service.getServers('agency');
    expect(config.servers.find((entry) => entry.builtinName === 'ado')!.authState!.state).toBe('unknown');
    expect(config.servers.find((entry) => entry.builtinName === 'kusto')!.authState!.state).toBe('ready');
  });

  it('enriches configured builtins from installed public catalog descriptions without rewriting native specs or custom aliases', async () => {
    const declaration = {
      mcps: {
        builtins: { ado: { organization: 'org' }, alias: { type: 'ado', organization: 'other' }, unlisted: true, invalid: null },
        servers: { ado: { command: 'custom' } },
      },
    };
    const s = withSetup({ 'agency-native': declaration, global: declaration });
    const config = await s.service.getServers('agency');
    const ado = config.servers.find((entry) => entry.name === 'global-builtins:ado')!;
    const alias = config.servers.find((entry) => entry.name === 'global-builtins:alias')!;
    expect(ado.description).toBe('ado');
    expect(alias.description).toBe('ado');
    expect(ado.spec).toEqual({ organization: 'org' });
    expect(alias.spec).toEqual({ type: 'ado', organization: 'other' });
    expect(ado.configurationSources!.every((source) => source.spec.description === undefined)).toBe(true);
    expect(config.servers.find((entry) => entry.name === 'catalog:kusto')!.description).toBe('kusto');
    expect(config.servers.find((entry) => entry.name === 'native:ado')!.description).toBeUndefined();
    expect(config.servers.find((entry) => entry.builtinName === 'unlisted')!.description).toBeUndefined();
    expect(s.files.write).not.toHaveBeenCalled();
    expect(s.data.get('global')).toEqual(declaration);
  });

  it('enables native inventory only for installed, valid, enabled declarations and launches verified argv only on explicit inspection', async () => {
    const s = nativeSetup(false);
    const config = await s.service.getServers('agency');
    expect(config.servers.find((entry) => entry.builtinName === 'ado')!.capabilities!.tools.supported).toBe(true);
    expect(s.inspect).not.toHaveBeenCalled();
    const result = await s.service.inspectServer('agency', 'global-builtins:ado');
    expect(s.inspect).toHaveBeenCalledWith({
      serverName: 'ado', spec: { command: 'fixture-native.exe', args: ['mcp', 'ado', '--organization', 'org'] }, timeoutMs: 100,
    });
    expect(result.tools).toEqual(good.tools.map((tool) => ({ ...tool, enabled: true })));
    expect(result.authentication).toMatchObject({ supported: false, reason: expect.stringContaining('not available') });
    expect(result.toolDiscovery!.message).toContain('Authorization for individual tool calls has not been verified');
    expect(result.capabilities!.toolToggle.supported).toBe(false);
    s.jobs.close();
  });

  it('keeps unsupported options, disabled/uninstalled builtins and invalid declarations fail-closed', async () => {
    const s = nativeSetup();
    s.data.set('agency-native', { mcps: { builtins: { ado: {}, kusto: false, uninstalled: true, bad: null } } });
    s.data.delete('global');
    s.resolve.mockReturnValue({ supported: false, reason: 'Configured options cannot be preserved safely.' });
    const config = await s.service.getServers('agency');
    expect(config.servers.find((entry) => entry.builtinName === 'ado')!.capabilities!.tools.reason).toContain('cannot be preserved');
    expect(config.servers.find((entry) => entry.builtinName === 'kusto')!.capabilities!.tools.reason).toContain('disabled');
    expect(config.servers.find((entry) => entry.builtinName === 'uninstalled')!.capabilities!.tools.reason).toContain('not in the installed');
    expect(config.servers.find((entry) => entry.displayName === 'bad')!.builtinName).toBeUndefined();
    expect(config.servers.find((entry) => entry.displayName === 'bad')!.capabilities!.tools.supported).toBe(false);
    await expect(s.service.inspectServer('agency', 'native-builtins:ado')).rejects.toThrow(/cannot be preserved/);
    expect(s.inspect).not.toHaveBeenCalled();
    s.jobs.close();
  });

  it('rechecks runtime safety immediately before native launch', async () => {
    const s = nativeSetup();
    s.resolve.mockReturnValueOnce({ supported: true, launch: {} }).mockReturnValueOnce({ supported: true, launch: {} })
      .mockReturnValue({ supported: false, reason: 'Runtime changed' });
    await expect(s.service.inspectServer('agency', 'global-builtins:ado')).rejects.toThrow(/Runtime changed/);
    expect(s.inspect).not.toHaveBeenCalled();
    s.jobs.close();
  });

  it('uses a verified public canonical type for explicit aliases without merging different aliases', async () => {
    const s = nativeSetup();
    const declaration = { mcps: { builtins: { 'team-one': { type: 'ado' }, 'team-two': { type: 'ado' } } } };
    s.data.set('global', declaration);
    s.data.set('agency-native', declaration);
    s.resolve.mockReturnValue({ supported: true, canonicalName: 'ado', launch: { command: 'fixture-native.exe' } });
    const config = await s.service.getServers('agency');
    const aliases = config.servers.filter((entry) => entry.name.startsWith('global-builtins:'));
    expect(aliases.map((entry) => entry.builtinName)).toEqual(['team-one', 'team-two']);
    expect(aliases.every((entry) => entry.capabilities!.tools.supported)).toBe(true);
    expect(config.servers.some((entry) => entry.name === 'catalog:ado')).toBe(true);
    s.jobs.close();
  });

  it('rechecks binding before authentication and never authenticates a raw custom server', async () => {
    const s = nativeSetup();
    s.inspect.mockResolvedValue({ status: 'failed', message: 'Unauthorized', output: [], tools: [] });
    await s.service.inspectServer('agency', 'global-builtins:ado');
    s.resolve.mockReturnValueOnce({ supported: true, launch: {} }).mockReturnValueOnce({ supported: true, launch: {} })
      .mockReturnValueOnce({ supported: true, launch: {} })
      .mockReturnValueOnce({ supported: false, reason: 'Native binding changed' });
    await expect(s.service.startAuthentication!('agency', 'global-builtins:ado')).rejects.toThrow(/binding changed/);
    s.data.set('agency-native', { mcps: { servers: { custom: { command: 'custom' } } } });
    await expect(s.service.startAuthentication!('agency', 'native:custom')).rejects.toThrow(/explicit native tools check/);
    s.jobs.close();
  });

  it('allows explicit long connection before a challenge and after a timeout without inventing an authentication requirement', async () => {
    const s = nativeSetup();
    const initial = (await s.service.getServers('agency')).servers.find((entry) => entry.name === 'global-builtins:ado')!;
    expect(initial.authState!.state).toBe('unknown');
    expect(initial.authentication!.supported).toBe(true);
    s.inspect.mockImplementationOnce(async () => new Promise(() => undefined));
    const first = await s.service.startAuthentication!('agency', 'global-builtins:ado');
    expect(first.status).toBe('pending');
    await s.service.cancelAuthentication!('agency', 'global-builtins:ado', first.id);
    await expect(s.service.startAuthentication!('copilot', 'user:other')).rejects.toThrow(/not supported/);
    s.inspect.mockResolvedValue({ status: 'failed', message: 'Timed out', output: [], tools: [] });
    const result = await s.service.inspectServer('agency', 'global-builtins:ado');
    expect(result.authentication!.supported).toBe(true);
    expect(result.authState!.state).toBe('unknown');
    expect(result.toolDiscovery!.authRequired).toBe(false);
    const second = await s.service.startAuthentication!('agency', 'global-builtins:ado');
    expect(second.status).toBe('pending');
    s.jobs.close();
  });

  it('disables long connection after successful inventory without asserting universal authorization', async () => {
    const s = nativeSetup();
    await s.service.inspectServer('agency', 'global-builtins:ado');
    const entry = (await s.service.getServers('agency')).servers.find((item) => item.name === 'global-builtins:ado')!;
    expect(entry.authentication!.supported).toBe(false);
    await expect(s.service.startAuthentication!('agency', 'global-builtins:ado')).rejects.toThrow(/already succeeded/);
    s.jobs.close();
  });

  it('does not offer unknown-state authentication for an unverified global-only declaration', async () => {
    const s = nativeSetup();
    s.data.delete('agency-native');
    const entry = (await s.service.getServers('agency')).servers.find((item) => item.name === 'global-builtins:ado')!;
    expect(entry.capabilities!.tools.supported).toBe(false);
    expect(entry.authentication!.supported).toBe(false);
    await expect(s.service.startAuthentication!('agency', entry.name)).rejects.toThrow(/verified resolved/);
    s.jobs.close();
  });

  it('retains explicit native authentication while pending, polls without inventory reads and returns tool inventory on completion', async () => {
    const s = nativeSetup();
    s.inspect.mockResolvedValueOnce({ status: 'failed', message: 'Authentication required', output: ['private diagnostics'], authUrl: 'https://example.test/token', tools: [] });
    const observed = await s.service.inspectServer('agency', 'global-builtins:ado');
    expect(observed).toMatchObject({ authentication: { supported: true }, toolDiscovery: { authRequired: true, authUrl: null, output: [] } });
    let complete!: (result: McpToolInspection) => void;
    s.inspect.mockImplementationOnce(async (input) => {
      input.onProgress!(['To sign in, open https://microsoft.com/devicelogin and enter the code ABCD12345']);
      return new Promise((resolve) => { complete = resolve; });
    });
    const job = await s.service.startAuthentication!('agency', 'global-builtins:ado');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    expect(s.inspect.mock.calls.at(-1)![0].timeoutMs).toBe(5000);
    s.files.read = vi.fn();
    expect(await s.service.authenticationStatus!('agency', 'global-builtins:ado', job.id))
      .toMatchObject({ status: 'pending', authUrl: 'https://microsoft.com/devicelogin', deviceCode: 'ABCD12345' });
    expect(s.files.read).not.toHaveBeenCalled();
    await expect(s.service.authenticationStatus!('copilot', 'global-builtins:ado', job.id)).rejects.toThrow(/unavailable/);
    complete(good);
    await vi.waitFor(async () => expect((await s.service.authenticationStatus!('agency', 'global-builtins:ado', job.id)).status).toBe('completed'));
    const completed = await s.service.authenticationStatus!('agency', 'global-builtins:ado', job.id);
    expect(completed.authUrl).toBeNull();
    expect(completed.server!.tools).toHaveLength(2);
    expect(completed.server!.authentication!.supported).toBe(false);
    s.jobs.close();
  });

  it('uses unknown state for changed native configuration and blocks missing authentication-job support', async () => {
    const s = nativeSetup();
    s.inspect.mockResolvedValue({ status: 'failed', message: 'Unauthorized', output: [], tools: [] });
    await s.service.inspectServer('agency', 'global-builtins:ado');
    const changed = { mcps: { builtins: { ado: { organization: 'different' } } } };
    s.data.set('global', changed);
    s.data.set('agency-native', changed);
    const changedEntry = (await s.service.getServers('agency')).servers.find((entry) => entry.builtinName === 'ado')!;
    expect(changedEntry.authState!.state).toBe('unknown');
    const job = await s.service.startAuthentication!('agency', 'global-builtins:ado');
    expect(job.status).toBe('pending');
    const missing = nativeSetup(false);
    await expect(missing.service.startAuthentication!('agency', 'global-builtins:ado')).rejects.toThrow(/not supported/);
    await expect(missing.service.authenticationStatus!('agency', 'global-builtins:ado', 'x')).rejects.toThrow(/not supported/);
    await expect(missing.service.cancelAuthentication!('agency', 'global-builtins:ado', 'x')).rejects.toThrow(/not supported/);
    s.jobs.close();
    missing.jobs.close();
  });

  it('cancels active native authentication, ignores stale completion and uses the probe-timeout fallback when not configured', async () => {
    const s = nativeSetup(true, false);
    s.inspect.mockResolvedValueOnce({ status: 'failed', message: 'Unauthorized', output: [], tools: [] });
    await s.service.inspectServer('agency', 'global-builtins:ado');
    let complete!: (result: McpToolInspection) => void;
    s.inspect.mockImplementationOnce(async () => new Promise((resolve) => { complete = resolve; }));
    const job = await s.service.startAuthentication!('agency', 'global-builtins:ado');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    expect(s.inspect.mock.calls.at(-1)![0].timeoutMs).toBe(100);
    expect(await s.service.cancelAuthentication!('agency', 'global-builtins:ado', job.id)).toMatchObject({ status: 'cancelled', authUrl: null });
    expect(s.inspect.mock.calls.at(-1)![0].signal!.aborted).toBe(true);
    complete(good);
    await Promise.resolve();
    expect((await s.service.serverStatus('agency', 'global-builtins:ado')).authRequired).toBe(true);
    s.jobs.close();
  });

  it('offers catalog setup, reloads persisted global state, and uses explicit global native editing only', async () => {
    const s = withSetup();
    const available = (await s.service.getServers('agency')).servers.find((entry) => entry.name === 'catalog:ado')!;
    expect(available).toMatchObject({ origin: 'agency-built-in', builtinName: 'ado', capabilities: { add: { supported: true } } });
    const saved = await s.service.configureBuiltin!('agency', 'catalog:ado', { arguments: '--organization mine' });
    expect(s.configure).toHaveBeenCalledOnce();
    expect(s.configure).toHaveBeenCalledWith('ado', '--organization mine', 'add');
    expect(saved.servers.find((entry) => entry.name === 'global-builtins:ado')).toMatchObject({
      enabled: false, origin: 'agency-built-in', providerLabel: 'Agency', builtinName: 'ado',
      spec: { organization: '--organization mine' }, capabilities: { edit: { supported: true }, toggle: { supported: false } },
    });
    expect(saved.servers.some((entry) => entry.name === 'catalog:ado')).toBe(false);
    expect(saved.notices!.join(' ')).toContain('Existing sessions were not reloaded');
    await s.service.configureBuiltin!('agency', 'global-builtins:ado', { arguments: '--organization changed' });
    expect(s.configure).toHaveBeenLastCalledWith('ado', '--organization changed', 'edit');
    await expect(s.service.putServer('agency', { name: 'global-builtins:ado', spec: {} })).rejects.toThrow(/dedicated built-in setup/);
    expect(s.files.write).not.toHaveBeenCalled();
    expect(s.inspect).not.toHaveBeenCalled();
  });

  it('fails closed for invalid global sources and unsupported installed builtin edits', async () => {
    const s = withSetup({ global: { mcps: { builtins: [] } } });
    const available = (await s.service.getServers('agency')).servers.find((entry) => entry.name === 'catalog:ado')!;
    expect(available.capabilities!.add.supported).toBe(false);
    expect(available.capabilities!.add.reason).toContain('Global Agency configuration is unavailable or invalid');
    expect(available.capabilities!.add.reason).not.toContain('Configure in your terminal');
    await expect(s.service.configureBuiltin!('agency', 'catalog:ado', { arguments: '' })).rejects.toThrow(/Global Agency configuration/);
    s.data.set('global', { mcps: { builtins: { undocumented: true } } });
    await expect(s.service.configureBuiltin!('agency', 'global-builtins:undocumented', { arguments: '' })).rejects.toThrow(/not been confirmed/);
    expect(s.configure).not.toHaveBeenCalled();
  });

  it('never leaks supported setup capabilities between shared catalog reads with different source availability', async () => {
    const s = withSetup();
    const catalog = await s.categories[0].catalog!();
    s.categories[0].catalog = async () => catalog;
    expect((await s.service.getServers('agency')).servers[0].capabilities!.add.supported).toBe(true);
    expect(catalog.servers[0].capabilities!.add.supported).toBe(false);
    s.data.set('global', { mcps: { builtins: [] } });
    expect((await s.service.getServers('agency')).servers[0].capabilities!.add.supported).toBe(false);
  });

  it('blocks wrong categories, missing names, custom and resolved/inherited entries', async () => {
    const s = withSetup({
      'agency-native': { mcps: { builtins: { ado: true }, servers: { custom: { command: 'server' } } } },
    });
    await expect(s.service.configureBuiltin!('copilot', 'catalog:ado', { arguments: '' })).rejects.toThrow(/not supported/);
    await expect(s.service.configureBuiltin!('absent', 'catalog:ado', { arguments: '' })).rejects.toThrow(/Unknown/);
    await expect(s.service.configureBuiltin!('agency', 'catalog:missing', { arguments: '' })).rejects.toThrow(/unavailable/);
    await expect(s.service.configureBuiltin!('agency', 'native:custom', { arguments: '' })).rejects.toThrow(/Only an available/);
    await expect(s.service.configureBuiltin!('agency', 'native-builtins:ado', { arguments: '' })).rejects.toThrow(/Only an available/);
    expect(s.configure).not.toHaveBeenCalled();
  });

  it('does not return a configured result after failed setup', async () => {
    const s = withSetup();
    s.configure.mockRejectedValue(new Error('Native setup failed'));
    await expect(s.service.configureBuiltin!('agency', 'catalog:ado', { arguments: '' })).rejects.toThrow(/failed/);
    expect(s.configure).toHaveBeenCalledOnce();
    expect(s.data.has('global')).toBe(false);
  });

  it('renders configured builtins once across resolved/global scopes without dropping a same-name custom server', async () => {
    const native = { mcps: { builtins: { ado: { organization: 'org', type: 'ado' }, kusto: true }, servers: { ado: { command: 'custom' } } } };
    const global = { mcps: { builtins: { ado: { type: 'ado', organization: 'org' }, kusto: { enabled: true } } } };
    const s = withSetup({ 'agency-native': native, global });
    const config = await s.service.getServers('agency');
    expect(config.servers.map((entry) => entry.name)).toEqual(['native:ado', 'global-builtins:ado', 'global-builtins:kusto']);
    for (const entry of config.servers.filter((entry) => entry.origin === 'agency-built-in')) {
      expect(entry.configurationConflict).toBe(false);
      expect(entry.configurationSources!.map((source) => source.kind)).toEqual(['resolved', 'global']);
      expect(entry.capabilities!.edit.supported).toBe(true);
    }
  });

  it('retains overriding resolved settings in one card and blocks stale/global action ids', async () => {
    const s = withSetup({
      'agency-native': { mcps: { builtins: { ado: { organization: 'workspace' } } } },
      global: { mcps: { builtins: { ado: { organization: 'global' } } } },
    });
    const config = await s.service.getServers('agency');
    const cards = config.servers.filter((entry) => entry.builtinName === 'ado');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      name: 'native-builtins:ado', spec: { organization: 'workspace' }, configurationConflict: true,
      capabilities: { edit: { supported: false } },
    });
    expect(cards[0].configurationSources![1].spec).toEqual({ organization: 'global' });
    await expect(s.service.configureBuiltin!('agency', 'global-builtins:ado', { arguments: '' })).rejects.toThrow(/unavailable/);
    await expect(s.service.configureBuiltin!('agency', 'native-builtins:ado', { arguments: '' })).rejects.toThrow(/Only an available/);
    expect(s.configure).not.toHaveBeenCalled();
  });

  it('classifies app ownership, builtins and custom registrations independently of client category', async () => {
    const app = { command: 'node', args: ['studio.js'] };
    const s = withSetup({
      'agency-native': { mcps: { builtins: { ado: true, 'ai-project-studio': true }, servers: { custom: { command: 'native' } } } },
      'copilot.json': { mcpServers: { 'ai-project-studio': app, another: { command: 'server' } } },
      'claude.json': { mcpServers: { 'ai-project-studio': app, another: { command: 'server' } } },
    });
    for (const category of ['agency', 'copilot', 'claude', 'studio']) {
      const config = await s.service.getServers(category);
      for (const entry of config.servers.filter((entry) => entry.displayName === 'ai-project-studio' || category === 'studio')) {
        expect(entry).toMatchObject({ origin: 'app', providerLabel: 'This app' });
        expect(entry.builtinName).toBeUndefined();
      }
      for (const entry of config.servers.filter((entry) => ['custom', 'another'].includes(entry.displayName!))) {
        expect(entry).toMatchObject({ origin: 'custom', providerLabel: 'Custom' });
        expect(entry.builtinName).toBeUndefined();
      }
    }
    const agency = await s.service.getServers('agency');
    expect(agency.servers.find((entry) => entry.name === 'native-builtins:ado')).toMatchObject({
      origin: 'agency-built-in', providerLabel: 'Agency', builtinName: 'ado',
    });
  });

  it('shows installed catalog cards with no mcps config while keeping all catalog actions blocked', async () => {
    const { service, categories, files, inspect } = setup();
    categories[0].catalog = createAgencyMcpCatalog({
      run: async () => ({ code: 0, stdout: 'Available MCPs:\n  public-one' }),
    }, [{ name: 'public-one', description: 'Public fixture', instruction: 'Use native configuration help.' }]);
    const config = await service.getServers('agency');
    expect(config.exists).toBe(false);
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]).toMatchObject({ name: 'catalog:public-one', catalog: true, providerLabel: 'Agency' });
    expect(config.servers[0]).not.toHaveProperty('enabled');
    expect(config.notices!.join(' ')).toContain('Availability does not mean configured');
    await expect(service.putServer('agency', { name: 'catalog:public-one', spec: {} })).rejects.toThrow(/not configured or connected/);
    await expect(service.removeServer!('agency', 'catalog:public-one')).rejects.toThrow(/not configured or connected/);
    await expect(service.setServerEnabled!('agency', 'catalog:public-one', true)).rejects.toThrow(/not configured or connected/);
    await expect(service.setToolEnabled('agency', { serverName: 'catalog:public-one', toolName: 'x', enabled: true })).rejects.toThrow(/not configured or connected/);
    await expect(service.inspectServer('agency', 'catalog:public-one')).rejects.toThrow(/not configured or connected/);
    await expect(service.restartServer('agency', 'catalog:public-one')).rejects.toThrow(/not configured or connected/);
    expect((await service.serverStatus('agency', 'catalog:public-one')).status).toBe('unsupported');
    expect(files.write).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('deduplicates only exact configured built-ins, not arbitrary raw servers sharing a catalog name', async () => {
    const { service, categories } = setup({
      'agency-native': { mcps: { servers: { 'public-two': { command: 'raw' } }, builtins: { 'public-one': false } } },
    });
    categories[0].catalog = createAgencyMcpCatalog({
      run: async () => ({ code: 0, stdout: 'Available MCPs:\n  public-one\n  public-two' }),
    }, ['public-one', 'public-two'].map((name) => ({ name, description: 'Public fixture', instruction: 'Use native help.' })));
    const config = await service.getServers('agency');
    expect(config.servers.map((entry) => entry.name)).toEqual(['native:public-two', 'native-builtins:public-one', 'catalog:public-two']);
    expect(config.servers.find((entry) => entry.name === 'native-builtins:public-one')!.enabled).toBe(false);
  });
  it('always enumerates all categories without reads or probes', () => {
    const { service, files, inspect } = setup();
    expect(service.listProviders().map((p) => p.id)).toEqual(['agency', 'copilot', 'claude', 'studio']);
    expect(service.listProviders().every((p) => p.label && p.capabilities)).toBe(true);
    expect(files.read).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('shows missing files without inventing installation state or mutating anything', async () => {
    const { service, files, inspect } = setup();
    const config = await service.getServers('agency');
    expect(config.exists).toBe(false);
    expect(config.servers).toEqual([]);
    expect(config.notices!.join(' ')).toContain('does not exist');
    expect(config.notices!.join(' ')).toContain('native mcps configuration key is not configured');
    expect(files.write).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(files.read).toHaveBeenCalledTimes(3);
  });

  it('separates duplicate names and source scopes; reads nested Claude configuration', async () => {
    const { service } = setup({
      'claude.json': { mcpServers: { same: { command: 'user' } }, projects: { workspace: { mcpServers: { same: { command: 'local' } } } } },
      'workspace.mcp.json': { mcpServers: { same: { command: 'project' } } },
    });
    const config = await service.getServers('claude');
    expect(config.servers.map((s) => s.name)).toEqual(['user:same', 'local:same', 'project:same']);
    expect(config.servers.map((s) => s.spec.command)).toEqual(['user', 'local', 'project']);
    expect(config.servers.every((s) => s.displayName === 'same' && s.source && s.scope)).toBe(true);
  });

  it('handles invalid or unavailable source without replacing it or exposing read errors', async () => {
    const { service, files } = setup({
      'claude.json': { projects: { workspace: { mcpServers: [] } } },
    });
    const partial = await service.getServers('claude');
    expect(partial.notices!.join(' ')).toContain('unavailable or invalid');
    expect(partial.capabilities!.add.supported).toBe(true);
    vi.mocked(files.read).mockRejectedValue(new Error('secret token'));
    const bad = await service.getServers('claude');
    expect(bad.capabilities!.add.supported).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('secret token');
    expect(files.write).not.toHaveBeenCalled();
  });

  it('marks invalid specs and inherited sources read-only; handles Agency booleans', async () => {
    const { service } = setup({
      'agency-native': { mcps: { servers: { invalid: null, agencyOnly: { command: 'native-server' } }, builtins: { yes: true, no: false, obj: { enabled: true, tools: ['read'] } } } },
      'copilot.json': { mcpServers: { inherited: { command: 'node' } } },
    });
    const config = await service.getServers('agency');
    expect(config.servers.find((s) => s.displayName === 'invalid')!.capabilities!.edit.supported).toBe(false);
    expect(config.servers.find((s) => s.displayName === 'no')!.enabled).toBe(false);
    expect(config.servers.find((s) => s.displayName === 'yes')!.enabled).toBe(true);
    const inherited = config.servers.find((s) => s.displayName === 'inherited')!;
    expect(inherited.capabilities!.edit.supported).toBe(false);
    expect(inherited.capabilities!.tools.supported).toBe(true);
    const native = config.servers.find((s) => s.displayName === 'agencyOnly')!;
    expect(native).toMatchObject({ name: 'native:agencyOnly', source: 'agency-native', spec: { command: 'native-server' } });
    expect(native.scope).toContain('resolved native');
    expect(native.capabilities!.edit.supported).toBe(false);
  });

  it('never reveals app control tokens in category copies of its owned server', async () => {
    const { service } = setup({
      'copilot.json': { mcpServers: { 'ai-project-studio': { command: 'node', env: { STUDIO_CONTROL_TOKEN: 'secret' } } } },
    });
    expect(JSON.stringify(await service.getServers('copilot'))).not.toContain('secret');
    expect((await service.getServers('studio')).servers[0].tools).toHaveLength(1);
    expect((await service.inspectServer('studio', 'ai-project-studio')).toolDiscovery!.message).toContain('no connection probe');
    await expect(service.putServer('studio', { name: 'ai-project-studio', spec: {} })).rejects.toThrow(/app lifecycle/);
    await expect(service.restartServer('studio', 'ai-project-studio')).rejects.toThrow(/app lifecycle/);
    await expect(service.putServer('copilot', { name: 'ai-project-studio', spec: {} })).rejects.toThrow(/app lifecycle/);
  });

  it('rejects unavailable categories and disabled management', async () => {
    const { service, disable } = setup();
    await expect(service.getServers('nope')).rejects.toThrow(/Unknown MCP category/);
    await expect(service.inspectServer('copilot', 'user:missing')).rejects.toThrow(/unavailable/);
    disable();
    await expect(service.getServers('copilot')).rejects.toThrow(/disabled/);
  });
});

describe('app proxy boundaries', () => {
  it('checks copied app-owned entries using canonical health without changing their opaque ID', async () => {
    const probe = vi.fn(async (): Promise<McpServerStatus> => ({
      name: 'ai-project-studio', status: 'connected', toolCount: 6, authRequired: false, authUrl: null, message: 'verified',
    }));
    const { service } = setup({ 'copilot.json': { mcpServers: { 'ai-project-studio': { command: 'stale' } } } }, {}, probe);
    expect(await service.serverStatus('copilot', 'user:ai-project-studio')).toMatchObject({ name: 'user:ai-project-studio', status: 'connected' });
    expect(probe).toHaveBeenCalledTimes(1);
  });
  it('keeps static inventory distinct from explicit bounded Studio health probes', async () => {
    let release!: (status: McpServerStatus) => void;
    const probe = vi.fn(() => new Promise<McpServerStatus>((resolve) => { release = resolve; }));
    const { service } = setup({}, {}, probe);
    expect((await service.getServers('studio')).servers[0].toolDiscovery!.status).toBe('skipped');
    await service.inspectServer('studio', 'ai-project-studio');
    expect(probe).not.toHaveBeenCalled();
    const first = service.serverStatus('studio', 'ai-project-studio');
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    await expect(service.serverStatus('studio', 'ai-project-studio')).rejects.toThrow(/capacity/);
    release({ name: 'ai-project-studio', status: 'error', toolCount: 0, authRequired: false, authUrl: null, message: 'real launch error' });
    expect(await first).toMatchObject({ status: 'error', message: 'real launch error' });
    probe.mockRejectedValueOnce(new Error('host unavailable'));
    await expect(service.serverStatus('studio', 'ai-project-studio')).rejects.toThrow('host unavailable');
  });
  it('edits the original native allow-list rather than ineffective proxy fields', async () => {
    const original = { command: 'node', tools: ['*'], extra: 'keep' };
    const { service, data } = setup({ 'copilot.json': { mcpServers: {
      proxy: { command: 'proxy', env: { STUDIO_MCP_ORIGINAL: JSON.stringify(original), STUDIO_CONTROL_TOKEN: 'private' } },
    } } });
    const config = await service.getServers('copilot');
    expect(config.servers[0].spec).toEqual(original);
    await service.inspectServer('copilot', 'user:proxy');
    await service.setToolEnabled('copilot', { serverName: 'user:proxy', toolName: 'write', enabled: false });
    expect(data.get('copilot.json')!.mcpServers!.proxy).toEqual({ ...original, tools: ['read'] });
  });

  it('redacts lifecycle credentials even in malformed wrappers and blocks their use', async () => {
    const { service } = setup({ 'copilot.json': { mcpServers: {
      proxy: { command: 'proxy', env: { STUDIO_MCP_ORIGINAL: 'broken', STUDIO_CONTROL_TOKEN: 'private', keep: 'yes' } },
    } } });
    const config = await service.getServers('copilot');
    expect(JSON.stringify(config.servers[0].spec)).not.toContain('private');
    expect((config.servers[0].spec.env as Record<string, string>).keep).toBe('yes');
    await expect(service.inspectServer('copilot', 'user:proxy')).rejects.toThrow(/private lifecycle credentials/);
  });
});

describe('workspace, policy and native-only controls', () => {
  it('lists both wrapped and bare Copilot workspace sources without asserting precedence or trust', async () => {
    const { service } = setup({
      'workspace.mcp.json': { a: { command: 'bare' } },
      'github.mcp.json': { mcpServers: { a: { command: 'wrapped' } } },
    }, { workspaceGithubMcp: 'github.mcp.json' });
    const config = await service.getServers('copilot');
    expect(config.servers.map((entry) => entry.name)).toEqual(['workspace:a', 'github-workspace:a']);
    expect(config.servers.map((entry) => entry.spec.command)).toEqual(['bare', 'wrapped']);
    expect(config.servers.every((entry) => entry.enabled === true)).toBe(true);
    expect(config.notices!.join(' ')).toContain('trust');
    await expect(service.putServer('copilot', { name: 'workspace:a', spec: {} })).rejects.toThrow(/native trust/);
  });

  it('suppresses ordinary Claude sources and mutations when exclusive managed config exists', async () => {
    const { service, files } = setup({
      'claude.json': { mcpServers: { ordinary: { command: 'node' } } },
      'managed.json': { mcpServers: { managed: { command: 'node' } } },
    }, { claudeManaged: 'managed.json' });
    const config = await service.getServers('claude');
    expect(config.servers.map((entry) => entry.name)).toEqual(['managed:managed']);
    expect(config.configPath).toBe('managed.json');
    expect(config.capabilities!.add.supported).toBe(false);
    await expect(service.putServer('claude', { name: 'new', spec: {} })).rejects.toThrow(/administrator-owned/);
    await expect(service.removeServer!('claude', 'user:ordinary')).rejects.toThrow(/unavailable/);
    await expect(service.removeServer!('claude', 'managed:managed')).rejects.toThrow(/administrator-owned/);
    expect(files.write).not.toHaveBeenCalled();
    expect((await service.inspectServer('claude', 'managed:managed')).tools).toHaveLength(2);
  });

  it('uses ordinary Claude sources when managed config is absent but blocks when unreadable', async () => {
    const { service, files } = setup({
      'claude.json': { mcpServers: { a: { command: 'node' } } },
    }, { claudeManaged: 'managed.json' });
    expect((await service.getServers('claude')).servers.map((entry) => entry.name)).toEqual(['user:a']);
    vi.mocked(files.read).mockRejectedValue(new Error('Permission denied with secret'));
    const blocked = await service.getServers('claude');
    expect(blocked.servers).toEqual([]);
    expect(blocked.capabilities!.add.supported).toBe(false);
    expect(blocked.notices![0]).toContain('policy is verified');
    expect(JSON.stringify(blocked)).not.toContain('secret');
  });

  it('does not guess a relocated Claude config path', async () => {
    const { service, files } = setup({}, { claudeUnavailableReason: 'CLAUDE_CONFIG_DIR relocation is unverified.' });
    expect(service.listProviders().find((entry) => entry.id === 'claude')!.capabilities!.add.supported).toBe(false);
    expect((await service.getServers('claude')).notices).toEqual(['CLAUDE_CONFIG_DIR relocation is unverified.']);
    await expect(service.putServer('claude', { name: 'x', spec: {} })).rejects.toThrow(/unverified/);
    expect(files.read).not.toHaveBeenCalled();
    expect(files.write).not.toHaveBeenCalled();
  });

  it('directs Claude reconnect and tool permission management to the native session', async () => {
    const { service, inspect } = setup({ 'claude.json': { mcpServers: { a: { command: 'node' } } } });
    await expect(service.restartServer('claude', 'user:a')).rejects.toThrow(/Claude \/mcp/);
    await expect(service.setServerEnabled!('claude', 'user:a', false)).rejects.toThrow(/does not invent spec.enabled/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('reads Claude native project disabled names instead of spec.enabled', async () => {
    const { service, inspect } = setup({
      'claude.json': {
        mcpServers: { disabled: { command: 'node' }, allowed: { command: 'node', enabled: false } },
        projects: { workspace: { disabledMcpServers: ['disabled'] } },
      },
      'workspace.mcp.json': { mcpServers: { disabled: { command: 'shared' } } },
    });
    const config = await service.getServers('claude');
    expect(config.servers.find((entry) => entry.name === 'user:allowed')!.enabled).toBe(true);
    expect(config.servers.filter((entry) => entry.displayName === 'disabled').every((entry) => entry.enabled === false)).toBe(true);
    await expect(service.inspectServer('claude', 'user:disabled')).rejects.toThrow(/native project settings/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    { projects: 42 },
    { projects: { workspace: { disabledMcpServers: 'bad' } } },
    { projects: { workspace: { disabledMcpServers: [42] } } },
  ])('does not invent enabled state when native disabled-name settings are malformed %j', async (document) => {
    const { service, files } = setup({ 'claude.json': document });
    const config = await service.getServers('claude');
    expect(config.servers).toEqual([]);
    expect(config.capabilities!.add.supported).toBe(false);
    expect(config.notices![0]).toContain('disabled-server settings');
    expect(files.write).not.toHaveBeenCalled();
  });
});

describe('native scoped mutations', () => {
  it('adds, edits and removes while preserving all unrelated fields and scopes', async () => {
    const { service, data } = setup({
      'claude.json': { preferences: { secret: 1 }, projects: { workspace: { trusted: true, mcpServers: { a: { command: 'old' } } }, other: { keep: true } } },
    });
    await service.putServer('claude', { name: 'new', spec: { command: 'node', custom: true } });
    await service.putServer('claude', { name: 'local:a', spec: { command: 'edited' } });
    expect(data.get('claude.json')).toEqual({
      preferences: { secret: 1 }, mcpServers: { new: { command: 'node', custom: true } },
      projects: { workspace: { trusted: true, mcpServers: { a: { command: 'edited' } } }, other: { keep: true } },
    });
    await service.removeServer!('claude', 'local:a');
    expect((await service.getServers('claude')).servers.map((s) => s.name)).toEqual(['user:new']);
  });

  it.each(['', 'bad/name', '__proto__', 'constructor', 'prototype', 'has space'])('rejects unsafe new name %s', async (name) => {
    const { service, files } = setup();
    await expect(service.putServer('copilot', { name, spec: {} })).rejects.toThrow(/server name/);
    expect(files.write).not.toHaveBeenCalled();
  });

  it('rejects malformed specs, unsupported keys, duplicate names, missing IDs and corrupted maps', async () => {
    const { service, data } = setup({ 'copilot.json': { mcpServers: { a: { command: 'a' } } } });
    await expect(service.putServer('copilot', { name: 'a', spec: {} })).rejects.toThrow(/already exists/);
    await expect(service.putServer('copilot', { name: 'x', spec: null! })).rejects.toThrow(/JSON object/);
    await expect(service.putServer('claude', { name: 'x', spec: { tools: ['*'] } })).rejects.toThrow(/'tools'/);
    await expect(service.putServer('claude', { name: 'x', spec: { enabled: false } })).rejects.toThrow(/'enabled'/);
    await expect(service.putServer('copilot', { name: 'no-source:a', spec: {} })).rejects.toThrow(/unavailable/);
    data.set('copilot.json', { mcpServers: [] as never });
    await expect(service.putServer('copilot', { name: 'new', spec: {} })).rejects.toThrow(/unavailable or invalid/);
  });

  it('enforces native read-only capabilities; explicit writable typed sources can toggle', async () => {
    const { service, data, categories, files } = setup({
      'agency-native': { mcps: { builtins: { yes: true, obj: { tools: ['read'], enabled: true } } } },
      'copilot.json': { mcpServers: { a: { command: 'a' } } },
    });
    await expect(service.putServer('agency', { name: 'copilot-user:a', spec: {} })).rejects.toThrow(/Inherited/);
    await expect(service.removeServer!('agency', 'native-builtins:yes')).rejects.toThrow(/unset/);
    await expect(service.setServerEnabled!('copilot', 'user:a', false)).rejects.toThrow(/copilot mcp enable/);
    await expect(service.setServerEnabled!('agency', 'native-builtins:yes', 1 as never)).rejects.toThrow(/boolean/);
    await expect(service.setServerEnabled!('agency', 'native-builtins:yes', false)).rejects.toThrow(/TOML/);
    await expect(service.putServer('agency', { name: 'new', spec: { command: 'node' } })).rejects.toThrow(/TOML/);
    expect(files.write).not.toHaveBeenCalled();
    // Exercise the generic adapter contract with a deliberately writable fixture.
    delete categories[0].sources[1].readOnlyReason;
    await service.setServerEnabled!('agency', 'native-builtins:yes', false);
    await service.setServerEnabled!('agency', 'native-builtins:obj', false);
    expect(data.get('agency-native')).toEqual({ mcps: { builtins: { yes: { enabled: false }, obj: { tools: ['read'], enabled: false } } } });
  });

  it('honors configured add restrictions and defaults on custom sources', async () => {
    const { service, categories } = setup();
    categories[1].sources[0].readOnlyReason = 'Managed';
    await expect(service.putServer('copilot', { name: 'x', spec: {} })).rejects.toThrow('Managed');
    delete categories[1].sources[0].readOnlyReason;
    categories[1].sources[0].builtin = true;
    expect(service.listProviders()[1].capabilities!.add.reason).toContain('Built-ins');
    expect(service.listProviders()[1].capabilities!.remove.reason).toContain('Disable');
    delete categories[1].sources[0].forbiddenSpecKeys;
    delete categories[1].sources[0].toggleReason;
    categories[1].sources[0].builtin = false;
    categories[1].sources[0].supportsToolAllowList = false;
    expect(service.listProviders()[1].capabilities!.toolToggle.reason).toContain('native tool permissions');
    expect(service.listProviders()[1].capabilities!.toggle.reason).toContain('no supported enabled field');
    await service.putServer('copilot', { name: 'x', spec: {} });
  });

  it('serializes concurrent writes to one underlying file and recovers after a failure', async () => {
    const { service, files } = setup();
    await Promise.all([
      service.putServer('claude', { name: 'a', spec: { command: 'a' } }),
      service.putServer('claude', { name: 'b', spec: { command: 'b' } }),
    ]);
    expect((await service.getServers('claude')).servers).toHaveLength(2);
    vi.mocked(files.write).mockRejectedValueOnce(new Error('write failed'));
    const outcomes = await Promise.allSettled([
      service.putServer('claude', { name: 'c', spec: {} }),
      service.putServer('claude', { name: 'd', spec: {} }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'fulfilled']);
  });

  it('blocks an edit when a concurrent external writer removed the target', async () => {
    const { service, files } = setup();
    vi.mocked(files.read)
      .mockResolvedValueOnce({ mcpServers: { a: { command: 'a' } } })
      .mockResolvedValueOnce({});
    await expect(service.putServer('copilot', { name: 'user:a', spec: {} })).rejects.toThrow(/removed while editing/);
    expect(files.write).not.toHaveBeenCalled();
  });
});

describe('explicit independent probes and native tool allow-lists', () => {
  it('does not probe for list/status, and reports probes without claiming CLI reload', async () => {
    const { service, inspect } = setup({ 'copilot.json': { mcpServers: { a: { command: 'node' } } } });
    await service.getServers('copilot');
    const before = await service.serverStatus('copilot', 'user:a');
    expect(before.status).toBe('unsupported');
    expect(inspect).not.toHaveBeenCalled();
    const result = await service.restartServer('copilot', 'user:a');
    expect(inspect).toHaveBeenCalledWith({ serverName: 'a', spec: { command: 'node' }, timeoutMs: 100 });
    expect(result.liveReloadedSessions).toBe(0);
    expect(result.liveReloadCommand).toBeNull();
    expect(result.message).toContain('not the CLI connection');
    expect(result.server.toolDiscovery!.output).toEqual([]);
    expect((await service.serverStatus('copilot', 'user:a')).status).toBe('connected');
  });

  it('bounds active probes and releases capacity after thrown failures', async () => {
    const { service, inspect } = setup({ 'copilot.json': { mcpServers: { a: { command: 'node' } } } });
    let finish!: (value: McpToolInspection) => void;
    inspect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = service.inspectServer('copilot', 'user:a');
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    await expect(service.inspectServer('copilot', 'user:a')).rejects.toThrow(/capacity/);
    finish(good);
    await first;
    inspect.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(service.inspectServer('copilot', 'user:a')).rejects.toThrow('spawn failed');
    await expect(service.inspectServer('copilot', 'user:a')).resolves.toHaveProperty('tools');
  });

  it.each([
    { url: 'https://remote' }, { command: '' }, { command: 'node', type: 'http' },
    { command: 'node', url: 'https://remote' },
  ])('does not probe unsupported transports %j', async (spec) => {
    const { service, inspect } = setup({ 'copilot.json': { mcpServers: { a: spec } } });
    await expect(service.inspectServer('copilot', 'user:a')).rejects.toThrow(/native OAuth/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('keeps disabled servers and built-ins out of probes', async () => {
    const { service, categories } = setup({ 'copilot.json': { mcpServers: { a: { command: 'node', enabled: false } } } });
    categories[1].sources[0].supportsEnabled = true;
    expect((await service.serverStatus('copilot', 'user:a')).status).toBe('disabled');
    await expect(service.inspectServer('copilot', 'user:a')).rejects.toThrow(/Enable/);
  });

  it.each(['stdio', 'local'])('recognizes supported %s command transport', async (type) => {
    const { service } = setup({ 'copilot.json': { mcpServers: { a: { command: 'node', type } } } });
    expect((await service.inspectServer('copilot', 'user:a')).tools).toHaveLength(2);
  });

  it('requires successful explicit tool discovery, then preserves unknown allow-list names', async () => {
    const { service, data, inspect } = setup({ 'copilot.json': { mcpServers: { a: { command: 'node', tools: ['read', 'future'], custom: 1 } } } });
    const toggle = { serverName: 'user:a', toolName: 'write', enabled: true };
    await expect(service.setToolEnabled('copilot', toggle)).rejects.toThrow(/Inspect tools/);
    inspect.mockResolvedValueOnce({ ...good, status: 'failed', message: 'needs auth' });
    await service.inspectServer('copilot', 'user:a');
    await expect(service.setToolEnabled('copilot', toggle)).rejects.toThrow(/Inspect tools/);
    expect((await service.serverStatus('copilot', 'user:a')).status).toBe('error');
    await service.inspectServer('copilot', 'user:a');
    await expect(service.setToolEnabled('copilot', { ...toggle, toolName: 'unknown' })).rejects.toThrow(/not returned/);
    const result = await service.setToolEnabled('copilot', toggle);
    expect(result.message).toContain('No running CLI session');
    expect(data.get('copilot.json')!.mcpServers).toEqual({ a: { command: 'node', tools: ['read', 'future', 'write'], custom: 1 } });
    await expect(service.setToolEnabled('copilot', toggle)).rejects.toThrow(/Inspect tools/);
  });

  it.each([undefined, ['*']])('expands unrestricted tools %j only after explicit discovery', async (tools) => {
    const { service, data } = setup({ 'copilot.json': { mcpServers: { a: { command: 'node', tools } } } });
    await service.inspectServer('copilot', 'user:a');
    await service.setToolEnabled('copilot', { serverName: 'user:a', toolName: 'write', enabled: false });
    expect((data.get('copilot.json')!.mcpServers!.a as Record<string, unknown>).tools).toEqual(['read']);
  });

  it('validates tool toggle input and provider support without probes', async () => {
    const { service, inspect } = setup({ 'claude.json': { mcpServers: { a: { command: 'node' } } } });
    await expect(service.setToolEnabled('claude', { serverName: 'user:a', toolName: 'read', enabled: 1 as never })).rejects.toThrow(/boolean/);
    await expect(service.setToolEnabled('claude', { serverName: 'user:a', toolName: ' ', enabled: true })).rejects.toThrow(/tool name/);
    await expect(service.setToolEnabled('claude', { serverName: 'user:a', toolName: 'read', enabled: true })).rejects.toThrow(/native tool permissions/);
    expect(inspect).not.toHaveBeenCalled();
    expect((await service.inspectServer('claude', 'user:a')).tools!.every((tool) => tool.enabled)).toBe(true);
  });

  it('reports explicit stdio authentication failures without automatic remediation', async () => {
    const { service, inspect } = setup({ 'copilot.json': { mcpServers: { a: { command: 'node' } } } });
    inspect.mockResolvedValueOnce({ ...good, status: 'failed', authRequired: true, authUrl: 'https://native/login' });
    await service.inspectServer('copilot', 'user:a');
    expect(await service.serverStatus('copilot', 'user:a')).toMatchObject({
      status: 'auth-required', authRequired: true, authUrl: 'https://native/login',
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('rejects stale tool inventory after an external configuration change', async () => {
    const { service, data } = setup({ 'copilot.json': { mcpServers: { a: { command: 'node' } } } });
    await service.inspectServer('copilot', 'user:a');
    data.set('copilot.json', { mcpServers: { a: { command: 'changed' } } });
    expect((await service.serverStatus('copilot', 'user:a')).status).toBe('unsupported');
    await expect(service.setToolEnabled('copilot', { serverName: 'user:a', toolName: 'read', enabled: false }))
      .rejects.toThrow(/changed since inspection/);
  });

  it('rechecks the inspected spec inside the serialized write', async () => {
    const { service, files, data } = setup({ 'copilot.json': { mcpServers: { a: { command: 'node' } } } });
    await service.inspectServer('copilot', 'user:a');
    let reads = 0;
    vi.mocked(files.read).mockImplementation(async (path) => {
      if (path === 'copilot.json' && ++reads === 3) return { mcpServers: { a: { command: 'external' } } };
      return structuredClone(data.get(path) ?? null);
    });
    await expect(service.setToolEnabled('copilot', { serverName: 'user:a', toolName: 'read', enabled: false }))
      .rejects.toThrow(/changed while saving/);
    expect(files.write).not.toHaveBeenCalled();
  });
});
