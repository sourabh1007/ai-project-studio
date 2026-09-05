import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { MetaSettings } from '../../lib/types.js';
import { MetaModelStatus } from './meta-model-status.js';

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  const settings: MetaSettings = {
    providerId: 'agency',
    model: 'auto',
    warmPoolEnabled: true,
  };
  return {
    getMetaSettings: vi.fn().mockResolvedValue(settings),
    listProviders: vi
      .fn()
      .mockResolvedValue([{ id: 'agency' }, { id: 'copilot' }]),
    listModels: vi
      .fn()
      .mockResolvedValue([{ id: 'gpt-5', label: 'GPT-5' }]),
    getMetaModels: vi.fn().mockResolvedValue([]),
    getMetaPools: vi.fn().mockResolvedValue(null),
    updateMetaSettings: vi.fn().mockResolvedValue({
      providerId: 'copilot',
      model: 'gpt-5',
      warmPoolEnabled: true,
    }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderStatus(api: ApiClient) {
  return render(
    <ApiProvider value={api}>
      <MetaModelStatus />
    </ApiProvider>,
  );
}

describe('MetaModelStatus', () => {
  it('renders the current provider and model label', async () => {
    renderStatus(client());
    expect(await screen.findByText('Agency · Auto')).toBeInTheDocument();
  });

  it('opens the picker and applies a provider + model change', async () => {
    const api = client();
    renderStatus(api);
    fireEvent.click(await screen.findByRole('button', { name: /Agency · Auto/ }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(api.listModels).toHaveBeenCalledWith('agency'));

    const [providerSelect, modelSelect] = screen.getAllByRole('combobox');
    fireEvent.change(providerSelect, { target: { value: 'copilot' } });
    await waitFor(() =>
      expect(api.listModels).toHaveBeenCalledWith('copilot'),
    );
    fireEvent.change(modelSelect, { target: { value: 'gpt-5' } });

    expect(
      screen.getByText(/warm pool uses the/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(api.updateMetaSettings).toHaveBeenCalledWith({
        providerId: 'copilot',
        model: 'gpt-5',
      }),
    );
    expect(await screen.findByText('Copilot · gpt-5')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows an error when applying fails and keeps the picker open', async () => {
    const api = client({
      updateMetaSettings: vi.fn().mockRejectedValue(new Error('boom')),
    });
    renderStatus(api);
    fireEvent.click(await screen.findByRole('button', { name: /Agency · Auto/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(/Could not update the AI model/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders nothing until settings load', () => {
    const api = client({
      getMetaSettings: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    const { container } = renderStatus(api);
    expect(container.querySelector('.statusbar-meta')).toBeNull();
  });
});
