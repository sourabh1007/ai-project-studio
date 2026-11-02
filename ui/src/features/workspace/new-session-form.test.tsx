import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { ApiError, createApiClient } from '../../lib/api.js';
import type { Session } from '../../lib/types.js';
import { NewSessionForm } from './new-session-form.js';

function mount(selectionRequired = false, unavailable = false) {
  const api = createApiClient();
  vi.spyOn(api, 'listProviders').mockResolvedValue([
    { id: 'copilot', installed: true },
    { id: 'claude', installed: true },
  ]);
  const bootstrap = vi.spyOn(api, 'getProviderBootstrap').mockResolvedValue({
    defaultProvider: 'copilot', selectionRequired,
    providers: [{ id: 'copilot', installed: true }, { id: 'claude', installed: true }],
  });
  if (unavailable) bootstrap.mockRejectedValue(new Error('CLI status unavailable'));
  const create = vi.spyOn(api, 'createTerminalSession').mockRejectedValue(new Error('Blocked by active CLI policy.'));
  render(<ApiProvider value={api}><NewSessionForm featureId="feature" onCreated={vi.fn()} onCancel={vi.fn()} /></ApiProvider>);
  return { bootstrap, create };
}

afterEach(cleanup);
describe('New session active CLI', () => {
  it('only allows the persisted active installed CLI and displays backend rejection', async () => {
    const h = mount();
    const open = screen.getByRole('button', { name: 'Open session' });
    await waitFor(() => expect(open).not.toBeDisabled());
    expect(screen.queryByRole('option', { name: 'Claude Code' })).toBeNull();
    fireEvent.click(open);
    expect(await screen.findByRole('alert')).toHaveTextContent('Blocked by active CLI policy.');
    expect(h.create).toHaveBeenCalledWith('feature', { providerId: 'copilot', kind: 'dev' }, { operationKey: expect.stringMatching(/^op-/) });
  });

  it('does not silently choose an installed CLI when explicit selection is required', async () => {
    const h = mount(true);
    await screen.findByText(/Select and install an active CLI/);
    expect(screen.getByRole('button', { name: 'Open session' })).toBeDisabled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it('does not fall back to an arbitrary installed CLI when bootstrap is unavailable', async () => {
    const h = mount(false, true);
    expect(await screen.findByRole('alert')).toHaveTextContent('CLI status unavailable');
    expect(screen.getByRole('button', { name: 'Open session' })).toBeDisabled();
    expect(h.create).not.toHaveBeenCalled();
  });
});

function mountForm(over: { onCreated?: (s: Session) => void; onCancel?: () => void } = {}) {
  const api = createApiClient();
  vi.spyOn(api, 'listProviders').mockResolvedValue([{ id: 'copilot', installed: true }]);
  vi.spyOn(api, 'getProviderBootstrap').mockResolvedValue({
    defaultProvider: 'copilot', selectionRequired: false, providers: [{ id: 'copilot', installed: true }],
  });
  const create = vi.spyOn(api, 'createTerminalSession');
  const onCreated = over.onCreated ?? vi.fn();
  const onCancel = over.onCancel ?? vi.fn();
  const view = render(<ApiProvider value={api}><NewSessionForm featureId="feature" onCreated={onCreated} onCancel={onCancel} /></ApiProvider>);
  return { create, onCreated, onCancel, view };
}
const made = { id: 's1' } as Session;
const promptBox = () => screen.getByRole('textbox', { name: /Initial prompt/ });
const ready = () => waitFor(() => expect(screen.getByRole('button', { name: 'Open session' })).not.toBeDisabled());

describe('New session prompt and keyboard UX', () => {
  it('focuses the labelled prompt and sends it through the provider-neutral prompt field', async () => {
    const h = mountForm();
    h.create.mockResolvedValue(made);
    expect(promptBox()).toHaveFocus();
    await ready();
    fireEvent.change(promptBox(), { target: { value: '  fix it  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    await waitFor(() => expect(h.onCreated).toHaveBeenCalledWith(made));
    expect(h.create).toHaveBeenCalledWith('feature', { providerId: 'copilot', kind: 'dev', prompt: 'fix it' }, { operationKey: expect.stringMatching(/^op-/) });
  });

  it('submits with Ctrl or Cmd+Enter once, never during IME composition or before a provider is ready', async () => {
    const h = mountForm();
    const pending = new Promise<Session>(() => {});
    h.create.mockReturnValue(pending);
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true });
    expect(h.create).not.toHaveBeenCalled();
    await ready();
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true, keyCode: 229 });
    fireEvent.keyDown(promptBox(), { key: 'Enter' });
    expect(h.create).not.toHaveBeenCalled();
    fireEvent.keyDown(promptBox(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(promptBox(), { key: 'Enter', ctrlKey: true, repeat: true });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith('feature', { providerId: 'copilot', kind: 'dev' }, { operationKey: expect.stringMatching(/^op-/) });
    expect(promptBox()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('cancels with Escape only when empty and idle', async () => {
    const h = mountForm();
    await ready();
    fireEvent.change(promptBox(), { target: { value: 'keep me' } });
    fireEvent.keyDown(promptBox(), { key: 'Escape' });
    expect(h.onCancel).not.toHaveBeenCalled();
    fireEvent.change(promptBox(), { target: { value: '' } });
    fireEvent.keyDown(promptBox(), { key: 'Escape', isComposing: true });
    expect(h.onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(promptBox(), { key: 'Escape' });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('retains the draft and shows the error after a failed start, then retries once', async () => {
    const h = mountForm();
    h.create.mockRejectedValueOnce(new Error('remote 500')).mockResolvedValueOnce(made);
    await ready();
    fireEvent.change(promptBox(), { target: { value: 'my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('remote 500');
    expect(promptBox()).toHaveValue('my draft');
    expect(promptBox()).not.toHaveAttribute('readonly');
    fireEvent.keyDown(promptBox(), { key: 'Escape' });
    expect(h.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    await waitFor(() => expect(h.onCreated).toHaveBeenCalledTimes(1));
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it('keeps Escape inert while starting and still delivers a session created after unmount', async () => {
    const h = mountForm();
    let resolve!: (s: Session) => void;
    h.create.mockReturnValue(new Promise<Session>((r) => { resolve = r; }));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    fireEvent.keyDown(promptBox(), { key: 'Escape' });
    expect(h.onCancel).not.toHaveBeenCalled();
    h.view.unmount();
    resolve(made);
    await waitFor(() => expect(h.onCreated).toHaveBeenCalledWith(made));
  });

  it('delivers a late failure after unmount without updating state', async () => {
    const h = mountForm();
    let reject!: (e: Error) => void;
    h.create.mockReturnValue(new Promise<Session>((_, r) => { reject = r; }));
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    h.view.unmount();
    reject(new Error('late'));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.onCreated).not.toHaveBeenCalled();
  });
});

describe('New session durable operation key', () => {
  beforeEach(() => window.localStorage.clear());

  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
  const keyOf = (call: unknown[]) => (call[2] as { operationKey: string }).operationKey;

  it('retries a lost response with the same key, then uses a new key for a genuine second create', async () => {
    const h = mountForm();
    h.create.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(made);
    await ready();
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
    open();
    await waitFor(() => expect(h.onCreated).toHaveBeenCalledTimes(1));
    expect(keyOf(h.create.mock.calls[1])).toBe(keyOf(h.create.mock.calls[0]));

    open();
    await waitFor(() => expect(h.onCreated).toHaveBeenCalledTimes(2));
    expect(keyOf(h.create.mock.calls[2])).not.toBe(keyOf(h.create.mock.calls[0]));
  });

  it('keeps the key while a retry is pending and an edited prompt is a new intent', async () => {
    const h = mountForm();
    h.create.mockRejectedValue(new ApiError(409, 'still pending', 'operation_pending'));
    await ready();
    open();
    await screen.findByRole('alert');
    open();
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(2));
    expect(keyOf(h.create.mock.calls[1])).toBe(keyOf(h.create.mock.calls[0]));
    fireEvent.change(promptBox(), { target: { value: 'something else' } });
    open();
    await waitFor(() => expect(h.create).toHaveBeenCalledTimes(3));
    expect(keyOf(h.create.mock.calls[2])).not.toBe(keyOf(h.create.mock.calls[0]));
  });

  it('shows a storage failure and sends nothing', async () => {
    const h = mountForm();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    await ready();
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing was created/);
    expect(h.create).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});