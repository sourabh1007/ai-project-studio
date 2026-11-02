import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { createApiClient } from '../../lib/api.js';
import type { Feature, NewTaskAgent, NewTaskRun, Session } from '../../lib/types.js';
import { NewTaskPage } from './new-task-page.js';

vi.mock('../../hooks/use-agent-usage.js', () => ({
  useAgentUsage: () => ({ snapshots: [], loading: false, error: false, operations: [] }),
}));
vi.mock('../../components/feature-agent-usage.js', () => ({
  AgentUsageValue: () => <span>usage</span>,
}));

const feature = { id: 'f1', name: 'Feature one' } as Feature;
const otherFeature = { id: 'f2', name: 'Feature two' } as Feature;
const draftKey = (id: string, part: string) => `cw-new-task-draft:${id}:att:${part}`;

const agent: NewTaskAgent = {
  id: 'a1', parentId: null, role: 'developer', title: 'Dev agent', files: ['src/a.ts'],
  status: 'done', startedAt: null, durationMs: 10, inputTokens: 1, outputTokens: 2, credits: 1,
};
function run(over: Partial<NewTaskRun> = {}): NewTaskRun {
  return {
    id: 'r', featureId: 'f1', problem: '', context: '', plan: null, status: 'draft', branch: null,
    prNumber: null, prUrl: null, reviewFeatureId: null, error: null, agents: [], planLog: [],
    title: null, summary: null, createdAt: '', updatedAt: '', ...over,
  };
}
const created = { id: 'new-session', name: null, prompt: 'p', kind: 'dev', seq: 3 } as unknown as Session;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(initial: NewTaskRun | null = null, props: Partial<Parameters<typeof NewTaskPage>[0]> = {}) {
  const api = createApiClient();
  const spies = {
    get: vi.spyOn(api, 'getNewTask').mockResolvedValue({ run: initial }),
    save: vi.spyOn(api, 'saveNewTaskInputs').mockResolvedValue(run()),
    plan: vi.spyOn(api, 'planNewTask').mockImplementation(() => new Promise<void>(() => {})),
    stream: vi.spyOn(api, 'streamNewTask').mockImplementation(() => new Promise<void>(() => {})),
    cancel: vi.spyOn(api, 'cancelNewTask').mockResolvedValue({ cancelled: true, run: run() }),
    diff: vi.spyOn(api, 'getNewTaskFileDiff').mockResolvedValue({ path: 'src/a.ts', diff: '+x', content: 'x' }),
    session: vi.spyOn(api, 'createTerminalSession').mockResolvedValue(created),
  };
  const ui = (f: Feature) => (
    <ApiProvider value={api}><NewTaskPage feature={f} attachmentId="att" {...props} /></ApiProvider>
  );
  const view = render(ui(feature));
  return { api, spies, view, ui };
}

