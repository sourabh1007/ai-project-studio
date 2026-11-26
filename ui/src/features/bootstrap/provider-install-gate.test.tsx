import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { ApiError, createApiClient, type ProviderSelectionInfo as ProviderBootstrapInfo } from '../../lib/api.js';
import { ProviderInstallGate } from './provider-install-gate.js';
import { PROVIDER_CHANGED } from '../../lib/provider-selection.js';

class InstallerStream {
  static instances: InstallerStream[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    InstallerStream.instances.push(this);
  }
  send(event: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  }
  fail() {
    this.onerror?.(new Event('error'));
  }
}

const bootstrap = (
  defaultProvider: string,
  installed: boolean,
): ProviderBootstrapInfo => ({
  defaultProvider,
  providers: [
    { id: 'copilot', installed: defaultProvider === 'copilot' ? installed : false },
    { id: 'agency', installed: defaultProvider === 'agency' ? installed : false },
  ],
});

function mount(
  probe: () => Promise<ProviderBootstrapInfo> = async () => bootstrap('copilot', false),
) {
  const api = createApiClient();
  const status = vi.spyOn(api, 'getProviderBootstrap').mockImplementation(probe);
  const select = vi.spyOn(api, 'selectProvider').mockImplementation(async (id) => bootstrap(id, false));
  const view = render(
    <ApiProvider value={api}>
      <ProviderInstallGate><p>Application ready</p></ProviderInstallGate>
    </ApiProvider>,
  );
  return { status, select, ...view };
}

