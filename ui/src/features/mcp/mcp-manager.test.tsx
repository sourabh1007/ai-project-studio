import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { McpManager } from './mcp-manager.js';

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listMcpProviders: vi.fn().mockResolvedValue([{ id: 'agency' }]),
    getMcpServers: vi.fn().mockResolvedValue({
      providerId: 'agency',
      configPath: 'C:\\Users\\me\\.copilot\\mcp-config.json',
      exists: true,
      servers: [
        {
          name: 'Azure',
          spec: { type: 'stdio', command: 'npx', args: ['@azure/mcp'] },
          tools: [
            { name: 'read', description: 'Read things', enabled: true },
            { name: 'write', description: null, enabled: false },
          ],
          toolDiscovery: {
            status: 'ok',
            message: null,
            output: ['device code ABCD'],
          },
        },
      ],
    }),
    setMcpToolEnabled: vi.fn().mockResolvedValue({
      config: {
        providerId: 'agency',
        configPath: 'x',
        exists: true,
        servers: [],
      },
      server: { name: 'Azure', spec: {} },
      liveReloadedSessions: 1,
      liveReloadCommand: '/restart',
    }),
    restartMcpServer: vi.fn().mockResolvedValue({
      config: {
        providerId: 'agency',
        configPath: 'x',
        exists: true,
        servers: [],
      },
      server: { name: 'Azure', spec: {} },
      liveReloadedSessions: 1,
      liveReloadCommand: '/restart',
    }),
    putMcpServer: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

describe('McpManager', () => {
  it('renders discovered tools and toggles tool availability', async () => {
    const api = client();
    render(
      <ApiProvider value={api}>
        <McpManager />
      </ApiProvider>,
    );

    expect(await screen.findByText('Azure')).toBeTruthy();

    // Tools are behind a compact button that opens a modal.
    fireEvent.click(screen.getByRole('button', { name: /Tools/i }));

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
    render(
      <ApiProvider value={api}>
        <McpManager />
      </ApiProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Restart Azure' }));

    await waitFor(() =>
      expect(api.restartMcpServer).toHaveBeenCalledWith('agency', 'Azure'),
    );
    expect(await screen.findByText(/Restarted Azure/)).toBeTruthy();
  });
});
