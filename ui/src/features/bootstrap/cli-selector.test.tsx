import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient, ProviderSelectionInfo } from '../../lib/api.js';
import { PROVIDER_CHANGED } from '../../lib/provider-selection.js';
import { CliSelector } from './cli-selector.js';

const info: ProviderSelectionInfo = {
  defaultProvider: 'copilot', selectionRequired: false, revision: 3, remember: true,
  providers: [{ id: 'copilot', installed: true }, { id: 'claude', installed: true }, { id: 'missing', installed: false }],
  blockers: [{ kind: 'terminal', id: 'session', label: 'Interactive terminal' }],
};
function mount(initial = info) {
  const api = {
    getProviderBootstrap: vi.fn().mockResolvedValue(initial),
    switchProvider: vi.fn().mockResolvedValue({ ...initial, defaultProvider: 'claude', revision: 4 }),
  };
  const close = vi.fn();
  const view = render(<ApiProvider value={api as unknown as ApiClient}><CliSelector onClose={close} /></ApiProvider>);
  return { api, close, ...view };
}
afterEach(cleanup);

describe('CLI switch confirmation', () => {
  it('only switches after confirmation, sends revision and remember, and announces the confirmed result', async () => {
    const changed = vi.fn();
    window.addEventListener(PROVIDER_CHANGED, changed);
    const h = mount();
    expect(await screen.findByRole('button', { name: 'Use Claude Code' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Use Missing' })).toBeDisabled();
    expect(h.api.switchProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use Claude Code' }));
    expect(screen.getByText(/Save unsent composer text/)).toBeInTheDocument();
    expect(h.api.switchProvider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop CLI work and switch' }));
    await waitFor(() => expect(h.close).toHaveBeenCalledTimes(1));
    expect(h.api.switchProvider).toHaveBeenCalledWith({ providerId: 'claude', remember: false, expectedRevision: 3 });
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(PROVIDER_CHANGED, changed);
  });

  it('refreshes blockers after a refusal without announcing or changing the old CLI', async () => {
    const h = mount();
    h.api.switchProvider.mockRejectedValue(new Error('Native exit is not confirmed'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop CLI work and switch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Native exit is not confirmed');
    expect(h.close).not.toHaveBeenCalled();
    expect(h.api.getProviderBootstrap).toHaveBeenCalledTimes(2);
  });

  it('rejects an unconfirmed response and coalesces repeated confirmation clicks', async () => {
    const h = mount();
    let resolve!: (value: ProviderSelectionInfo) => void;
    h.api.switchProvider.mockImplementation(() => new Promise((yes) => { resolve = yes; }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop CLI work and switch' }));
    fireEvent.click(screen.getByRole('button', { name: /Waiting for CLI exit/ }));
    expect(h.api.switchProvider).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(info); });
    expect(await screen.findByRole('alert')).toHaveTextContent('did not confirm');
    expect(h.close).not.toHaveBeenCalled();
  });

  it('does not trust unavailable status or mutate after cancellation', async () => {
    const h = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Use Claude Code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.api.switchProvider).not.toHaveBeenCalled();
    h.unmount();
    const api = { getProviderBootstrap: vi.fn().mockRejectedValue(new Error('offline')) };
    render(<ApiProvider value={api as unknown as ApiClient}><CliSelector onClose={() => {}} /></ApiProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.queryByRole('button', { name: 'Use Claude Code' })).toBeNull();
  });
});
