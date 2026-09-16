import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { ConfigResponse } from '../../lib/types.js';
import { PROMPT_CATALOG } from './prompts-catalog.js';
import { promptAnchorId } from './prompts-nav.js';
import { PromptsCommandsSection } from './prompts-commands-section.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function config(): ConfigResponse {
  const defaults: ConfigResponse['defaults'] = {};
  for (const section of PROMPT_CATALOG) {
    for (const field of section.fields) {
      defaults[field.namespace] ??= {};
      defaults[field.namespace][field.key] = `${field.label} default`;
    }
  }
  return {
    namespaces: Object.keys(defaults),
    defaults,
    current: defaults,
    overrides: {},
  };
}

function api(data = config()) {
  return {
    getConfig: vi.fn().mockResolvedValue(data),
    updateConfig: vi.fn().mockResolvedValue({}),
  } satisfies Partial<ApiClient>;
}

it('renders the prompts heading by default', async () => {
  const client = api();
  render(<ApiProvider value={client as unknown as ApiClient}><PromptsCommandsSection /></ApiProvider>);
  expect(screen.getByRole('heading', { name: 'Prompts & Commands' })).toBeInTheDocument();
  expect(await screen.findByText('Task Plans')).toBeInTheDocument();
});

it('renders prompt editors without the heading when embedded and saves edits', async () => {
  const client = api();
  render(<ApiProvider value={client as unknown as ApiClient}><PromptsCommandsSection embedded /></ApiProvider>);
  expect(screen.queryByRole('heading', { name: 'Prompts & Commands' })).toBeNull();
  expect(await screen.findByText('Feature task-plan generation')).toBeInTheDocument();
  expect(screen.getByText(/Every prompt and command the IDE sends/)).toBeInTheDocument();
  const editor = screen.getByLabelText('Feature task-plan generation prompt template');
  fireEvent.change(editor, { target: { value: 'custom prompt' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
  await waitFor(() => expect(client.updateConfig).toHaveBeenCalledWith('featureTasks', { promptTemplate: 'custom prompt' }));
});

it('keeps prompt deep links working when embedded', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const anchor = promptAnchorId('featureTasks', 'promptTemplate');
  render(<ApiProvider value={api() as unknown as ApiClient}><PromptsCommandsSection embedded focusAnchor={anchor} /></ApiProvider>);
  await screen.findByLabelText('Feature task-plan generation prompt template');
  await act(async () => {});
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
});
