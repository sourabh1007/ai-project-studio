import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { SettingsView } from './settings-view.js';
import type { ApiClient } from '../../lib/api.js';
import type { ConfigResponse, ConfigUpdateResult, FieldMeta } from '../../lib/types.js';

vi.mock('../updates/software-update-section.js', () => ({
  SoftwareUpdateSection: () => null,
}));
vi.mock('./agency-cli-section.js', () => ({
  AgencyCliSection: () => null,
}));
vi.mock('./appearance-section.js', () => ({
  AppearanceSection: () => null,
}));
vi.mock('./network-activity-section.js', () => ({
  NetworkActivitySection: () => null,
}));
vi.mock('./diagnostics-section.js', () => ({
  DiagnosticsSection: () => null,
}));
vi.mock('./worktrees-section.js', () => ({
  WorktreesSection: () => null,
}));
vi.mock('./metasession-pools-section.js', () => ({
  MetasessionPoolsSection: () => null,
}));
vi.mock('../shared-context/shared-context-panel.js', () => ({
  SharedContextPanel: () => null,
}));

function config(current: ConfigResponse['current']): ConfigResponse {
  return {
    namespaces: Object.keys(current),
    defaults: Object.fromEntries(
      Object.entries(current).map(([namespace, values]) => [namespace, values]),
    ),
    schema: {
      meta: {
        kind: 'object',
        fields: { mode: { kind: 'string' } },
      },
      providers: {
        kind: 'object',
        fields: {
          model: { kind: 'string' },
          region: { kind: 'string' },
        },
      },
    },
    current,
    overrides: { meta: {}, providers: {} },
  };
}

function renderSettings(client: Partial<ApiClient>) {
  return render(
    <ApiProvider value={client as ApiClient}>
      <SettingsView />
    </ApiProvider>,
  );
}

function configWithSchema(
  current: ConfigResponse['current'],
  schema: Record<string, FieldMeta>,
): ConfigResponse {
  return {
    namespaces: Object.keys(current),
    defaults: Object.fromEntries(
      Object.entries(current).map(([namespace, values]) => [namespace, values]),
    ),
    schema,
    current,
    overrides: Object.fromEntries(
      Object.keys(current).map((namespace) => [namespace, {}]),
    ),
  };
}

