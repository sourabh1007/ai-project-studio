import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { ConfigResponse } from '../../lib/types.js';
import { PROMPT_CATALOG } from './prompts-catalog.js';
import { promptAnchorId } from './prompts-nav.js';
import { PromptsCommandsSection } from './prompts-commands-section.js';
import { OPEN_PROMPT_USAGE_EVENT } from '../usage/prompt-usage.js';

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

it('adds read-only Usage links to every catalog prompt without starting AI or changing settings', async () => {
  const client = api();
  const navigation = vi.fn();
  window.addEventListener(OPEN_PROMPT_USAGE_EVENT, navigation);
  try {
    render(<ApiProvider value={client as unknown as ApiClient}><PromptsCommandsSection /></ApiProvider>);
    await screen.findByText('Task Plans');
    for (const section of PROMPT_CATALOG) {
      for (const field of section.fields) {
        fireEvent.click(screen.getByRole('button', { name: `View ${field.label} prompt usage` }));
        expect(navigation.mock.calls.at(-1)?.[0].detail).toBe(`${field.namespace}.${field.key}`);
      }
      for (const entry of section.readOnly ?? []) {
        fireEvent.click(screen.getByRole('button', { name: `View ${entry.label} prompt usage` }));
        expect(navigation.mock.calls.at(-1)?.[0].detail).toBe(entry.id);
      }
    }
    expect(client.updateConfig).not.toHaveBeenCalled();
  } finally { window.removeEventListener(OPEN_PROMPT_USAGE_EVENT, navigation); }
});

it('renders prompt editors without the heading when embedded and saves edits', async () => {
  const client = api();
  render(<ApiProvider value={client as unknown as ApiClient}><PromptsCommandsSection embedded /></ApiProvider>);
  expect(screen.queryByRole('heading', { name: 'Prompts & Commands' })).toBeNull();
  expect(await screen.findByText('Feature task-plan generation')).toBeInTheDocument();
  expect(screen.getByText(/Every prompt and command the IDE sends/)).toBeInTheDocument();
  const editor = screen.getByLabelText('Feature task-plan generation prompt template');
  fireEvent.change(editor, { target: { value: 'custom prompt' } });
  // Scope the Save click to this field's own entry (not a positional [0], which
  // is order-fragile) and wait until the edit has marked it dirty/enabled before
  // clicking — otherwise a slow render can click a still-disabled button, which
  // is a no-op and never calls updateConfig.
  const entry = editor.closest('.prompt-entry') as HTMLElement;
  const save = within(entry).getByRole('button', { name: 'Save' });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
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
