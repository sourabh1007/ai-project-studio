import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { ApiError, createApiClient, type ProviderSelectionInfo } from '../../lib/api.js';
import { CliSection } from './cli-section.js';
import { AutomationBoundary, AutomationReadinessProvider } from '../../app/automation-readiness.js';

const info: ProviderSelectionInfo = {
  defaultProvider: 'copilot', selectionRequired: false,
  providers: [
    { id: 'copilot', installed: true },
    { id: 'claude', installed: false, installCommand: 'Install Claude using the official installer', installAvailable: true },
  ],
};

function mount(initial = info) {
  const api = createApiClient();
  const switcher = vi.fn().mockResolvedValue({ ...initial, defaultProvider: 'claude' });
  Object.assign(api, { switchProvider: switcher });
  const bootstrap = vi.spyOn(api, 'getProviderBootstrap').mockResolvedValue(initial);
  const select = vi.spyOn(api, 'selectProvider').mockResolvedValue({ ...initial, defaultProvider: 'claude' });
  const stop = vi.spyOn(api, 'stopIdleProviderWorkers').mockResolvedValue({ stopped: true });
  render(<ApiProvider value={api}><CliSection /></ApiProvider>);
  return { bootstrap, select, stop, switcher };
}

async function expandCli(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: `${label} settings` }));
}

