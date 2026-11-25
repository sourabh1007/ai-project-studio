import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { PromptUsage, PromptUsageMarker, OPEN_PROMPT_USAGE_EVENT, type PromptUsageSnapshot } from './prompt-usage.js';

afterEach(cleanup);
const window = { from: '2026-01-01', to: '2026-02-01' };
const empty: PromptUsageSnapshot = { events: [], limited: false, maxEvents: 100 };
const snapshot: PromptUsageSnapshot = { events: [
  { eventId: 'r', promptRefs: ['summarizer.promptTemplate', 'summarizer.sessionTemplate'], sessionId: 's',
    providerId: 'copilot', kind: 'request', state: 'completed', recordedAt: '2026-01-01T10:00:00Z',
    usage: { inputTokens: 10, outputTokens: 2, nanoAiu: 1e9, credits: 1 } },
  { eventId: 'retry', promptRefs: ['summarizer.promptTemplate'], sessionId: 's',
    providerId: 'copilot', kind: 'request', state: 'failed', recordedAt: '2026-01-02T10:00:00Z', usage: null },
  { eventId: 'ctx', promptRefs: ['skills.injectionHeader'], sessionId: 'dev',
    providerId: 'agency', kind: 'context-prepared', state: 'observed', recordedAt: '2026-01-02T11:00:00Z', usage: null },
], limited: true, maxEvents: 3 };
function mount(getPromptUsage = vi.fn().mockResolvedValue(empty), target?: { promptRef: string; nonce: number }) {
  const api = { getPromptUsage } as unknown as ApiClient;
  const view = render(<ApiProvider value={api}><PromptUsage window={window} signal={0} target={target} /></ApiProvider>);
  return { ...view, api, getPromptUsage };
}

it('navigates through an accessible marker without running or saving a prompt', () => {
  const listener = vi.fn();
  globalThis.window.addEventListener(OPEN_PROMPT_USAGE_EVENT, listener);
  render(<PromptUsageMarker promptRef="summarizer.promptTemplate" label="Summary" />);
  fireEvent.click(screen.getByRole('button', { name: 'View Summary prompt usage' }));
  expect(listener.mock.calls[0][0].detail).toBe('summarizer.promptTemplate');
  globalThis.window.removeEventListener(OPEN_PROMPT_USAGE_EVENT, listener);
});

it('charts request participation and measured costs once, keeping failed and prepared events distinct', async () => {
  mount(vi.fn().mockResolvedValue(snapshot));
  expect(await screen.findByText(/2 requests; 1 context preparations; 0 context injections/)).toBeVisible();
  expect(screen.getByText(/latest 3 matching events only/)).toBeVisible();
  expect(screen.getByText(/1.00 AIC \(1\/2 reported\)/)).toHaveTextContent('10 input tokens (1/2 reported)');
  expect(screen.getByRole('img', { name: /Prompt request AIC: 1 measured of 2 points/ })).toBeVisible();
  expect(screen.getByRole('img', { name: /Prompt request input tokens: 1 measured of 2 points/ })).toBeVisible();
  expect(screen.getByLabelText('Prompt activity by UTC day')).toHaveTextContent('2 events');
  fireEvent.click(screen.getByText('About prompt attribution'));
  expect(screen.getByText(/older requests are unattributed, not zero usage/)).toBeVisible();
});

it('filters by navigation target and timeframe, refreshes explicitly and ignores aborted stale results', async () => {
  let resolve!: (value: PromptUsageSnapshot) => void;
  const get = vi.fn().mockImplementationOnce(() => new Promise<PromptUsageSnapshot>((done) => { resolve = done; }))
    .mockResolvedValue(empty);
  const { rerender, api } = mount(get, { promptRef: 'summarizer.promptTemplate', nonce: 1 });
  expect(get.mock.calls[0][0]).toEqual({
    from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', promptRef: 'summarizer.promptTemplate',
  });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'skills.injectionHeader' } });
  await screen.findByText(/No attributed events/);
  expect(get.mock.calls[0][1].aborted).toBe(true);
  await act(async () => { resolve(snapshot); });
  expect(screen.queryByText(/latest 3 matching events/)).toBeNull();
  rerender(<ApiProvider value={api}><PromptUsage window={{ from: '2026-01-02', to: '2026-01-03' }}
    signal={1} target={{ promptRef: 'settings-assistant-prompt', nonce: 2 }} /></ApiProvider>);
  await waitFor(() => expect(get).toHaveBeenLastCalledWith({
    from: '2026-01-02T00:00:00.000Z', to: '2026-01-03T00:00:00.000Z', promptRef: 'settings-assistant-prompt',
  }, expect.any(AbortSignal)));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh prompt usage' }));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(5));
});

it('reports read failures without claiming zero use and permits a retry', async () => {
  const get = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(empty);
  mount(get);
  expect(await screen.findByRole('alert')).toHaveTextContent('offline');
  expect(screen.queryByText(/0 requests/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh prompt usage' }));
  expect(await screen.findByText(/No attributed events/)).toBeVisible();
  expect(screen.getByText(/Unavailable AIC/)).toBeVisible();
});