const flush = () => act(async () => {});
async function install(id = 'copilot') {
  await flush();
  fireEvent.click(screen.getByRole('button', { name: `Install and use — ${id === 'agency' ? 'Agency' : 'Copilot'}` }));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  InstallerStream.instances = [];
  vi.stubGlobal('EventSource', InstallerStream);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ProviderInstallGate', () => {
  it('keeps installed startup choices enabled and switches only after consent to drain workers', async () => {
    const info = { ...bootstrap('copilot', true), selectionRequired: true, revision: 3,
      blockers: [{ kind: 'warm-pool', id: 'p1', label: 'startup pool' }],
      providers: [{ id: 'copilot', installed: true }, { id: 'agency', installed: true }] };
    const api = createApiClient();
    vi.spyOn(api, 'getProviderBootstrap').mockResolvedValue(info);
    const select = vi.spyOn(api, 'selectProvider');
    const switchCli = vi.spyOn(api, 'switchProvider').mockResolvedValue({ ...info, defaultProvider: 'agency', selectionRequired: false, blockers: [] });
    render(<ApiProvider value={api}><ProviderInstallGate><p>Application ready</p></ProviderInstallGate></ApiProvider>);
    await flush();
    const choice = screen.getByRole('button', { name: 'Use installed CLI — Agency' });
    expect(choice).toBeEnabled();
    fireEvent.click(choice);
    expect(switchCli).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop CLI work and switch' }));
    await flush();
    expect(switchCli).toHaveBeenCalledWith({ providerId: 'agency', remember: false, expectedRevision: 3 });
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByText('Application ready')).toBeInTheDocument();
  });
  it('does not navigate consumers away until an explicitly selected CLI finishes installing', async () => {
    const changed = vi.fn();
    window.addEventListener(PROVIDER_CHANGED, changed);
    try {
      mount(async () => bootstrap('agency', false));
      await install('agency');
      expect(changed).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Installing Agency' })).toBeInTheDocument();
      await act(async () => InstallerStream.instances[0].send({ kind: 'done' }));
      expect(changed).toHaveBeenCalledOnce();
      expect((changed.mock.calls[0][0] as CustomEvent).detail.providers).toContainEqual({ id: 'agency', installed: true });
    } finally {
      window.removeEventListener(PROVIDER_CHANGED, changed);
    }
  });
  it('announces an explicitly completed Settings provider selection', async () => {
    const api = createApiClient();
    const selected = { ...bootstrap('agency', true), selectionRequired: false };
    vi.spyOn(api, 'getProviderBootstrap').mockResolvedValue(selected);
    vi.spyOn(api, 'selectProvider').mockResolvedValue(selected);
    const changed = vi.fn();
    window.addEventListener(PROVIDER_CHANGED, changed);
    try {
      render(<ApiProvider value={api}><ProviderInstallGate forceChoose><p>Selected</p></ProviderInstallGate></ApiProvider>);
      await flush();
      fireEvent.click(screen.getByRole('button', { name: 'Use installed CLI — Agency' }));
      await flush();
      expect(changed).toHaveBeenCalledOnce();
      expect((changed.mock.calls[0][0] as CustomEvent).detail).toEqual(selected);
      expect(screen.getByText('Selected')).toBeInTheDocument();
    } finally {
      window.removeEventListener(PROVIDER_CHANGED, changed);
    }
  });
  it('only remembers a startup choice when the checkbox is explicitly checked', async () => {
    const h = mount(async () => ({
      ...bootstrap('copilot', true), selectionRequired: true,
    }));
    h.select.mockResolvedValue(bootstrap('copilot', true));
    await flush();
    expect(screen.getByRole('checkbox', { name: 'Remember me' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use installed CLI — Copilot' }));
    await flush();
    expect(h.select).toHaveBeenCalledWith('copilot', { remember: true });
    expect(screen.getByText('Application ready')).toBeInTheDocument();
  });
  it('opens the application without installing when the default provider is present', async () => {
    mount(async () => bootstrap('copilot', true));
    await flush();
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('separates provider setup cards and labels Agency without claiming missing Claude features are unsupported', async () => {
    mount(async () => ({
      ...bootstrap('copilot', true), selectionRequired: true,
      providers: [
        { id: 'copilot', installed: true, automation: { supported: true, reason: null } },
        { id: 'agency', installed: true, automation: { supported: false, integrationSupported: false, reason: 'Studio inventory verification required' } },
        { id: 'claude', installed: false },
      ],
    }));
    await flush();
    expect(screen.getAllByRole('region', { name: /setup$/ })).toHaveLength(3);
    expect(screen.getByText('Microsoft internal only')).toBeInTheDocument();
    expect(screen.queryByText(/5\/10 available/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Unavailable' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Studio integration required' })).toHaveLength(5);
    expect(screen.getAllByRole('img', { name: 'Setup required' })).toHaveLength(6);
  });

  it('installs Agency only after explicit consent via its own stream', async () => {
    mount(async () => bootstrap('agency', false));
    await install('agency');
    expect(screen.getByRole('heading', { name: 'Installing Agency' })).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(1);
    expect(InstallerStream.instances[0].url).toContain('/agency/install');
  });

  it('shows native Agency automation as ready with decorative icons, without selecting or launching it', async () => {
    const h = mount(async () => ({
      ...bootstrap('copilot', true), selectionRequired: true,
      providers: [{ id: 'agency', installed: true, automation: { supported: true, state: 'ready', reason: null } }],
    }));
    await flush();
    const card = screen.getByRole('region', { name: 'Agency setup' });
    expect(card.querySelectorAll('[aria-label="Available"]')).toHaveLength(10);
    expect(card.querySelector('.cli-provider-icon svg')).toHaveAttribute('aria-hidden', 'true');
    expect(document.querySelector('.bootstrap-badge')).not.toHaveClass('is-checking');
    expect(screen.getByRole('button', { name: 'Use installed CLI — Agency' })).toBeEnabled();
    expect(h.select).not.toHaveBeenCalled();
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('installs GitHub Copilot CLI when it is the default', async () => {
    mount(async () => bootstrap('copilot', false));
    await install();
    expect(screen.getByRole('heading', { name: 'Installing Copilot' })).toBeTruthy();
    expect(InstallerStream.instances[0].url).toContain('/copilot/install');
  });

  it('does not interpret a failed status read as missing, and supports a safe retry', async () => {
    const h = mount(async () => { throw new Error('offline'); });
    await flush();
    expect(screen.getByText(/Could not confirm whether the AI CLI is installed: offline/)).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
    h.status.mockResolvedValue(bootstrap('copilot', true));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('bounds an unresponsive status probe and ignores a late missing result', async () => {
    let resolve!: (info: ProviderBootstrapInfo) => void;
    mount(() => new Promise((yes) => { resolve = yes; }));
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(screen.getByText(/status check timed out/)).toBeTruthy();
    await act(async () => { resolve(bootstrap('copilot', false)); });
    expect(InstallerStream.instances).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Continue without waiting' }));
    expect(screen.getByText('Application ready')).toBeTruthy();
  });

  it('does not install when the bootstrap response omits the default provider', async () => {
    const api = createApiClient({
      fetchImpl: async () =>
        new Response(JSON.stringify({ defaultProvider: 'copilot', providers: [] })),
    });
    render(
      <ApiProvider value={api}>
        <ProviderInstallGate><p>Application ready</p></ProviderInstallGate>
      </ApiProvider>,
    );
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('did not confirm installation availability');
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('allows deferral during checking without starting an installer when the probe finishes', async () => {
    let resolve!: (info: ProviderBootstrapInfo) => void;
    mount(() => new Promise((yes) => { resolve = yes; }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue without waiting' }));
    await act(async () => { resolve(bootstrap('copilot', false)); vi.advanceTimersByTime(30_000); });
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('reports stalled live progress, resumes on output, and completes normally', async () => {
    mount();
    await install();
    const stream = InstallerStream.instances[0];
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole('status')).toHaveTextContent('No installer progress for 30 seconds');
    expect(stream.close).not.toHaveBeenCalled();
    act(() => stream.send({ kind: 'line', line: 'Downloading' }));
    expect(screen.getByRole('status')).toHaveTextContent('Installing');
    expect(screen.getByRole('status')).not.toHaveTextContent('No installer progress');
    expect(screen.getByRole('log', { name: 'Recent installation output' })).toHaveTextContent('Downloading');
    act(() => stream.send({ kind: 'done' }));
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(stream.close).toHaveBeenCalled();
  });

  it('closes observation on deferral and ignores late stream events without claiming cancellation', async () => {
    mount();
    await install();
    const stream = InstallerStream.instances[0];
    expect(screen.getByText(/Continuing does not cancel an installer already running/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue without waiting' }));
    expect(stream.close).toHaveBeenCalled();
    act(() => {
      stream.send({ kind: 'error', message: 'late failure' });
      stream.fail();
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(screen.queryByText('late failure')).toBeNull();
  });

  it('does not start a duplicate installer after connection loss and can recheck successful completion', async () => {
    const h = mount();
    await install();
    act(() => InstallerStream.instances[0].fail());
    expect(screen.getByRole('heading', { name: 'Installation status unknown' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(screen.getByText(/previous installer may still be running/)).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(1);
    h.status.mockResolvedValue(bootstrap('copilot', true));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(1);
  });

  it('permits another install after a confirmed terminal failure and ignores old events', async () => {
    mount();
    await install();
    const old = InstallerStream.instances[0];
    act(() => old.send({ kind: 'error', message: 'Install exited unsuccessfully' }));
    expect(screen.getByText('Install exited unsuccessfully')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await flush();
    expect(InstallerStream.instances).toHaveLength(1);
    await install();
    expect(InstallerStream.instances).toHaveLength(2);
    act(() => old.send({ kind: 'done' }));
    expect(screen.queryByText('Application ready')).toBeNull();
    act(() => InstallerStream.instances[1].send({ kind: 'done' }));
    expect(screen.getByText('Application ready')).toBeTruthy();
  });

  it('bounds log retention and rejects malformed progress without treating it as success', async () => {
    mount();
    await install();
    const stream = InstallerStream.instances[0];
    act(() => {
      stream.onmessage?.(new MessageEvent('message', { data: 'not-json' }));
      stream.send(null);
      stream.send(42);
      stream.send({ kind: 'line', line: { unsafe: true } });
      for (let i = 0; i < 205; i++) stream.send({ kind: 'line', line: `line-${i}` });
      stream.send({ kind: 'line', line: 'X'.repeat(10_000) });
    });
    const log = screen.getByRole('log');
    expect(log.children).toHaveLength(200);
    expect(screen.queryByText('line-0')).toBeNull();
    expect(log.textContent).not.toContain('X'.repeat(1_001));
    expect(log.textContent).toContain('(truncated)');
    expect(screen.queryByText('Application ready')).toBeNull();
    act(() => stream.send({ kind: 'error', message: 7 }));
    expect(screen.getByText('Installation failed')).toBeTruthy();
  });

  it('does not install a missing default on mount, and lists only eligible choices', async () => {
    mount(async () => ({ defaultProvider: 'copilot', selectionRequired: true, providers: [{ id: 'copilot', installed: false }] }));
    await flush();
    expect(screen.getByRole('heading', { name: 'Choose your AI CLI' })).toBeTruthy();
    expect(screen.queryByText('Agency')).toBeNull();
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('allows an eligible Claude choice without a registered suggestion and uses its generic installer route', async () => {
    const h = mount(async () => ({
      defaultProvider: '', selectionRequired: true,
      providers: [{ id: 'claude', installed: false, installCommand: 'official Claude installer' }],
    }));
    h.select.mockResolvedValue({ defaultProvider: 'claude', selectionRequired: false, providers: [{ id: 'claude', installed: false }] });
    await flush();
    expect(screen.getByText('official Claude installer')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Install and use — Claude Code' }));
    await flush();
    expect(h.select).toHaveBeenCalledWith('claude', { remember: false });
    expect(InstallerStream.instances[0].url).toContain('/claude/install');
  });

  it('asks even when a fresh default is installed and persists use of the installed CLI', async () => {
    const info = { ...bootstrap('copilot', true), selectionRequired: true };
    const h = mount(async () => info);
    h.select.mockResolvedValue({ ...info, selectionRequired: false });
    await flush();
    expect(screen.queryByText('Application ready')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use installed CLI — Copilot' }));
    await flush();
    expect(h.select).toHaveBeenCalledWith('copilot', { remember: false });
    expect(screen.getByText('Application ready')).toBeTruthy();
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('keeps a rejected switch explicit and does not install on a 409 or outage', async () => {
    const h = mount();
    h.select.mockRejectedValueOnce(new ApiError(409, 'Stop the running session first.'));
    await install();
    expect(screen.getByRole('alert')).toHaveTextContent('Stop the running session first.');
    expect(InstallerStream.instances).toHaveLength(0);
    h.select.mockRejectedValueOnce(new Error('offline'));
    await install();
    expect(screen.getByRole('alert')).toHaveTextContent('offline');
    expect(InstallerStream.instances).toHaveLength(0);
  });

  it('does not turn Use installed CLI consent into installer consent if detection changes', async () => {
    const h = mount(async () => ({ ...bootstrap('copilot', true), selectionRequired: true }));
    h.select.mockResolvedValue(bootstrap('copilot', false));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Use installed CLI — Copilot' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('no longer detected');
    expect(InstallerStream.instances).toHaveLength(0);
    await install();
    expect(InstallerStream.instances).toHaveLength(1);
  });

  it('shows metadata and disables unavailable installers and live-work switches', async () => {
    mount(async () => ({
      defaultProvider: 'copilot', selectionRequired: true,
      blockers: [{ kind: 'session', id: 's1', label: 'running terminal' }],
      providers: [{ id: 'copilot', installed: false, installCommand: 'npm install example', installAvailable: false }],
    }));
    await flush();
    expect(screen.getByText('npm install example')).toBeTruthy();
    expect(screen.getByText(/Stop running terminal/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Install and use — Copilot' })).toBeDisabled();
  });
});