function expandPreferences() {
  fireEvent.click(screen.getByText('CLI preferences', { selector: 'summary' }));
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('CLI settings', () => {
  it('surfaces provider policy reasons without disabling explicitly allowed interactive selection', async () => {
    mount({
      ...info, defaultProvider: 'interactive-cli', providers: [{
        id: 'interactive-cli', label: 'Interactive CLI', installed: true,
        automation: { supported: false, reason: 'Inherited MCP sources cannot be safely suppressed.' },
      }],
    });
    await expandCli('Interactive CLI');
    const summary = await screen.findByText('IDE feature readiness');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Use Interactive CLI' })).toBeEnabled();
    expect(screen.queryByText('Inherited MCP sources cannot be safely suppressed.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'About Interactive CLI' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Inherited MCP sources cannot be safely suppressed.');
  });

  it.each([undefined, new Error('Backend unavailable')])('fails closed for missing or failed readiness metadata and offers a bounded retry: %s', async (failure) => {
    const api = createApiClient();
    const status = vi.spyOn(api, 'getProviderBootstrap');
    if (failure) status.mockRejectedValue(failure);
    else status.mockResolvedValue(info);
    const view = render(<ApiProvider value={api}><AutomationReadinessProvider><AutomationBoundary>
      <button>Start agent</button>
    </AutomationBoundary></AutomationReadinessProvider></ApiProvider>);
    await screen.findByRole('button', { name: 'Refresh automation readiness' });
    await waitFor(() => expect(screen.queryByText('Checking automation readiness.', { exact: false })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument();
    status.mockResolvedValue({ ...info, providers: [{ id: 'copilot', installed: true, automation: { supported: true, reason: null } }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh automation readiness' }));
    expect(await screen.findByRole('button', { name: 'Start agent' })).toBeEnabled();
    view.unmount();
  });

  it('bounds a hung readiness check and ignores its late success', async () => {
    vi.useFakeTimers();
    try {
      const api = createApiClient();
      let finish!: (info: ProviderSelectionInfo) => void;
      vi.spyOn(api, 'getProviderBootstrap').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      render(<ApiProvider value={api}><AutomationReadinessProvider><AutomationBoundary>
        <button>Start agent</button>
      </AutomationBoundary></AutomationReadinessProvider></ApiProvider>);
      await act(async () => vi.advanceTimersByTime(20_000));
      expect(screen.getByText(/could not be confirmed in time/)).toBeInTheDocument();
      await act(async () => finish({ ...info, providers: [{ id: 'copilot', installed: true, automation: { supported: true, reason: null } }] }));
      expect(screen.queryByRole('button', { name: 'Start agent' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose another CLI' })).toBeEnabled();
    } finally { vi.useRealTimers(); }
  });
  it('uses the detected provider catalogue without manual Agency opt-in or automatic selection', async () => {
    const api = createApiClient();
    const initial = { ...info, internalAgencyEnabled: true,
      providers: [...info.providers, { id: 'agency', installed: true }],
    };
    vi.spyOn(api, 'getProviderBootstrap').mockResolvedValue(initial);
    const preferences = vi.spyOn(api, 'updateProviderPreferences');
    const select = vi.spyOn(api, 'selectProvider');
    const switcher = vi.spyOn(api, 'switchProvider');
    const configChanged = vi.fn();
    render(<ApiProvider value={api}><CliSection onConfigChanged={configChanged} /></ApiProvider>);
    await expandCli('Agency');
    expandPreferences();
    const checkbox = await screen.findByRole('checkbox', { name: 'Show unavailable IDE features (experimental)' });
    expect(checkbox).not.toBeChecked();
    expect(preferences).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    expect(await screen.findByRole('button', { name: 'Use Agency' })).toBeEnabled();
    expect(screen.getByText('Microsoft internal only')).toBeInTheDocument();
    expect(checkbox).toBeChecked();
    expect(preferences).not.toHaveBeenCalled();
    expect(configChanged).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(switcher).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });
  it('lists only eligible providers, active selection and install commands without mutating on mount', async () => {
    const h = mount();
    expect(await screen.findByText('Active CLI:')).toHaveTextContent('Copilot');
    expect(screen.queryByText('Agency')).toBeNull();
    expect(screen.getByRole('region', { name: 'Uninstalled CLIs' })).toBeInTheDocument();
    expect(screen.queryByText(info.providers[1].installCommand!)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use Copilot' })).toBeNull();
    await expandCli('Copilot');
    expect(screen.getByRole('button', { name: 'Use Copilot' })).toBeEnabled();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    await expandCli('Claude Code');
    expect(screen.getByRole('button', { name: 'Use Claude Code' })).toBeDisabled();
    expect(h.switcher).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open CLI setup' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'About Claude Code' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(info.providers[1].installCommand!);
  });

  it('preserves active selection on 409 and network errors', async () => {
    const h = mount({ ...info, providers: info.providers.map((provider) => ({ ...provider, installed: true })) });
    await expandCli('Claude Code');
    h.switcher.mockRejectedValueOnce(new ApiError(409, 'Stop terminal first.'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Claude Code' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop CLI work and switch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Stop terminal first.');
    expect(screen.getByText('Active CLI:')).toHaveTextContent('Copilot');
    h.switcher.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Use Claude Code' }).at(-1)!);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop CLI work and switch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.getByText('Active CLI:')).toHaveTextContent('Copilot');
  });

  it('stops idle warm workers only after a click and refreshes before enabling selection', async () => {
    const h = mount({ ...info, blockers: [{ kind: 'warm-pool', id: 'pool', label: 'idle warm pool' }] });
    await expandCli('Claude Code');
    expect(await screen.findByRole('button', { name: 'Use Claude Code' })).toBeDisabled();
    expect(h.stop).not.toHaveBeenCalled();
    h.bootstrap.mockResolvedValue(info);
    fireEvent.click(screen.getByText('Switching requirements (1)', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop idle background CLI workers' }));
    await waitFor(() => expect(h.bootstrap).toHaveBeenCalledTimes(2));
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it('never offers to stop interactive work and keeps failed idle stops explicit', async () => {
    const h = mount({ ...info, blockers: [{ kind: 'probe', id: 'p', label: 'probe' }] });
    await expandCli('Claude Code');
    fireEvent.click(screen.getByText('Switching requirements (1)', { selector: 'summary' }));
    h.stop.mockRejectedValue(new ApiError(409, 'Probe is busy.'));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop idle background CLI workers' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Probe is busy.');
    expect(screen.getByRole('button', { name: 'Use Claude Code' })).toBeDisabled();
    h.bootstrap.mockResolvedValue({ ...info, blockers: [{ kind: 'session', id: 's', label: 'interactive session' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh CLI status' }));
    await screen.findByText('Stop interactive session before switching.');
    expect(screen.queryByRole('button', { name: 'Stop idle background CLI workers' })).toBeNull();
  });

  it('shows unavailable bootstrap as an error rather than a usable default', async () => {
    const h = mount();
    await screen.findByText('Active CLI:');
    h.bootstrap.mockRejectedValue(new Error('bootstrap unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh CLI status' }));
    expect(await screen.findByText('bootstrap unavailable')).toBeTruthy();
    expect(h.select).not.toHaveBeenCalled();
  });

  it('keeps all provider settings collapsed and opens static documentation without starting CLI work', async () => {
    const settings = vi.fn(() => <label>Executable<input aria-label="CLI executable" /></label>);
    const api = createApiClient();
    const bootstrap = vi.spyOn(api, 'getProviderBootstrap').mockResolvedValue(info);
    const select = vi.spyOn(api, 'selectProvider');
    const switcher = vi.spyOn(api, 'switchProvider');
    render(<ApiProvider value={api}><CliSection renderProviderSettings={settings} /></ApiProvider>);
    const toggle = await screen.findByRole('button', { name: 'Copilot settings' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('textbox', { name: 'CLI executable' })).toBeNull();
    expect(settings).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByRole('button', { name: 'About CLI settings' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('waits for confirmed exit');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: 'CLI executable' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('textbox', { name: 'CLI executable' })).toBeNull();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(switcher).not.toHaveBeenCalled();
  });
});
