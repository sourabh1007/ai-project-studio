import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type {
  McpApplyResult,
  McpServerEntry,
  McpServerStatus,
  ProviderMcpConfig,
  McpCapabilities,
  McpAuthenticationJob,
} from '../../lib/types.js';
import { McpManager } from './mcp-manager.js';

const supported = { supported: true, reason: null };
const capabilities: McpCapabilities = {
  add: supported, edit: supported, remove: supported, toggle: supported,
  tools: supported, toolToggle: supported, restart: supported,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeServer(name: string, packageName: string): McpServerEntry {
  return {
    name,
    spec: { type: 'stdio', command: 'npx', args: [packageName] },
    toolDiscovery: {
      status: 'skipped',
      message: 'Open this server to discover its tools.',
      output: [],
    },
  };
}

function makeConfig(
  providerId: string,
  servers: McpServerEntry[],
): ProviderMcpConfig {
  return {
    providerId,
    configPath: `C:\\Users\\me\\.${providerId}\\mcp-config.json`,
    exists: true,
    servers,
    capabilities,
  };
}

function requiringAuth(entry: McpServerEntry): McpServerEntry {
  return { ...entry, toolDiscovery: {
    status: 'failed', authRequired: true, message: 'Sign-in required', output: [],
  } };
}

function makeStatus(
  name: string,
  overrides: Partial<McpServerStatus> = {},
): McpServerStatus {
  return {
    name,
    status: 'connected',
    toolCount: 2,
    authRequired: false,
    authUrl: null,
    message: null,
    ...overrides,
  };
}

function makeInspection(
  name: string,
  tools: Array<{ name: string; enabled: boolean; description?: string | null }>,
): McpServerEntry {
  return {
    name,
    spec: { type: 'stdio', command: 'npx', args: [`@${name.toLowerCase()}/mcp`] },
    tools: tools.map((tool) => ({
      name: tool.name,
      enabled: tool.enabled,
      description: tool.description ?? null,
    })),
    toolDiscovery: {
      status: 'ok',
      message: null,
      output: [],
    },
  };
}

function makeApplyResult(
  providerId: string,
  serverName: string,
  options: Partial<Pick<McpApplyResult, 'liveReloadedSessions' | 'liveReloadCommand'>> = {},
): McpApplyResult {
  return {
    config: makeConfig(providerId, []),
    server: { name: serverName, spec: {} },
    liveReloadedSessions: options.liveReloadedSessions ?? 0,
    liveReloadCommand: options.liveReloadCommand ?? null,
  };
}

function callCountFor(
  mockFn: { mock: { calls: unknown[][] } },
  providerId: string,
): number {
  return mockFn.mock.calls.filter(([current]) => current === providerId).length;
}

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listMcpProviders: vi.fn().mockResolvedValue([{ id: 'agency' }]),
    getMcpServers: vi
      .fn()
      .mockResolvedValue(makeConfig('agency', [makeServer('Azure', '@azure/mcp')])),
    inspectMcpServer: vi.fn().mockResolvedValue({
      ...makeInspection('Azure', [
        { name: 'read', description: 'Read things', enabled: true },
        { name: 'write', enabled: false },
      ]),
      toolDiscovery: {
        status: 'ok',
        message: null,
        output: ['device code ABCD'],
      },
    }),
    getMcpServerStatus: vi.fn().mockResolvedValue(makeStatus('Azure')),
    setMcpToolEnabled: vi.fn().mockResolvedValue(
      makeApplyResult('agency', 'Azure', {
        liveReloadedSessions: 1,
        liveReloadCommand: '/restart',
      }),
    ),
    restartMcpServer: vi.fn().mockResolvedValue(
      makeApplyResult('agency', 'Azure', {
        liveReloadedSessions: 1,
        liveReloadCommand: '/restart',
      }),
    ),
    putMcpServer: vi.fn(),
    removeMcpServer: vi.fn().mockResolvedValue(makeConfig('agency', [])),
    setMcpServerEnabled: vi.fn().mockResolvedValue(makeConfig('agency', [])),
    configureMcpBuiltin: vi.fn().mockResolvedValue(makeConfig('agency', [])),
    getMcpCommandOptions: vi.fn().mockResolvedValue({
      command: 'agency config set --global --mcp', options: [], examples: [], cachedAt: null, stale: false,
    }),
    startMcpAuthentication: vi.fn(),
    getMcpAuthentication: vi.fn(),
    cancelMcpAuthentication: vi.fn().mockResolvedValue({ status: 'cancelled', message: 'Cancelled' }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderManager(api: ApiClient) {
  return render(
    <ApiProvider value={api}>
      <McpManager />
    </ApiProvider>,
  );
}

describe('McpManager', () => {
  it('checks only the app-owned bridge automatically and routes inherited app tools to Studio', async () => {
    const unsupported = { supported: false, reason: 'App-owned' };
    const inherited: McpServerEntry = {
      name: 'copilot-user:ai-project-studio', displayName: 'ai-project-studio', origin: 'app', spec: {},
      capabilities: { add: unsupported, edit: unsupported, remove: unsupported, toggle: unsupported,
        tools: unsupported, toolToggle: unsupported, restart: unsupported },
    };
    const pending = deferred<McpServerStatus>();
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [
        inherited, { ...makeServer('native-builtins:ado', 'agency'), builtinName: 'ado', displayName: 'ado', capabilities },
      ])),
      getMcpServerStatus: vi.fn().mockReturnValue(pending.promise),
      inspectMcpServer: vi.fn().mockResolvedValue(makeInspection('ai-project-studio', [{ name: 'read_status', enabled: true }])),
    });
    renderManager(api);
    await waitFor(() => expect(api.getMcpServerStatus).toHaveBeenCalledWith('studio', 'ai-project-studio'));
    expect(api.getMcpServerStatus).toHaveBeenCalledOnce();
    expect(await screen.findByText('Checking…')).toBeInTheDocument();
    await act(async () => pending.resolve(makeStatus('ai-project-studio', { toolCount: 6 })));
    expect(await screen.findByText('Online · 6 tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auth ai-project-studio' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    expect(await screen.findByText('read_status')).toBeInTheDocument();
    expect(api.inspectMcpServer).toHaveBeenCalledWith('studio', 'ai-project-studio');
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
  });

  it('shows a disable toggle plus three controls and a red Reauth action only for an observed expiry', async () => {
    const entry: McpServerEntry = { ...makeServer('global-builtins:ado', 'agency'), builtinName: 'ado',
      displayName: 'ado', origin: 'agency-built-in', capabilities,
      authState: { state: 'expired', checkedAt: '2026-09-27T01:00:00Z', message: 'Credential expired' } };
    const api = client({ getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])) });
    renderManager(api);
    const card = (await screen.findByText('ado')).closest<HTMLElement>('.mcp-server-card')!;
    expect(within(card).getAllByRole('button')).toHaveLength(4);
    expect(within(card).getByRole('button', { name: 'Disable ado' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'Tools for ado' })).toBeEnabled();
    expect(within(card).getByRole('button', { name: 'Reauth ado' })).toHaveClass('btn-danger');
    expect(within(card).getByRole('button', { name: 'Edit ado' })).toBeEnabled();
    expect(api.inspectMcpServer).not.toHaveBeenCalled();
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
  });

  it('disables a configured global built-in from its card through the native toggle', async () => {
    const entry: McpServerEntry = { ...makeServer('global-builtins:ado', 'agency'), builtinName: 'ado',
      displayName: 'ado', origin: 'agency-built-in', enabled: true, capabilities };
    const api = client({
      getMcpServers: vi.fn()
        .mockResolvedValueOnce(makeConfig('agency', [entry]))
        .mockResolvedValue(makeConfig('agency', [{ ...entry, enabled: false }])),
      setMcpServerEnabled: vi.fn().mockResolvedValue(makeConfig('agency', [{ ...entry, enabled: false }])),
    });
    renderManager(api);
    const card = (await screen.findByText('ado')).closest<HTMLElement>('.mcp-server-card')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Disable ado' }));
    await waitFor(() => expect(api.setMcpServerEnabled).toHaveBeenCalledWith('agency', 'global-builtins:ado', false));
    expect(await within(card).findByRole('button', { name: 'Enable ado' })).toBeInTheDocument();
    expect(within(card).getByText('Disabled')).toBeInTheDocument();
  });
  it('shows an animated spinner and the supplied launch command while discovering tools', async () => {
    const pending = deferred<McpServerEntry>();
    const entry: McpServerEntry = { ...makeServer('global-builtins:ado', 'agency'), builtinName: 'ado',
      displayName: 'ado', capabilities, commandPreview: 'agency mcp ado --organization example' };
    const api = client({ getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])),
      inspectMcpServer: vi.fn().mockReturnValue(pending.promise) });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Tools for ado' }));
    const dialog = screen.getByRole('dialog', { name: 'ado · tools' });
    expect(within(dialog).getByRole('status', { name: 'Loading tools' })).toHaveClass('spinner');
    expect(within(dialog).getByText('Connecting and requesting tools/list')).toBeInTheDocument();
    expect(within(dialog).getByText(entry.commandPreview!)).toBeInTheDocument();
    expect(dialog.querySelector('.skeleton-card')).toBeNull();
    await act(async () => pending.resolve({ ...entry, ...makeInspection(entry.name, [{ name: 'read', enabled: true }]) }));
    expect(await within(dialog).findByText('read')).toBeInTheDocument();
    expect(within(dialog).queryByRole('status', { name: 'Loading tools' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Auth ado' })).toBeDisabled();
  });

  it('rejects a pasted full command instead of adding a second command prefix', async () => {
    const entry: McpServerEntry = { ...makeServer('catalog:ado', 'agency'), builtinName: 'ado',
      displayName: 'ado', catalog: true, capabilities };
    const api = client({ getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])) });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure ado' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Server arguments' }), {
      target: { value: 'agency mcp ado --organization example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Configure server' }));
    expect(await screen.findByText(/Enter options only/)).toBeInTheDocument();
    expect(api.configureMcpBuiltin).not.toHaveBeenCalled();
    expect(api.getMcpCommandOptions).toHaveBeenCalledWith('agency', 'catalog:ado');
    expect(api.inspectMcpServer).not.toHaveBeenCalled();
  });

  it('uses cached suggestions to build options without duplicating an example or command', async () => {
    const entry: McpServerEntry = { ...makeServer('catalog:ado', 'agency'), builtinName: 'ado',
      displayName: 'ado', catalog: true, capabilities };
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])),
      getMcpCommandOptions: vi.fn().mockResolvedValue({
        command: 'agency config set --global --mcp',
        options: [{ flag: '--legacy', description: 'Use legacy transport' }],
        examples: ['--organization example'], cachedAt: '2026-09-27T01:00:00Z', stale: false,
      }),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure ado' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use example --organization example' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use example --organization example' }));
    fireEvent.click(screen.getByText('Options'));
    fireEvent.click(screen.getByRole('button', { name: 'Add --legacy' }));
    expect(screen.getByRole('textbox', { name: 'Server arguments' })).toHaveValue('--organization example --legacy');
    expect(screen.getByText("agency config set --global --mcp 'ado --organization example --legacy'")).toBeInTheDocument();
    expect(api.getMcpCommandOptions).toHaveBeenCalledOnce();
    expect(api.configureMcpBuiltin).not.toHaveBeenCalled();
    expect(api.inspectMcpServer).not.toHaveBeenCalled();
  });

  it('refreshes stale suggestions without replacing the user draft or executing setup', async () => {
    const entry: McpServerEntry = { ...makeServer('catalog:ado', 'agency'), builtinName: 'ado',
      displayName: 'ado', catalog: true, capabilities };
    const cached = { command: 'agency config set --global --mcp', options: [], examples: [],
      cachedAt: '2026-09-27T01:00:00Z', stale: true };
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])),
      getMcpCommandOptions: vi.fn().mockResolvedValueOnce(cached)
        .mockResolvedValue({ ...cached, stale: false, examples: ['--organization refreshed'] }),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure ado' }));
    expect(await screen.findByText('Refreshing cached options.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Server arguments' }), { target: { value: '--organization my-draft' } });
    expect(await screen.findByRole('button', { name: 'Use example --organization refreshed' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Server arguments' })).toHaveValue('--organization my-draft');
    expect(api.getMcpCommandOptions).toHaveBeenCalledTimes(2);
    expect(api.configureMcpBuiltin).not.toHaveBeenCalled();
  });

  it('keeps Agency cards concise while grouping them under the Agency heading', async () => {
    const instruction = { supported: false, reason: 'Configure using agency config set --global --mcp ado' };
    const catalogCapabilities: McpCapabilities = {
      add: supported, edit: instruction, remove: instruction, toggle: instruction,
      tools: instruction, toolToggle: instruction, restart: instruction,
    };
    const catalog = (name: string): McpServerEntry => ({
      name: `catalog:${name}`, displayName: name, builtinName: name, catalog: true, providerLabel: 'Agency',
      source: 'Installed Agency MCP catalog', scope: 'Available built-in', enabled: false,
      spec: { type: 'agency', description: `${name} MCP tools` }, capabilities: catalogCapabilities,
    });
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue({
        ...makeConfig('agency', [makeServer('Configured', 'configured'), catalog('ado'), catalog('workiq')]),
        notices: ['The native configuration is not configured.', 'The native configuration is not configured.'],
      }),
    });
    renderManager(api);
    await screen.findByText('ado');
    const card = screen.getByText('ado').closest<HTMLElement>('.mcp-server-card')!;
    expect(within(card as HTMLElement).getByText('ado MCP tools')).toBeInTheDocument();
    expect(within(card as HTMLElement).queryByText('Agency')).toBeNull();
    expect(within(card as HTMLElement).queryByText('server')).toBeNull();
    expect(within(card as HTMLElement).queryByText('Installed Agency MCP catalog')).toBeNull();
    expect(screen.getByRole('region', { name: 'Agency built-in MCP servers' })).toContainElement(card);
    expect(within(card as HTMLElement).queryByRole('button', { name: 'Enable ado' })).toBeNull();
    expect(screen.getByText(/1 configured entry · 2 available MCP servers/)).toBeInTheDocument();
    const note = screen.getByText('The native configuration is not configured.');
    expect(note.closest('details')).not.toHaveAttribute('open');
    expect(screen.getAllByText('The native configuration is not configured.')).toHaveLength(1);
    expect(api.getMcpServerStatus).not.toHaveBeenCalled();
    expect(api.inspectMcpServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Configure ado' }));
    const dialog = screen.getByRole('dialog', { name: 'Configure ado' });
    expect(within(dialog).getByText(/agency config set --global --mcp 'ado'/)).toBeInTheDocument();
    expect(api.putMcpServer).not.toHaveBeenCalled();
    expect(api.configureMcpBuiltin).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'MCP servers' }), { target: { value: 'workiq' } });
    expect(screen.getByText('workiq')).toBeInTheDocument();
    expect(screen.queryByText('ado')).toBeNull();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'MCP servers' }), { target: { value: 'not-present' } });
    expect(screen.getByText('No MCP servers match this filter.')).toBeInTheDocument();
  });

  it('groups servers by actual origin and never tags an inherited app server as Agency', async () => {
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [
        { ...makeServer('user:ai-project-studio', 'studio'), displayName: 'AI Project Studio',
          origin: 'app', providerLabel: 'This app', source: 'Inherited from Copilot user config' },
        { ...makeServer('native:ado', 'agency'), displayName: 'ado', origin: 'agency-built-in', builtinName: 'ado' },
        { ...makeServer('user:my-server', 'server'), displayName: 'My server', origin: 'custom' },
      ])),
    });
    renderManager(api);
    const appSection = await screen.findByRole('region', { name: 'App MCP servers' });
    expect(within(appSection).getByText('AI Project Studio')).toBeInTheDocument();
    expect(within(appSection).getByText('This app')).toBeInTheDocument();
    expect(within(appSection).queryByText('Agency')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Agency built-in MCP servers' })).getByText('ado')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Custom MCP servers' })).getByText('My server')).toBeInTheDocument();
  });

  it('starts the configured-server workflow only on request and leaves catalog entries out', async () => {
    const configured = ['ado', 'finish-pr'].map((name): McpServerEntry => ({
      name: `global-builtins:${name}`, builtinName: name, displayName: name, origin: 'agency-built-in',
      description: `${name} integration tools`, spec: { type: name }, capabilities, enabled: true,
      source: 'agency config get mcps', scope: 'Global and resolved',
    }));
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [
        ...configured,
        { ...configured[0], name: 'catalog:bluebird', builtinName: 'bluebird', displayName: 'bluebird', catalog: true },
      ])),
      inspectMcpServer: vi.fn(async (_provider: string, name: string) => makeInspection(name, [{ name: 'read', enabled: true }])),
    });
    renderManager(api);
    const card = (await screen.findByText('ado')).closest<HTMLElement>('.mcp-server-card')!;
    expect(within(card).getByText('ado integration tools')).toBeInTheDocument();
    expect(within(card).queryByText('agency config get mcps')).toBeNull();
    expect(within(card).queryByText('Not checked')).toBeNull();
    expect(within(card).queryByText('Supported operations and limitations')).toBeNull();
    expect(api.inspectMcpServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check all configured servers' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(api.inspectMcpServer).toHaveBeenCalledTimes(2));
    expect(api.inspectMcpServer).toHaveBeenCalledWith('agency', 'global-builtins:ado');
    expect(api.inspectMcpServer).toHaveBeenCalledWith('agency', 'global-builtins:finish-pr');
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
  });

  it('shows differing declarations only in on-demand details, without exposing unsafe edits', async () => {
    const entry: McpServerEntry = { name: 'native-builtins:ado', builtinName: 'ado', displayName: 'ado',
      description: 'Azure DevOps tools', origin: 'agency-built-in', spec: { organization: 'workspace' },
      capabilities: { ...capabilities, edit: { supported: false, reason: 'Conflicting declarations' } },
      configurationConflict: true,
      configurationSources: [
        { kind: 'resolved', source: 'Resolved', scope: 'Workspace', spec: { organization: 'workspace' } },
        { kind: 'global', source: 'Global', scope: 'User', spec: { organization: 'global' } },
      ],
    };
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])),
      inspectMcpServer: vi.fn().mockResolvedValue({ ...entry, tools: [],
        toolDiscovery: { status: 'ok', message: null, output: [] } }),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Tools for ado' }));
    const dialog = screen.getByRole('dialog', { name: 'ado · tools' });
    expect(await within(dialog).findByText(/Global and resolved settings differ/)).toBeInTheDocument();
    expect(within(dialog).getByText('Configuration sources').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Edit ado' })).toBeDisabled();
  });

  it('executes native setup through the IDE and replaces the catalog card after verified completion', async () => {
    const pending = deferred<ProviderMcpConfig>();
    const catalog: McpServerEntry = {
      name: 'catalog:ado', displayName: 'ado', builtinName: 'ado', catalog: true,
      origin: 'agency-built-in', providerLabel: 'Agency', spec: {}, capabilities,
    };
    const configured: McpServerEntry = {
      ...catalog, name: 'builtin:ado', catalog: false, enabled: true,
    };
    const api = client({
      getMcpServers: vi.fn().mockResolvedValueOnce(makeConfig('agency', [catalog]))
        .mockResolvedValue(makeConfig('agency', [configured])),
      configureMcpBuiltin: vi.fn().mockReturnValue(pending.promise),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure ado' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Server arguments' }), { target: { value: '--organization example' } });
    const submit = screen.getByRole('button', { name: 'Configure server' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(api.configureMcpBuiltin).toHaveBeenCalledOnce();
    expect(api.configureMcpBuiltin).toHaveBeenCalledWith('agency', 'catalog:ado', { arguments: '--organization example' });
    expect(screen.getByRole('button', { name: /Configuring/ })).toBeDisabled();
    expect(screen.queryByText(/configured and verified/)).toBeNull();
    pending.resolve(makeConfig('agency', [configured]));
    await screen.findByText(/ado configured and verified/);
    const dialog = screen.getByRole('dialog', { name: 'Configure ado' });
    expect(within(dialog).getByText(/Saved. Use Tools or Auth/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Configure server' })).toBeNull();
    expect(api.inspectMcpServer).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('Available · not configured')).toBeNull();
    expect(screen.getByRole('button', { name: 'Tools for ado' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable ado' })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the native setup draft on failure without claiming configuration succeeded', async () => {
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [{
        ...makeServer('catalog:ado', 'agency'), displayName: 'ado', builtinName: 'ado', catalog: true,
        origin: 'agency-built-in', capabilities,
      }])),
      configureMcpBuiltin: vi.fn().mockRejectedValue(new Error('Agency rejected the organization argument')),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure ado' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Server arguments' }), { target: { value: '--organization wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Configure server' }));
    await screen.findByText('Agency rejected the organization argument');
    expect(screen.getByRole('textbox', { name: 'Server arguments' })).toHaveValue('--organization wrong');
    expect(screen.getByRole('button', { name: 'Configure server' })).toBeEnabled();
    expect(screen.queryByText(/configured and verified/)).toBeNull();
    expect(api.getMcpServers).toHaveBeenCalledOnce();
  });

  it('warns that native editing replaces options and shows saved settings before submission', async () => {
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [{
        ...makeServer('global-builtins:ado', 'agency'), displayName: 'ado', builtinName: 'ado',
        origin: 'agency-built-in', capabilities, spec: { organization: 'existing-org', enabled: false },
      }])),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit ado' }));
    const dialog = screen.getByRole('dialog', { name: 'Configure ado' });
    expect(within(dialog).getByRole('note')).toHaveTextContent('Replaces this built-in');
    expect(within(dialog).getByRole('note')).toHaveTextContent('may re-enable it');
    expect(within(dialog).getByText('Current saved settings')).toBeInTheDocument();
    expect(within(dialog).getByText(/"organization": "existing-org"/)).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Server arguments' })).toHaveValue('');
    expect(api.configureMcpBuiltin).not.toHaveBeenCalled();
  });

  it('lists distinct CLI and app categories without probing or mutating any server on load', async () => {
    const categories = [
      { id: 'copilot', label: 'Copilot CLI' }, { id: 'agency', label: 'Agency' },
      { id: 'claude', label: 'Claude Code' }, { id: 'studio', label: 'This app' },
    ];
    const api = client({
      listMcpProviders: vi.fn().mockResolvedValue(categories),
      getMcpServers: vi.fn(async (id) => ({
        ...makeConfig(id, [makeServer(`${id}-server`, '@example/mcp')]),
        notices: [`${id} source limitations`],
      })),
    });
    renderManager(api);
    for (const category of categories) {
      const select = await screen.findByRole('combobox', { name: 'Provider' });
      expect(screen.getByRole('option', { name: category.label })).toBeInTheDocument();
      fireEvent.change(select, { target: { value: category.id } });
      await screen.findByText(`${category.id}-server`);
      expect(screen.getByRole('region', { name: `${category.label} category` })).toBeInTheDocument();
      expect(screen.getByText(`${category.id} source limitations`)).toBeInTheDocument();
    }
    expect(api.getMcpServerStatus).not.toHaveBeenCalled();
    expect(api.inspectMcpServer).not.toHaveBeenCalled();
    expect(api.putMcpServer).not.toHaveBeenCalled();
  });

  it('shows source-specific unsupported operations while keeping read-only tool inspection available', async () => {
    const unavailable = { supported: false, reason: 'Managed by the app lifecycle; configure access in your CLI.' };
    const readOnly: McpCapabilities = {
      add: unavailable, edit: unavailable, remove: unavailable, toggle: unavailable,
      tools: supported, toolToggle: unavailable, restart: unavailable,
    };
    const entry = {
      ...makeServer('internal:studio', 'studio'), displayName: 'AI Project Studio',
      source: 'App tool definitions', scope: 'App-owned', capabilities: readOnly,
    };
    const api = client({
      listMcpProviders: vi.fn().mockResolvedValue([{ id: 'studio', label: 'This app', kind: 'app', capabilities: readOnly }]),
      getMcpServers: vi.fn().mockResolvedValue({ ...makeConfig('studio', [entry]), capabilities: readOnly }),
      inspectMcpServer: vi.fn().mockResolvedValue({
        ...entry, tools: [{ name: 'read_status', enabled: true, description: 'Status' }],
        toolDiscovery: { status: 'ok', message: 'App definitions', output: [] },
      }),
    });
    renderManager(api);
    await screen.findByText('AI Project Studio');
    expect(screen.getByText('App-owned')).toBeInTheDocument();
    expect(screen.getByText('App tool definitions')).toBeInTheDocument();
    for (const name of ['Add server', 'Edit AI Project Studio', 'Remove AI Project Studio', 'Disable AI Project Studio', 'Restart AI Project Studio']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    const dialog = await screen.findByRole('dialog', { name: 'AI Project Studio · tools' });
    expect(await within(dialog).findByText('read_status')).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByText('Supported operations and limitations')).toBeNull();
    expect(api.inspectMcpServer).toHaveBeenCalledWith('studio', 'internal:studio');
    expect(api.setMcpToolEnabled).not.toHaveBeenCalled();
  });

  it('requires removal confirmation and does not send duplicate deletes while waiting', async () => {
    const pending = deferred<ProviderMcpConfig>();
    const api = client({ removeMcpServer: vi.fn().mockReturnValue(pending.promise) });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Azure' }));
    expect(api.removeMcpServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Azure' }));
    const confirm = screen.getByRole('button', { name: 'Remove configuration' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(api.removeMcpServer).toHaveBeenCalledOnce();
    expect(api.removeMcpServer).toHaveBeenCalledWith('agency', 'Azure');
    expect(confirm).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    pending.resolve(makeConfig('agency', []));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps failed removal visible and leaves the card intact for retry', async () => {
    const api = client({ removeMcpServer: vi.fn().mockRejectedValue(new Error('Source is read-only')) });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Azure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove configuration' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Source is read-only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove configuration' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit Azure' })).toBeInTheDocument();
  });

  it('keeps enablement actions independent per card and updates returned configuration', async () => {
    const slow = deferred<ProviderMcpConfig>();
    let azureEnabled = true;
    let secondEnabled = true;
    const api = client({
      getMcpServers: vi.fn(async () => makeConfig('agency', [
        { ...makeServer('Azure', '@azure/mcp'), enabled: azureEnabled },
        { ...makeServer('Second', '@second/mcp'), enabled: secondEnabled },
      ])),
      setMcpServerEnabled: vi.fn(async (_id, name, enabled) => {
        if (name === 'Azure') {
          await slow.promise;
          azureEnabled = enabled;
        } else secondEnabled = enabled;
        return makeConfig('agency', []);
      }),
    });
    renderManager(api);
    const disableFirst = await screen.findByRole('button', { name: 'Disable Azure' });
    fireEvent.click(disableFirst);
    expect(disableFirst).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Disable Second' }));
    await screen.findByRole('button', { name: 'Enable Second' });
    expect(api.setMcpServerEnabled).toHaveBeenCalledTimes(2);
    slow.resolve(makeConfig('agency', []));
    await screen.findByRole('button', { name: 'Enable Azure' });
    expect(screen.getAllByText('Disabled in configuration')).toHaveLength(2);
  });

  it('surfaces toggle and connection errors without disabling other category navigation', async () => {
    const api = client({
      getMcpServerStatus: vi.fn().mockRejectedValue(new Error('Probe timed out')),
      setMcpServerEnabled: vi.fn().mockRejectedValue(new Error('Configuration changed externally')),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Azure' }));
    await screen.findByText('Configuration changed externally');
    fireEvent.click(screen.getByRole('button', { name: 'Re-check Azure' }));
    await screen.findByText('Probe timed out');
    expect(screen.getByRole('combobox', { name: 'Provider' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Disable Azure' })).toBeEnabled();
  });

  it('fails closed when the backend does not report capabilities', async () => {
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue({ ...makeConfig('agency', [makeServer('Azure', 'server')]), capabilities: undefined }),
    });
    renderManager(api);
    await screen.findByText('Azure');
    expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Azure' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Tools' })).toBeDisabled();
    expect(api.getMcpServerStatus).not.toHaveBeenCalled();
  });

  it('only checks a connection explicitly and labels the result as an independent probe', async () => {
    const api = client();
    renderManager(api);

    expect(await screen.findByText('Azure')).toBeTruthy();
    expect(api.getMcpServerStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check Azure' }));
    expect(await screen.findByText('Probe succeeded · 2 tools')).toBeTruthy();
    await waitFor(() =>
      expect(api.getMcpServerStatus).toHaveBeenCalledWith('agency', 'Azure'),
    );
  });

  it('surfaces an auth-required badge and one-click sign-in', async () => {
    const openExternalSpy = vi.fn();
    (
      globalThis as unknown as { desktop?: { openExternal: (u: string) => void } }
    ).desktop = { openExternal: openExternalSpy };
    const api = client({
      getMcpServerStatus: vi.fn().mockResolvedValue(
        makeStatus('Azure', {
          status: 'auth-required',
          toolCount: 0,
          authRequired: true,
          authUrl: 'https://login.example.com/device',
          message: 'Please sign in',
        }),
      ),
    });
    renderManager(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-check Azure' }));
    expect(await screen.findByText('Auth required')).toBeTruthy();
    const authButton = await screen.findByRole('button', {
      name: 'Authenticate',
    });
    fireEvent.click(authButton);

    expect(openExternalSpy).toHaveBeenCalledWith(
      'https://login.example.com/device',
    );
    expect(
      await screen.findByText(/Opened the sign-in page for Azure/),
    ).toBeTruthy();
    delete (globalThis as unknown as { desktop?: unknown }).desktop;
  });

  it('shows what self-healing tried when a connection fails', async () => {
    const api = client({
      getMcpServerStatus: vi.fn().mockResolvedValue(
        makeStatus('Azure', {
          status: 'error',
          toolCount: 0,
          message: 'spawn ENOENT',
          healAttempts: [
            {
              action: 'Probed the live server connection',
              outcome: 'failed',
              detail: 'spawn ENOENT',
            },
            {
              action: 'Retried the connection',
              outcome: 'failed',
              detail: 'spawn ENOENT',
            },
            {
              action: 'Ran an AI self-healing diagnosis',
              outcome: 'info',
              detail: 'The configured command path does not exist.',
            },
          ],
        }),
      ),
    });
    renderManager(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Re-check Azure' }));
    const failure = await screen.findByRole('button', {
      name: 'Show why Azure failed',
    });
    fireEvent.click(failure);

    expect(
      await screen.findByText("Why Azure couldn't connect"),
    ).toBeTruthy();
    expect(screen.getByText('Probed the live server connection')).toBeTruthy();
    expect(
      screen.getAllByText('The configured command path does not exist.').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('AI diagnosis')).toBeTruthy();
  });

  it('renders discovered tool names and descriptions without mutation controls', async () => {
    const api = client();
    renderManager(api);

    expect(await screen.findByText('Azure')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));

    expect(await screen.findByText('read')).toBeTruthy();
    expect(screen.getByText('Read things')).toBeTruthy();
    expect(screen.getByText('device code ABCD')).toBeTruthy();

    const dialog = screen.getByRole('dialog', { name: 'Azure · tools' });
    expect(within(dialog).getByText('write')).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Restart' })).toBeNull();
    expect(within(dialog).queryByText('Supported operations and limitations')).toBeNull();
    expect(api.setMcpToolEnabled).not.toHaveBeenCalled();
    expect(api.restartMcpServer).not.toHaveBeenCalled();
  });

  it('offers a reported authentication link and rechecks rather than assuming sign-in succeeded', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [requiringAuth(makeServer('Azure', '@azure/mcp'))])),
      inspectMcpServer: vi.fn()
        .mockResolvedValueOnce({
          ...makeInspection('Azure', []),
          toolDiscovery: { status: 'failed', message: 'Sign in to this server', output: [],
            authRequired: true, authUrl: 'https://login.example.com/device' },
        })
        .mockResolvedValueOnce(makeInspection('Azure', [{ name: 'read', enabled: true }])),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Auth Azure' }));
    const dialog = screen.getByRole('dialog', { name: 'Azure · authentication' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Authenticate' }));
    expect(open).toHaveBeenCalledWith('https://login.example.com/device', '_blank', 'noopener,noreferrer');
    expect(within(dialog).getByText('Authentication required')).toBeInTheDocument();
    expect(api.inspectMcpServer).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry discovery' }));
    expect(await within(dialog).findByText('No sign-in needed for this check.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Authenticate' })).toBeNull();
    expect(within(dialog).getByText(/Individual tools may require additional permissions/)).toBeInTheDocument();
    open.mockRestore();
  });

  it.each(['javascript:alert(1)', 'file:///secret', 'https://user:password@example.com', 'not a URL'])(
    'never offers an unsafe authentication link: %s',
    async (authUrl) => {
      const api = client({
        getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [requiringAuth(makeServer('Azure', '@azure/mcp'))])),
        inspectMcpServer: vi.fn().mockResolvedValue({
          ...makeInspection('Azure', []),
          toolDiscovery: { status: 'failed', message: 'Authentication needed', output: [],
            authRequired: true, authUrl },
        }),
      });
      renderManager(api);
      fireEvent.click(await screen.findByRole('button', { name: 'Auth Azure' }));
      const dialog = screen.getByRole('dialog', { name: 'Azure · authentication' });
      expect(await within(dialog).findByText(/supplied link could not be opened safely/)).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: 'Authenticate' })).toBeNull();
    },
  );

  it('does not infer authentication from an inventory failure or an unsolicited URL', async () => {
    const api = client({
      inspectMcpServer: vi.fn().mockResolvedValue({
        ...makeInspection('Azure', []),
        toolDiscovery: { status: 'failed', message: 'Server timed out', output: [],
          authUrl: 'https://login.example.com/device' },
      }),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Tools' }));
    const dialog = screen.getByRole('dialog', { name: 'Azure · tools' });
    expect(await within(dialog).findByText('Server timed out')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Authenticate' })).toBeNull();
    expect(within(dialog).queryByText(/without an outstanding sign-in request/)).toBeNull();
  });

  it('keeps unknown native authentication disabled until Tools confirms a sign-in requirement', async () => {
    const entry = {
      ...makeServer('global-builtins:ado', 'agency'), builtinName: 'ado', displayName: 'ado',
      capabilities, authentication: supported,
      authState: { state: 'unknown' as const, checkedAt: null, message: 'Connection not checked.' },
    };
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])),
      inspectMcpServer: vi.fn().mockResolvedValue({ ...requiringAuth(entry),
        authState: { state: 'required', checkedAt: '2026-09-27T01:00:00Z', message: 'Sign-in required' } }),
      startMcpAuthentication: vi.fn().mockResolvedValue({
        id: 'connect-1', serverName: entry.name, status: 'failed',
        message: 'Connection failed', authUrl: null, deviceCode: null,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      }),
    });
    renderManager(api);
    const auth = await screen.findByRole('button', { name: 'Auth ado' });
    expect(auth).toBeDisabled();
    expect(auth).not.toHaveClass('btn-danger');
    fireEvent.click(auth);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.inspectMcpServer).not.toHaveBeenCalled();
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Tools for ado' }));
    const openAuth = await screen.findByRole('button', { name: 'Open authentication' });
    expect(auth).toBeEnabled();
    expect(auth).toHaveClass('btn-danger');
    fireEvent.click(openAuth);
    const connect = await screen.findByRole('button', { name: 'Continue Agency sign-in' });
    fireEvent.click(connect);
    await waitFor(() => expect(api.startMcpAuthentication).toHaveBeenCalledWith('agency', entry.name));
  });

  it.each([
    ['unknown', false],
    ['ready', false],
    ['required', true],
    ['expired', true],
  ] as const)('uses confirmed %s auth state consistently on built-in and custom cards', async (state, required) => {
    const entries: McpServerEntry[] = [
      { ...makeServer('native', 'agency'), builtinName: 'ado', origin: 'agency-built-in' as const },
      makeServer('custom', '@custom/mcp'),
    ].map((entry) => ({ ...entry, capabilities,
      authState: { state, checkedAt: '2026-09-27T01:00:00Z', message: state } }));
    const api = client({ getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', entries)) });
    renderManager(api);
    for (const entry of entries) {
      const button = await screen.findByRole('button', { name: `${state === 'expired' ? 'Reauth' : 'Auth'} ${entry.name}` });
      if (required) {
        expect(button).toBeEnabled();
        expect(button).toHaveClass('btn-danger');
      } else {
        expect(button).toBeDisabled();
        expect(button).not.toHaveClass('btn-danger');
      }
    }
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
  });

  it('retains a native sign-in job, polls tools and removes completed authentication prompts', async () => {
    const entry = { ...requiringAuth(makeServer('global-builtins:ado', 'agency')), builtinName: 'ado', displayName: 'ado',
      capabilities, description: 'Azure DevOps tools' };
    const pending: McpAuthenticationJob = {
      id: 'auth-1', serverName: entry.name, status: 'pending', message: 'Waiting for sign-in',
      authUrl: 'https://login.example.com/device', deviceCode: 'ABCD', expiresAt: new Date(Date.now() + 120000).toISOString(),
    };
    const complete = deferred<McpAuthenticationJob>();
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])),
      inspectMcpServer: vi.fn().mockResolvedValue({ ...entry, authentication: supported,
        toolDiscovery: { status: 'failed', message: 'Sign-in required', output: [], authRequired: true, authUrl: null } }),
      startMcpAuthentication: vi.fn().mockResolvedValue(pending),
      getMcpAuthentication: vi.fn().mockReturnValue(complete.promise),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Auth ado' }));
    const dialog = screen.getByRole('dialog', { name: 'ado · authentication' });
    const start = await within(dialog).findByRole('button', { name: 'Continue Agency sign-in' });
    expect(api.startMcpAuthentication).not.toHaveBeenCalled();
    fireEvent.click(start);
    fireEvent.click(start);
    expect(await within(dialog).findByText('ABCD')).toBeInTheDocument();
    expect(api.startMcpAuthentication).toHaveBeenCalledOnce();
    expect(within(dialog).getByRole('button', { name: 'Retry discovery' })).toBeDisabled();
    await waitFor(() => expect(api.getMcpAuthentication).toHaveBeenCalledWith('agency', entry.name, 'auth-1'), { timeout: 2500 });
    await act(async () => complete.resolve({ ...pending, status: 'completed',
      server: { ...entry, ...makeInspection(entry.name, [{ name: 'read_pr', enabled: true }]) } }));
    expect(await within(dialog).findByText('No sign-in needed for this check.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auth ado' })).toBeDisabled();
    expect(within(dialog).queryByText('ABCD')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Authenticate' })).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(api.cancelMcpAuthentication).not.toHaveBeenCalled();
  });

  it('cancels a native job whose start returns after its view closes', async () => {
    const entry = { ...requiringAuth(makeServer('global-builtins:ado', 'agency')), builtinName: 'ado', displayName: 'ado', capabilities };
    const start = deferred<McpAuthenticationJob>();
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])),
      inspectMcpServer: vi.fn().mockResolvedValue({ ...entry, authentication: supported,
        toolDiscovery: { status: 'failed', message: 'Sign-in required', output: [], authRequired: true } }),
      startMcpAuthentication: vi.fn().mockReturnValue(start.promise),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Auth ado' }));
    const dialog = screen.getByRole('dialog', { name: 'ado · authentication' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue Agency sign-in' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await act(async () => start.resolve({ id: 'late-auth', serverName: entry.name, status: 'pending',
      message: 'Waiting', authUrl: null, deviceCode: null, expiresAt: new Date(Date.now() + 120000).toISOString() }));
    await waitFor(() => expect(api.cancelMcpAuthentication).toHaveBeenCalledWith('agency', entry.name, 'late-auth'));
    expect(api.getMcpAuthentication).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides expired native prompts and cancels pending work when closed', async () => {
    const entry = { ...requiringAuth(makeServer('global-builtins:ado', 'agency')), builtinName: 'ado', displayName: 'ado', capabilities };
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])),
      inspectMcpServer: vi.fn().mockResolvedValue({ ...entry, authentication: supported,
        toolDiscovery: { status: 'failed', message: 'Sign-in required', output: [], authRequired: true } }),
      startMcpAuthentication: vi.fn().mockResolvedValue({
        id: 'expired', serverName: entry.name, status: 'pending', message: 'Waiting',
        authUrl: 'https://login.example.com/device', deviceCode: 'STALE',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Auth ado' }));
    const dialog = screen.getByRole('dialog', { name: 'ado · authentication' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue Agency sign-in' }));
    expect(await within(dialog).findByText(/This sign-in prompt has expired/)).toBeInTheDocument();
    expect(within(dialog).queryByText('STALE')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Authenticate' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(api.cancelMcpAuthentication).toHaveBeenCalledWith('agency', entry.name, 'expired'));
  });

  it('stops exposing sign-in prompts after a poll error without restarting authentication', async () => {
    const entry = { ...requiringAuth(makeServer('global-builtins:ado', 'agency')), builtinName: 'ado', displayName: 'ado', capabilities };
    const pending: McpAuthenticationJob = { id: 'poll-error', serverName: entry.name, status: 'pending',
      message: 'Waiting', authUrl: 'https://login.example.com/device', deviceCode: 'LIVE',
      expiresAt: new Date(Date.now() + 120000).toISOString() };
    const api = client({
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [entry])),
      inspectMcpServer: vi.fn().mockResolvedValue({ ...entry, authentication: supported,
        toolDiscovery: { status: 'failed', message: 'Sign-in required', output: [], authRequired: true } }),
      startMcpAuthentication: vi.fn().mockResolvedValue(pending),
      getMcpAuthentication: vi.fn().mockRejectedValue(new Error('offline')),
      cancelMcpAuthentication: vi.fn().mockResolvedValue({ ...pending, status: 'cancelled', message: 'Cancelled' }),
    });
    renderManager(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Auth ado' }));
    const dialog = screen.getByRole('dialog', { name: 'ado · authentication' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Continue Agency sign-in' }));
    expect(await within(dialog).findByText('LIVE')).toBeInTheDocument();
    expect(await within(dialog).findByText(/Could not refresh sign-in status/, {}, { timeout: 2500 })).toBeInTheDocument();
    expect(within(dialog).queryByText('LIVE')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Authenticate' })).toBeNull();
    expect(api.startMcpAuthentication).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel sign-in' }));
    expect(await within(dialog).findByText('Cancelled')).toBeInTheDocument();
  });

  it('restarts a server from its card', async () => {
    const api = client();
    renderManager(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Restart Azure' }));

    await waitFor(() =>
      expect(api.restartMcpServer).toHaveBeenCalledWith('agency', 'Azure'),
    );
    expect(await screen.findByText(/Operation completed for Azure/)).toBeTruthy();
  });

  it('ignores late config results from the previous provider', async () => {
    const agencyLoad = deferred<ProviderMcpConfig>();
    const copilotLoad = deferred<ProviderMcpConfig>();
    const getMcpServers = vi.fn((providerId: string) => {
      if (providerId === 'agency') {
        return agencyLoad.promise;
      }
      return copilotLoad.promise;
    });
    const api = client({
      listMcpProviders: vi
        .fn()
        .mockResolvedValue([{ id: 'agency' }, { id: 'copilot' }]),
      getMcpServers,
    });

    renderManager(api);

    const providerSelect = await screen.findByRole('combobox', { name: 'Provider' });
    await waitFor(() => expect(getMcpServers).toHaveBeenCalledWith('agency'));

    fireEvent.change(providerSelect, { target: { value: 'copilot' } });
    await waitFor(() => expect(getMcpServers).toHaveBeenCalledWith('copilot'));

    await act(async () => {
      copilotLoad.resolve(
        makeConfig('copilot', [makeServer('Shared', '@copilot/mcp')]),
      );
    });

    expect(await screen.findByText('npx @copilot/mcp')).toBeTruthy();

    await act(async () => {
      agencyLoad.resolve(
        makeConfig('agency', [makeServer('Shared', '@agency/mcp')]),
      );
    });

    expect(screen.queryByText('npx @agency/mcp')).toBeNull();
    expect(screen.getByText('npx @copilot/mcp')).toBeTruthy();
  });

  it('quarantines stale provider data and shows retry instead of an empty CTA on failed loads', async () => {
    const copilotLoad = deferred<ProviderMcpConfig>();
    const getMcpServers = vi.fn((providerId: string) => {
      if (providerId === 'agency') {
        return Promise.resolve(
          makeConfig('agency', [makeServer('Shared', '@agency/mcp')]),
        );
      }
      return copilotLoad.promise;
    });
    const api = client({
      listMcpProviders: vi
        .fn()
        .mockResolvedValue([{ id: 'agency' }, { id: 'copilot' }]),
      getMcpServers,
    });

    renderManager(api);

    expect(await screen.findByText('Shared')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'copilot' },
    });
    await waitFor(() => expect(getMcpServers).toHaveBeenCalledWith('copilot'));

    expect(screen.queryByText('Shared')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Shared' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart Shared' })).toBeNull();
    expect(screen.queryByText('No MCP servers configured')).toBeNull();

    await act(async () => {
      copilotLoad.reject(new Error('copilot unavailable'));
    });

    expect(await screen.findByText('copilot unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry load' })).toBeTruthy();
    expect(screen.queryByText('No MCP servers configured')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Add server' })[0]).toBeDisabled();
  });

  it('shows save failures inside the dialog and preserves the draft', async () => {
    const api = client({
      putMcpServer: vi.fn().mockRejectedValue(new Error('Save failed')),
    });
    renderManager(api);

    await screen.findByText('Azure');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    const dialog = await screen.findByRole('dialog', { name: 'Add MCP server' });
    fireEvent.change(within(dialog).getByLabelText('Server name'), {
      target: { value: 'filesystem' },
    });
    fireEvent.change(within(dialog).getByLabelText('Configuration (JSON)'), {
      target: {
        value: '{"type":"stdio","command":"node","args":["server.js"]}',
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add server' }));

    await waitFor(() =>
      expect(api.putMcpServer).toHaveBeenCalledWith('agency', {
        name: 'filesystem',
        spec: { type: 'stdio', command: 'node', args: ['server.js'] },
      }),
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Save failed',
    );
    expect(within(dialog).getByLabelText('Server name')).toHaveValue('filesystem');
    expect(within(dialog).getByLabelText('Configuration (JSON)')).toHaveValue(
      '{"type":"stdio","command":"node","args":["server.js"]}',
    );
    expect(screen.getByRole('dialog', { name: 'Add MCP server' })).toBeTruthy();
  });

  it('keeps tool discovery bound to the visible provider when server names match', async () => {
    const agencyInspect = deferred<McpServerEntry>();
    const copilotInspect = deferred<McpServerEntry>();
    const inspectMcpServer = vi.fn((providerId: string) => {
      if (providerId === 'agency') {
        return agencyInspect.promise;
      }
      return copilotInspect.promise;
    });
    const api = client({
      listMcpProviders: vi
        .fn()
        .mockResolvedValue([{ id: 'agency' }, { id: 'copilot' }]),
      getMcpServers: vi.fn((providerId: string) =>
        Promise.resolve(
          makeConfig(providerId, [
            makeServer(
              'Shared',
              providerId === 'agency' ? '@agency/mcp' : '@copilot/mcp',
            ),
          ]),
        ),
      ),
      inspectMcpServer,
      setMcpToolEnabled: vi
        .fn()
        .mockResolvedValue(makeApplyResult('copilot', 'Shared')),
    });

    renderManager(api);

    expect(await screen.findByText('npx @agency/mcp')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    await waitFor(() =>
      expect(inspectMcpServer).toHaveBeenCalledWith('agency', 'Shared'),
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'copilot' },
    });
    expect(await screen.findByText('npx @copilot/mcp')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Shared · tools' })).toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    await waitFor(() =>
      expect(inspectMcpServer).toHaveBeenCalledWith('copilot', 'Shared'),
    );

    await act(async () => {
      copilotInspect.resolve(
        makeInspection('Shared', [{ name: 'beta', enabled: true }]),
      );
    });
    expect(await screen.findByText('beta')).toBeTruthy();

    await act(async () => {
      agencyInspect.resolve(
        makeInspection('Shared', [{ name: 'alpha', enabled: true }]),
      );
    });

    expect(screen.queryByText('alpha')).toBeNull();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(api.setMcpToolEnabled).not.toHaveBeenCalled();
  });

  it('does not refresh the new provider when an old-provider save finishes later', async () => {
    const saveAgency = deferred<ProviderMcpConfig>();
    const getMcpServers = vi.fn((providerId: string) =>
      Promise.resolve(
        makeConfig(providerId, [
          makeServer(
            'Shared',
            providerId === 'agency' ? '@agency/mcp' : '@copilot/mcp',
          ),
        ]),
      ),
    );
    const api = client({
      listMcpProviders: vi
        .fn()
        .mockResolvedValue([{ id: 'agency' }, { id: 'copilot' }]),
      getMcpServers,
      putMcpServer: vi.fn((providerId: string) => {
        if (providerId === 'agency') {
          return saveAgency.promise;
        }
        return Promise.resolve(makeConfig('copilot', []));
      }),
    });

    renderManager(api);

    expect(await screen.findByText('npx @agency/mcp')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Shared' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit Shared' });
    fireEvent.change(within(dialog).getByLabelText('Configuration (JSON)'), {
      target: {
        value: '{"type":"stdio","command":"npx","args":["@agency/updated"]}',
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.putMcpServer).toHaveBeenCalledWith('agency', {
        name: 'Shared',
        spec: { type: 'stdio', command: 'npx', args: ['@agency/updated'] },
      }),
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'copilot' },
    });
    expect(await screen.findByText('npx @copilot/mcp')).toBeTruthy();

    await act(async () => {
      saveAgency.resolve(
        makeConfig('agency', [makeServer('Shared', '@agency/updated')]),
      );
    });

    expect(callCountFor(getMcpServers, 'copilot')).toBe(1);
    expect(screen.getByText('npx @copilot/mcp')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Edit Shared' })).toBeNull();
  });

  it('keeps tool inventories read-only after switching providers', async () => {
    const getMcpServers = vi.fn((providerId: string) =>
      Promise.resolve(
        makeConfig(providerId, [
          makeServer(
            'Shared',
            providerId === 'agency' ? '@agency/mcp' : '@copilot/mcp',
          ),
        ]),
      ),
    );
    const inspectMcpServer = vi.fn((providerId: string) =>
      Promise.resolve(
        makeInspection(
          'Shared',
          providerId === 'agency'
            ? [{ name: 'alpha', enabled: false }]
            : [{ name: 'beta', enabled: true }],
        ),
      ),
    );
    const api = client({
      listMcpProviders: vi
        .fn()
        .mockResolvedValue([{ id: 'agency' }, { id: 'copilot' }]),
      getMcpServers,
      inspectMcpServer,
    });

    renderManager(api);

    expect(await screen.findByText('npx @agency/mcp')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    expect(await screen.findByText('alpha')).toBeTruthy();

    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'copilot' },
    });
    expect(await screen.findByText('npx @copilot/mcp')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Shared · tools' })).toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    const copilotDialog = await screen.findByRole('dialog', { name: 'Shared · tools' });
    expect(await within(copilotDialog).findByText('beta')).toBeTruthy();
    expect(within(copilotDialog).queryByText('alpha')).toBeNull();
    expect(within(copilotDialog).queryByRole('checkbox')).toBeNull();
    expect(api.setMcpToolEnabled).not.toHaveBeenCalled();
    expect(within(copilotDialog).queryByRole('alert')).toBeNull();
    expect(
      within(copilotDialog).queryByText(/Enabled alpha|Disabled alpha|Restarted Shared/),
    ).toBeNull();
  });

  it.each([
    {
      label: 'success',
      settle: (pending: Deferred<McpApplyResult>) =>
        pending.resolve(
          makeApplyResult('agency', 'Shared', {
            liveReloadedSessions: 1,
            liveReloadCommand: '/restart',
          }),
        ),
      unexpectedText: 'Restarted Shared',
    },
    {
      label: 'error',
      settle: (pending: Deferred<McpApplyResult>) =>
        pending.reject(new Error('restart failed')),
      unexpectedText: 'restart failed',
    },
  ])('ignores a stale manager restart %s after returning to the provider', async ({ settle, unexpectedText }) => {
    const restartAgency = deferred<McpApplyResult>();
    const getMcpServers = vi.fn((providerId: string) =>
      Promise.resolve(
        makeConfig(providerId, [
          makeServer(
            'Shared',
            providerId === 'agency' ? '@agency/mcp' : '@copilot/mcp',
          ),
        ]),
      ),
    );
    const api = client({
      listMcpProviders: vi
        .fn()
        .mockResolvedValue([{ id: 'agency' }, { id: 'copilot' }]),
      getMcpServers,
      restartMcpServer: vi.fn((providerId: string) => {
        if (providerId === 'agency') {
          return restartAgency.promise;
        }
        return Promise.resolve(makeApplyResult(providerId, 'Shared'));
      }),
    });

    renderManager(api);

    expect(await screen.findByText('npx @agency/mcp')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart Shared' }));
    await waitFor(() =>
      expect(api.restartMcpServer).toHaveBeenCalledWith('agency', 'Shared'),
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'copilot' },
    });
    expect(await screen.findByText('npx @copilot/mcp')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
      target: { value: 'agency' },
    });
    expect(await screen.findByText('npx @agency/mcp')).toBeTruthy();

    const agencyLoadsBeforeSettle = callCountFor(getMcpServers, 'agency');
    await act(async () => {
      settle(restartAgency);
    });

    expect(callCountFor(getMcpServers, 'agency')).toBe(agencyLoadsBeforeSettle);
    expect(screen.queryByText(unexpectedText)).toBeNull();
  });

  it('shows provider loading failure, then empty, then loaded states via retry', async () => {
    const listMcpProviders = vi
      .fn()
      .mockRejectedValueOnce(new Error('providers offline'))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'agency' }]);
    const api = client({
      listMcpProviders,
      getMcpServers: vi.fn().mockResolvedValue(makeConfig('agency', [])),
    });

    renderManager(api);

    expect(await screen.findByText('Couldn\'t load MCP providers')).toBeTruthy();
    expect(screen.queryByText('No providers expose MCP configuration.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry providers' }));
    expect(
      await screen.findByText('No providers expose MCP configuration.'),
    ).toBeTruthy();
    expect(screen.queryByText('Couldn\'t load MCP providers')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh providers' }));
    expect(await screen.findByText('No MCP servers configured')).toBeTruthy();
    expect(listMcpProviders).toHaveBeenCalledTimes(3);
  });

  it('clears stale tool inventory on failure and allows an explicit retry', async () => {
    const inspectMcpServer = vi
      .fn()
      .mockResolvedValueOnce(
        makeInspection('Azure', [{ name: 'write', enabled: false }]),
      )
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce(
        makeInspection('Azure', [{ name: 'write', enabled: true }]),
      );
    const api = client({
      inspectMcpServer,
      setMcpToolEnabled: vi
        .fn()
        .mockResolvedValue(makeApplyResult('agency', 'Azure')),
    });

    renderManager(api);

    await screen.findByText('Azure');
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    const dialog = await screen.findByRole('dialog', { name: 'Azure · tools' });
    expect(await within(dialog).findByText('write')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh tools' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'probe failed',
    );
    expect(
      within(dialog).getByText(/Check failed. Retry when ready./i),
    ).toBeTruthy();
    expect(within(dialog).queryByText('write')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Restart' })).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry discovery' }));

    expect(await within(dialog).findByText('write')).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(api.setMcpToolEnabled).not.toHaveBeenCalled();
  });
});
