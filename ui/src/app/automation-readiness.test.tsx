import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from './api-context.js';
import { createApiClient, type ProviderSelectionInfo } from '../lib/api.js';
import { AutomationBoundary, AutomationReadinessProvider } from './automation-readiness.js';
import { CliSection } from '../features/settings/cli-section.js';
import { UNAVAILABLE_FEATURES_KEY } from '../lib/provider-features.js';

afterEach(() => { cleanup(); localStorage.clear(); });

it('shows checking and timeout recovery directly without inventing missing CLI setup', async () => {
  const api = createApiClient();
  let reject!: (error: Error) => void;
  vi.spyOn(api, 'getProviderBootstrap').mockReturnValue(new Promise<ProviderSelectionInfo>((_resolve, fail) => { reject = fail; }));
  render(<ApiProvider value={api}><AutomationReadinessProvider>
    <AutomationBoundary><button>Start agent</button></AutomationBoundary>
  </AutomationReadinessProvider></ApiProvider>);
  expect(screen.getByText('Checking AI readiness')).toBeVisible();
  expect(screen.queryByText('Needs setup')).toBeNull();
  await act(async () => reject(new Error('Request timed out')));
  expect(screen.getByRole('status')).toHaveTextContent('Request timed out');
  expect(screen.getByRole('status').closest('details')).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh automation readiness' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Choose another CLI' })).toBeVisible();
  expect(screen.queryByText('IDE feature readiness')).toBeNull();
  expect(screen.queryByText('Needs setup')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Start agent' })).toBeNull();
});

it('hides unavailable controls by default and reveals them only through Settings without claiming support', async () => {
  const api = createApiClient();
  vi.spyOn(api, 'getProviderBootstrap').mockResolvedValue({
    defaultProvider: 'copilot', selectionRequired: false,
    providers: [{ id: 'copilot', installed: true, automation: { supported: false, reason: 'Policy not verified.' } }],
  });
  const run = vi.fn();
  render(<ApiProvider value={api}><AutomationReadinessProvider>
    <AutomationBoundary><button onClick={run}>Experimental AI action</button></AutomationBoundary>
    <CliSection />
  </AutomationReadinessProvider></ApiProvider>);
  const setting = await screen.findByRole('checkbox', { name: 'Show unavailable IDE features (experimental)' });
  expect(setting).not.toBeChecked();
  expect(screen.queryByRole('button', { name: 'Experimental AI action' })).toBeNull();
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(setting);
  expect(await screen.findByRole('button', { name: 'Experimental AI action' })).toBeEnabled();
  expect(run).not.toHaveBeenCalled();
  await waitFor(() => expect(localStorage.getItem(UNAVAILABLE_FEATURES_KEY)).toBe('true'));
  fireEvent.click(setting);
  expect(screen.queryByRole('button', { name: 'Experimental AI action' })).toBeNull();
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: UNAVAILABLE_FEATURES_KEY, newValue: 'true' })));
  expect(await screen.findByRole('button', { name: 'Experimental AI action' })).toBeEnabled();
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null })));
  expect(screen.queryByRole('button', { name: 'Experimental AI action' })).toBeNull();
});