describe('SettingsView drafts', () => {
  it('mounts manual retained-image management in Diagnostics and refreshes when reopened', async () => {
    const list = vi.fn().mockResolvedValue({
      status: 'ready', items: [], totalBytes: 0,
      limits: { files: 64, totalBytes: 67108864, fileBytes: 8388608 },
    });
    (window as unknown as { desktop: unknown }).desktop = { attachments: {
      list, remove: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    } };
    renderSettings({ getConfig: vi.fn().mockResolvedValue(config({ meta: { mode: 'warm' } })) });
    fireEvent.click(await screen.findByRole('tab', { name: 'Diagnostics' }));
    expect(await screen.findByRole('region', { name: 'Retained clipboard images' })).toBeInTheDocument();
    expect(await screen.findByText('No retained clipboard images.')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Diagnostics' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('mounts saved AI operations in the Metasession tab using the active API provider', async () => {
    const listMetaOperations = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    renderSettings({
      getConfig: vi.fn().mockResolvedValue(config({ meta: { mode: 'warm' } })),
      listMetaOperations,
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Metasession' }));
    expect(await screen.findByRole('region', { name: 'Saved AI operations' })).toBeTruthy();
    expect(await screen.findByText('No saved operations.')).toBeTruthy();
    expect(listMetaOperations).toHaveBeenCalled();
  });

  afterEach(() => {
    delete (window as unknown as { desktop?: unknown }).desktop;
  });
  beforeEach(() => {
    window.localStorage.clear();
  });

  it.each([false, 'reject'] as const)('re-enables restart after an unconfirmed result (%s)', async (failure) => {
    let finish!: (confirmed: boolean) => void;
    const relaunch = vi.fn().mockImplementationOnce(() => failure === 'reject'
      ? Promise.reject(new Error('private backend detail'))
      : Promise.resolve(false))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    (window as unknown as { desktop: unknown }).desktop = { relaunch };
    const current = config({ meta: { mode: 'warm' } });
    const client: Partial<ApiClient> = {
      getConfig: vi.fn().mockResolvedValue(current),
      updateConfig: vi.fn().mockResolvedValue({
        namespace: 'meta', effective: { mode: 'cool' }, override: { mode: 'cool' }, requiresRestart: true,
      } satisfies ConfigUpdateResult),
    };
    renderSettings(client);
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    fireEvent.change(await screen.findByDisplayValue('warm'), { target: { value: 'cool' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Restart not confirmed');
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeEnabled();
    expect(screen.queryByText('private backend detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    expect(screen.getByRole('button', { name: /Restarting/ })).toBeDisabled();
    finish(true);
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps dirty namespaces across unrelated saves, shows conflicts and discards explicitly', async () => {
    const first = config({
      meta: { mode: 'warm' },
      providers: { model: 'gpt-5.5', region: 'east' },
    });
    const second = config({
      meta: { mode: 'cool' },
      providers: { model: 'server-model', region: 'west' },
    });
    const update: ConfigUpdateResult = {
      namespace: 'meta',
      effective: { mode: 'cool' },
      override: { mode: 'cool' },
      requiresRestart: false,
    };
    const client: Partial<ApiClient> = {
      getConfig: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      updateConfig: vi.fn().mockResolvedValue(update),
      resetConfig: vi.fn(),
      askSettingsAssistant: vi.fn(),
    };

    renderSettings(client);
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));

    const metaCard = await screen.findByText('Meta');
    const providersCard = await screen.findByText('Providers');

    fireEvent.change(
      within(metaCard.closest('.config-module-card') as HTMLElement).getByDisplayValue(
        'warm',
      ),
      { target: { value: 'cool' } },
    );
    fireEvent.change(
      within(
        providersCard.closest('.config-module-card') as HTMLElement,
      ).getByDisplayValue('gpt-5.5'),
      { target: { value: 'mine' } },
    );

    fireEvent.click(
      within(metaCard.closest('.config-module-card') as HTMLElement).getByRole(
        'button',
        { name: 'Save' },
      ),
    );

    await waitFor(() =>
      expect(client.updateConfig).toHaveBeenCalledWith('meta', { mode: 'cool' }),
    );

    const refreshedProviders = await screen.findByText('Providers');
    const providerCard = refreshedProviders.closest('.config-module-card') as HTMLElement;
    expect(within(providerCard).getByDisplayValue('mine')).toBeInTheDocument();
    expect(within(providerCard).getByDisplayValue('west')).toBeInTheDocument();
    expect(
      within(providerCard).getByText(/Server updates conflict with your unsaved change/i),
    ).toBeInTheDocument();

    fireEvent.click(
      within(providerCard).getByRole('button', {
        name: 'Discard conflicting changes',
      }),
    );
    await waitFor(() =>
      expect(within(providerCard).getByDisplayValue('server-model')).toBeInTheDocument(),
    );
  });

  it('restores an unsaved namespace draft after the view remounts', async () => {
    const client: Partial<ApiClient> = {
      getConfig: vi.fn().mockResolvedValue(
        config({
          meta: { mode: 'warm' },
          providers: { model: 'gpt-5.5', region: 'east' },
        }),
      ),
      updateConfig: vi.fn(),
      resetConfig: vi.fn(),
      askSettingsAssistant: vi.fn(),
    };

    const first = renderSettings(client);
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    const providersCard = await screen.findByText('Providers');
    fireEvent.change(
      within(
        providersCard.closest('.config-module-card') as HTMLElement,
      ).getByDisplayValue('gpt-5.5'),
      { target: { value: 'claude-opus' } },
    );
    expect(screen.getAllByText('Unsaved changes').length).toBeGreaterThan(0);
    first.unmount();

    renderSettings(client);
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    const restoredCard = await screen.findByText('Providers');
    expect(
      within(
        restoredCard.closest('.config-module-card') as HTMLElement,
      ).getByDisplayValue('claude-opus'),
    ).toBeInTheDocument();
  });
});

describe('SettingsView field accessibility', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('binds labels, descriptions, and unique ids for every mounted control type', async () => {
    const payload = configWithSchema(
      {
        meta: {
          enabled: true,
          mode: 'warm',
          region: 'east',
          maxRetries: 2,
          allowedModels: ['gpt-5.5'],
          webhookConfig: { retries: 2 },
          'retry.policy.maxAttempts': 3,
        },
        providers: {
          mode: 'balanced',
        },
      },
      {
        meta: {
          kind: 'object',
          fields: {
            enabled: { kind: 'boolean', description: 'Enable the warm pool.' },
            mode: { kind: 'string', description: 'How warm sessions are managed.' },
            region: {
              kind: 'enum',
              description: 'Choose the default region.',
              options: ['east', 'west'],
            },
            maxRetries: {
              kind: 'number',
              description: 'Maximum retry count.',
              min: 1,
              int: true,
            },
            allowedModels: {
              kind: 'array',
              description: 'Models allowed for this pool.',
            },
            webhookConfig: {
              kind: 'object',
              description: 'Structured webhook settings.',
            },
            'retry.policy.maxAttempts': {
              kind: 'number',
              description: 'Nested retry limit.',
              min: 1,
              int: true,
            },
          },
        },
        providers: {
          kind: 'object',
          fields: {
            mode: { kind: 'string', description: 'Provider selection mode.' },
          },
        },
      },
    );
    const client: Partial<ApiClient> = {
      getConfig: vi.fn().mockResolvedValue(payload),
      updateConfig: vi.fn(),
      resetConfig: vi.fn(),
      askSettingsAssistant: vi.fn(),
    };

    const first = renderSettings(client);
    const second = renderSettings(client);
    for (const tab of screen.getAllByRole('tab', { name: 'Configuration' })) {
      fireEvent.click(tab);
    }

    const metaCard = (await screen.findAllByText('Meta'))[0].closest(
      '.config-module-card',
    ) as HTMLElement;
    const enabled = within(metaCard).getByRole('checkbox', { name: 'Enabled' });
    const modeInputs = screen.getAllByRole('textbox', { name: 'Mode' });
    const region = within(metaCard).getByRole('combobox', { name: 'Region' });
    const maxRetries = within(metaCard).getByRole('spinbutton', {
      name: 'Max Retries',
    });
    const allowedModels = within(metaCard).getByRole('textbox', {
      name: 'Allowed Models',
    });
    const webhookConfig = within(metaCard).getByRole('textbox', {
      name: 'Webhook Config',
    });
    const nestedLimit = within(metaCard).getByRole('spinbutton', {
      name: 'Retry Policy Max Attempts',
    });

    expect(enabled).toHaveAccessibleName('Enabled');
    expect(enabled).toHaveAccessibleDescription('Enable the warm pool.');
    expect(region).toHaveAccessibleDescription('Choose the default region.');
    expect(maxRetries).toHaveAccessibleDescription('Maximum retry count.');
    expect(allowedModels).toHaveAccessibleDescription('Models allowed for this pool.');
    expect(webhookConfig).toHaveAccessibleDescription('Structured webhook settings.');
    expect(nestedLimit).toHaveAccessibleDescription('Nested retry limit.');
    expect(modeInputs).toHaveLength(4);

    const ids = [
      enabled.id,
      region.id,
      maxRetries.id,
      allowedModels.id,
      webhookConfig.id,
      nestedLimit.id,
      ...modeInputs.map((input) => input.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(maxRetries.id).toContain('meta-maxretries');
    expect(nestedLimit.id).toContain('meta-retry-policy-maxattempts');
    expect(modeInputs.some((input) => input.id.includes('providers-mode'))).toBe(true);

    first.unmount();
    second.unmount();
  });

  it('associates inline validation errors with the offending field without breaking save flow', async () => {
    const payload = configWithSchema(
      {
        meta: {
          maxRetries: 2,
          webhookConfig: { retries: 2 },
        },
      },
      {
        meta: {
          kind: 'object',
          fields: {
            maxRetries: {
              kind: 'number',
              description: 'Maximum retry count.',
              min: 1,
              int: true,
            },
            webhookConfig: {
              kind: 'object',
              description: 'Structured webhook settings.',
            },
          },
        },
      },
    );
    const client: Partial<ApiClient> = {
      getConfig: vi.fn().mockResolvedValue(payload),
      updateConfig: vi.fn(),
      resetConfig: vi.fn(),
      askSettingsAssistant: vi.fn(),
    };

    renderSettings(client);
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));

    const metaCard = (await screen.findByText('Meta')).closest(
      '.config-module-card',
    ) as HTMLElement;
    const retries = within(metaCard).getByRole('spinbutton', {
      name: 'Max Retries',
    });
    fireEvent.change(retries, { target: { value: '0' } });

    const fieldError = within(metaCard).getByText('Must be at least 1.');
    expect(retries).toHaveAttribute('aria-invalid', 'true');
    expect(retries.getAttribute('aria-describedby')).toContain(fieldError.id);

    fireEvent.click(within(metaCard).getByRole('button', { name: 'Save' }));
    expect(client.updateConfig).not.toHaveBeenCalled();
    expect(within(metaCard).getByRole('alert')).toHaveTextContent(
      'Fix the highlighted setting values before saving.',
    );

    const jsonField = within(metaCard).getByRole('textbox', {
      name: 'Webhook Config',
    });
    fireEvent.change(jsonField, { target: { value: '{bad json' } });
    const jsonError = within(metaCard).getByText(/Unexpected token|Expected property name/i);
    expect(jsonField).toHaveAttribute('aria-invalid', 'true');
    expect(jsonField.getAttribute('aria-describedby')).toContain(jsonError.id);
  });
});
