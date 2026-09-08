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
import type { McpApplyResult, McpServerEntry, ProviderMcpConfig } from '../../lib/types.js';
import { McpManager } from './mcp-manager.js';

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
  it('renders discovered tools and toggles tool availability', async () => {
    const api = client();
    renderManager(api);

    expect(await screen.findByText('Azure')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));

    expect(await screen.findByText('read')).toBeTruthy();
    expect(screen.getByText('Read things')).toBeTruthy();
    expect(screen.getByText('device code ABCD')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('write'));

    await waitFor(() =>
      expect(api.setMcpToolEnabled).toHaveBeenCalledWith(
        'agency',
        'Azure',
        'write',
        true,
      ),
    );
    expect(await screen.findByText(/Sent \/restart to 1 open session/)).toBeTruthy();
  });

  it('restarts a server from its card', async () => {
    const api = client();
    renderManager(api);

    fireEvent.click(await screen.findByRole('button', { name: 'Restart Azure' }));

    await waitFor(() =>
      expect(api.restartMcpServer).toHaveBeenCalledWith('agency', 'Azure'),
    );
    expect(await screen.findByText(/Restarted Azure/)).toBeTruthy();
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
    fireEvent.click(screen.getByLabelText('beta'));

    await waitFor(() =>
      expect(api.setMcpToolEnabled).toHaveBeenCalledWith(
        'copilot',
        'Shared',
        'beta',
        false,
      ),
    );
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

  it('ignores a pending old-provider tool toggle after switching providers', async () => {
    const toggleAgency = deferred<McpApplyResult>();
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
      setMcpToolEnabled: vi.fn((providerId: string) => {
        if (providerId === 'agency') {
          return toggleAgency.promise;
        }
        return Promise.resolve(makeApplyResult('copilot', 'Shared'));
      }),
    });

    renderManager(api);

    expect(await screen.findByText('npx @agency/mcp')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    expect(await screen.findByText('alpha')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('alpha'));
    await waitFor(() =>
      expect(api.setMcpToolEnabled).toHaveBeenCalledWith(
        'agency',
        'Shared',
        'alpha',
        true,
      ),
    );

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
    const loadsBeforeSettle = callCountFor(getMcpServers, 'copilot');

    await act(async () => {
      toggleAgency.resolve(
        makeApplyResult('agency', 'Shared', {
          liveReloadedSessions: 1,
          liveReloadCommand: '/restart',
        }),
      );
    });

    expect(callCountFor(getMcpServers, 'copilot')).toBe(loadsBeforeSettle);
    expect(within(copilotDialog).queryByRole('alert')).toBeNull();
    expect(
      within(copilotDialog).queryByText(/Enabled alpha|Disabled alpha|Restarted Shared/),
    ).toBeNull();
  });

  it('ignores a pending old-provider tool restart after switching providers', async () => {
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
    const inspectMcpServer = vi.fn((providerId: string) =>
      Promise.resolve(
        makeInspection(
          'Shared',
          providerId === 'agency'
            ? [{ name: 'alpha', enabled: true }]
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
      restartMcpServer: vi.fn((providerId: string) => {
        if (providerId === 'agency') {
          return restartAgency.promise;
        }
        return Promise.resolve(makeApplyResult('copilot', 'Shared'));
      }),
    });

    renderManager(api);

    expect(await screen.findByText('npx @agency/mcp')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    const agencyDialog = await screen.findByRole('dialog', { name: 'Shared · tools' });
    expect(await within(agencyDialog).findByText('alpha')).toBeTruthy();

    fireEvent.click(within(agencyDialog).getByRole('button', { name: 'Restart' }));
    await waitFor(() =>
      expect(api.restartMcpServer).toHaveBeenCalledWith('agency', 'Shared'),
    );

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
    const loadsBeforeSettle = callCountFor(getMcpServers, 'copilot');

    await act(async () => {
      restartAgency.resolve(
        makeApplyResult('agency', 'Shared', {
          liveReloadedSessions: 1,
          liveReloadCommand: '/restart',
        }),
      );
    });

    expect(callCountFor(getMcpServers, 'copilot')).toBe(loadsBeforeSettle);
    expect(within(copilotDialog).queryByRole('alert')).toBeNull();
    expect(
      within(copilotDialog).queryByText(/Restarted Shared|Enabled alpha|Disabled alpha/),
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

  it('disables stale tool mutations until a retrying probe succeeds', async () => {
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

    fireEvent.click(within(dialog).getByLabelText('write'));
    await waitFor(() =>
      expect(api.setMcpToolEnabled).toHaveBeenCalledWith(
        'agency',
        'Azure',
        'write',
        true,
      ),
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'probe failed',
    );
    expect(
      within(dialog).getByText(/Current tool availability is unknown/i),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText('write')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Restart' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry discovery' }));

    await waitFor(() =>
      expect(within(dialog).getByLabelText('write')).toBeEnabled(),
    );
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});