const problemBox = () => screen.findByRole('textbox', { name: /Problem statement/ });

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('New Task drafts', () => {
  it('restores unsaved problem and context after leaving and returning', async () => {
    const first = setup();
    fireEvent.change(await problemBox(), { target: { value: 'Fix flaky login' } });
    fireEvent.change(screen.getByRole('textbox', { name: /Context/ }), { target: { value: 'see auth.ts' } });
    first.view.unmount();

    setup();
    expect(await problemBox()).toHaveValue('Fix flaky login');
    expect(screen.getByRole('textbox', { name: /Context/ })).toHaveValue('see auth.ts');
    expect(screen.getByRole('status')).toHaveTextContent('Restored your unsaved draft');
  });

  it('scopes drafts per feature and attachment', async () => {
    const first = setup();
    fireEvent.change(await problemBox(), { target: { value: 'only for f1' } });
    first.view.rerender(first.ui(otherFeature));
    await waitFor(() => expect(first.spies.get).toHaveBeenCalledWith('f2', 'att'));
    expect(await problemBox()).toHaveValue('');
    expect(window.localStorage.getItem(draftKey('f1', 'problem'))).toContain('only for f1');
  });

  it('late hydration does not overwrite a restored dirty draft but fills an untouched field', async () => {
    window.localStorage.setItem(
      draftKey('f1', 'problem'),
      JSON.stringify({ value: 'local edit', savedAt: 'now' }),
    );
    const slow = deferred<{ run: NewTaskRun | null }>();
    const api = createApiClient();
    vi.spyOn(api, 'getNewTask').mockReturnValue(slow.promise);
    render(<ApiProvider value={api}><NewTaskPage feature={feature} attachmentId="att" /></ApiProvider>);
    await act(async () => slow.resolve({ run: run({ problem: 'server problem', context: 'server ctx' }) }));
    expect(await problemBox()).toHaveValue('local edit');
    expect(screen.getByRole('textbox', { name: /Context/ })).toHaveValue('server ctx');
  });

  it('warns when the local backup is blocked, keeps the text, and does not blame the backend', async () => {
    const h = setup();
    const box = await problemBox();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    fireEvent.change(box, { target: { value: 'unbacked text' } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Draft is not being backed up');
    expect(alert).toHaveTextContent('copied');
    expect(box).toHaveValue('unbacked text');
    expect(h.spies.save).not.toHaveBeenCalled();
    setItem.mockRestore();
    fireEvent.change(box, { target: { value: 'backed up again' } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('keeps the backup of text typed while the save is in flight', async () => {
    const h = setup();
    const box = await problemBox();
    const saving = deferred<NewTaskRun>();
    h.spies.save.mockReturnValue(saving.promise);
    fireEvent.change(box, { target: { value: 'saved text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Plan change' }));
    fireEvent.click(await screen.findByRole('button', { name: /Describe/ }));
    fireEvent.change(await problemBox(), { target: { value: 'saved text + newer' } });
    await act(async () => saving.resolve(run()));
    expect(window.localStorage.getItem(draftKey('f1', 'problem'))).toContain('saved text + newer');
  });

  it('clears the draft once inputs are saved to plan and keeps save errors visible', async () => {
    const h = setup();
    fireEvent.change(await problemBox(), { target: { value: 'Plan me' } });
    expect(window.localStorage.getItem(draftKey('f1', 'problem'))).toContain('Plan me');
    h.spies.save.mockRejectedValueOnce(new Error('save exploded'));
    fireEvent.click(screen.getByRole('button', { name: 'Plan change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('save exploded');
    expect(window.localStorage.getItem(draftKey('f1', 'problem'))).toContain('Plan me');
    expect(h.spies.plan).not.toHaveBeenCalled();
  });
});

describe('New Task keyboard and read-only semantics', () => {
  it('plans once with Ctrl or Cmd+Enter but not while composing, repeating or empty', async () => {
    const h = setup();
    const box = await problemBox();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(h.spies.save).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'Do it' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, keyCode: 229 });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, repeat: true });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(h.spies.save).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(h.spies.plan).toHaveBeenCalledTimes(1));
    expect(h.spies.save).toHaveBeenCalledTimes(1);
    expect(h.spies.save).toHaveBeenCalledWith('f1', 'att', { problem: 'Do it', context: '' });
  });

  it('uses readOnly rather than disabled while a run is active', async () => {
    setup(run({ status: 'planning', problem: 'P' }));
    fireEvent.click(await screen.findByRole('button', { name: /Describe/ }));
    const box = await problemBox();
    expect(box).toHaveAttribute('readonly');
    expect(box).not.toBeDisabled();
    box.focus();
    expect(box).toHaveFocus();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(screen.getByRole('textbox', { name: /Base branch/ })).toHaveAttribute('readonly');
  });
});

describe('New Task cancellation', () => {
  async function openActive() {
    const h = setup(run({ status: 'planning', problem: 'P' }));
    const controller: { signal?: AbortSignal } = {};
    h.spies.stream.mockImplementation(async (_f, _a, _cb, signal) => {
      controller.signal = signal;
      await new Promise<void>(() => {});
    });
    const button = await screen.findByRole('button', { name: /Cancel & reset/ });
    await waitFor(() => expect(controller.signal).toBeDefined());
    return { h, button, controller };
  }

  it('keeps the live stream and busy state when cancellation is rejected', async () => {
    const { h, button, controller } = await openActive();
    h.spies.cancel.mockRejectedValueOnce(new Error('server 500'));
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('server 500');
    expect(controller.signal?.aborted).toBe(false);
    expect(screen.getByRole('status')).toHaveTextContent('analysing the problem');
    expect(screen.getByRole('button', { name: /Cancel & reset/ })).toBeEnabled();
  });

  it('ignores repeated clicks and resets only after the backend confirms', async () => {
    const { h, button, controller } = await openActive();
    const pending = deferred<{ cancelled: boolean; run: NewTaskRun | null }>();
    h.spies.cancel.mockReturnValue(pending.promise);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(h.spies.cancel).toHaveBeenCalledTimes(1);
    expect(controller.signal?.aborted).toBe(false);
    await act(async () => pending.resolve({ cancelled: true, run: run() }));
    expect(controller.signal?.aborted).toBe(true);
    expect(await problemBox()).toBeInTheDocument();
  });
});

describe('New Task dialogs', () => {
  const planned = () => run({ status: 'pr-created', plan: 'plan', branch: 'b', prNumber: 1, agents: [agent], problem: 'Do X', context: 'Ctx' });

  it('opens agent activity in the shared modal that closes with Escape and restores focus', async () => {
    setup(planned());
    const opener = await screen.findByRole('button', { name: /Dev agent/ });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Dev agent activity' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('No activity captured');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('shows file diffs in the shared modal, toggles full file, reports errors and ignores stale loads', async () => {
    const h = setup(planned());
    const slow = deferred<{ path: string; diff: string; content: string }>();
    h.spies.diff.mockReturnValueOnce(slow.promise);
    const chip = await screen.findByRole('button', { name: /src\/a\.ts/ });
    fireEvent.click(chip);
    const dialog = await screen.findByRole('dialog', { name: 'src/a.ts diff' });
    expect(dialog).toHaveTextContent('Loading diff');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => slow.resolve({ path: 'src/a.ts', diff: '+stale', content: 'stale' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(chip);
    const reopened = await screen.findByRole('dialog', { name: 'src/a.ts diff' });
    await waitFor(() => expect(reopened).toHaveTextContent('+x'));
    fireEvent.click(screen.getByRole('button', { name: 'Show full file' }));
    expect(screen.getByRole('button', { name: 'Show diff' })).toBeInTheDocument();
    fireEvent.keyDown(reopened, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    h.spies.diff.mockRejectedValueOnce(new Error('diff failed'));
    fireEvent.click(chip);
    expect(await screen.findByText('diff failed')).toBeInTheDocument();
  });
});

describe('New Task session start', () => {
  const finished = () => run({ status: 'pr-created', plan: 'plan', branch: 'b', prNumber: 1, problem: 'Do X', context: 'Ctx' });

  it('opens the created session in the host with the problem prompt, once', async () => {
    const openSession = vi.fn();
    const h = setup(finished(), { openSession });
    const pending = deferred<Session>();
    h.spies.session.mockReturnValue(pending.promise);
    const button = await screen.findByRole('button', { name: 'New session' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(h.spies.session).toHaveBeenCalledTimes(1);
    expect(h.spies.session).toHaveBeenCalledWith('f1', { kind: 'dev', prompt: 'Do X\n\nContext:\nCtx' }, { operationKey: expect.stringMatching(/^op-/) });
    await act(async () => pending.resolve(created));
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledWith(created, expect.any(String));
    expect(await screen.findByText(/Opened the new session/)).toBeInTheDocument();
  });

  it('falls back to a note without a host and omits an empty prompt', async () => {
    const h = setup(run({ status: 'pr-created', plan: 'plan', branch: 'b', prNumber: 1 }));
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
    expect(await screen.findByText('Started session new-session.')).toBeInTheDocument();
    expect(h.spies.session).toHaveBeenCalledWith('f1', { kind: 'dev' }, { operationKey: expect.stringMatching(/^op-/) });
  });

  it('shows start errors and allows a retry', async () => {
    const h = setup(finished());
    h.spies.session.mockRejectedValueOnce(new Error('blocked'));
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('blocked');
    h.spies.session.mockRejectedValueOnce('plain failure');
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(await screen.findByText('plain failure')).toBeInTheDocument();
  });

  it('retries a lost response with the same key and gives a genuine second start a new key', async () => {
    window.localStorage.clear();
    const h = setup(finished());
    h.spies.session.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(created);
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    await waitFor(() => expect(h.spies.session).toHaveBeenCalledTimes(2));
    await screen.findByText(/Started session/);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    await waitFor(() => expect(h.spies.session).toHaveBeenCalledTimes(3));
    const keys = h.spies.session.mock.calls.map((call) => (call[2] as { operationKey: string }).operationKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('shows a storage failure and sends nothing', async () => {
    window.localStorage.clear();
    const h = setup(finished());
    const failing = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/nothing was created/);
    expect(h.spies.session).not.toHaveBeenCalled();
    failing.mockRestore();
  });
  it('does not navigate when the page was switched to another feature before the result', async () => {
    const openSession = vi.fn();
    const h = setup(finished(), { openSession });
    const pending = deferred<Session>();
    h.spies.session.mockReturnValue(pending.promise);
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
    h.view.rerender(h.ui(otherFeature));
    await act(async () => pending.resolve(created));
    expect(openSession).not.toHaveBeenCalled();
  });

  it('swallows a late failure after unmount', async () => {
    const h = setup(finished());
    const rejected = deferred<Session>();
    h.spies.session.mockReturnValue(rejected.promise);
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
    h.view.unmount();
    await act(async () => rejected.reject(new Error('late')));
  });
});
