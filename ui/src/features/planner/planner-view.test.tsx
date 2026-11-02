import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import { ApiError, type ApiClient } from '../../lib/api.js';
import type { Session } from '../../lib/types.js';
import type { PlannerTask, Repository } from '../../lib/types.js';
import { addDays, todayIso } from '../../lib/planner-dates.js';
import { actionsForTask, PlannerView } from './planner-view.js';
import { AutomationReadinessProvider } from '../../app/automation-readiness.js';

function task(overrides: Partial<PlannerTask> = {}): PlannerTask {
  return {
    id: 't1',
    title: 'Fix the login bug',
    notes: '',
    priority: 'p2',
    status: 'open',
    kind: 'task',
    prUrl: '',
    date: todayIso(),
    repoId: null,
    launchKind: null,
    featureId: null,
    sessionId: null,
    launchLabel: null,
    backloggedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('actionsForTask', () => {
  it('leads with Review and offers the rest for a PR task', () => {
    expect(
      actionsForTask(task({ kind: 'pr', prUrl: 'https://x/pull/9', title: 'Review 9' })),
    ).toEqual(['review', 'agent', 'session']);
  });

  it('leads with the agent for actionable work and hides Review', () => {
    expect(actionsForTask(task({ title: 'Fix the login bug' }))).toEqual([
      'agent',
      'session',
    ]);
  });

  it('defaults to a session for freeform notes', () => {
    expect(actionsForTask(task({ title: 'thoughts on auth' }))).toEqual([
      'session',
      'agent',
    ]);
  });
});

function client(overrides: Partial<ApiClient> = {}, tasks: PlannerTask[] = []): ApiClient {
  const repos: Repository[] = [{ id: 'r1', name: 'acme/app' } as Repository];
  return {
    listPlannerTasks: vi.fn().mockResolvedValue(tasks),
    listRepos: vi.fn().mockResolvedValue(repos),
    createPlannerTask: vi.fn().mockResolvedValue(task()),
    updatePlannerTask: vi.fn().mockResolvedValue(task()),
    removePlannerTask: vi.fn().mockResolvedValue({ id: 't1' }),
    generatePlannerSummary: vi.fn().mockResolvedValue({
      scope: 'day',
      date: '2025-01-01',
      range: '2025-01-01',
      content: 'A calm day.',
      taskCount: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
    }),
    ...overrides,
  } as unknown as ApiClient;
}

function renderView(api: ApiClient) {
  return render(
    <ApiProvider value={api}>
      <PlannerView onLaunch={vi.fn()} />
    </ApiProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('PlannerView', () => {
  it('disables AI planning and review for an interactive-only CLI while keeping task editing and sessions usable', async () => {
    const api = client({
      getProviderBootstrap: vi.fn().mockResolvedValue({
        defaultProvider: 'interactive-cli', providers: [{ id: 'interactive-cli', installed: true,
          automation: { supported: false, reason: 'Automation policy cannot be verified.' } }],
      }),
    }, [task({ kind: 'pr', prUrl: 'https://github.com/acme/app/pull/42' })]);
    render(<ApiProvider value={api}><AutomationReadinessProvider><PlannerView onLaunch={vi.fn()} /></AutomationReadinessProvider></ApiProvider>);
    await screen.findByText(/Automation policy cannot be verified/);
    expect(screen.getByRole('button', { name: 'AI summary' })).toBeDisabled();
    expect(screen.getByTitle('Plan with the New Task agent')).toBeDisabled();
    expect(screen.getByTitle('Review the pull request')).toBeDisabled();
    expect(screen.getByTitle('Start a working session')).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'New task' })).toBeEnabled();
    expect(api.createPlannerTask).not.toHaveBeenCalled();
  });
  it('does not mistake a failed list read for an empty day or block safe creates', async () => {
    renderView(client({ listPlannerTasks: vi.fn().mockRejectedValue(new Error('503 tasks unavailable')) }));
    await screen.findByText(/The list is unknown, not empty/);
    expect(screen.queryByText('Nothing planned for this day')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'New task' })).toBeEnabled();
  });
  it('shows the day heading and empty state with no tasks', async () => {
    renderView(client());
    expect(await screen.findByText('Today')).toBeTruthy();
    expect(screen.getByText('Nothing planned for this day')).toBeTruthy();
  });

  it('marks day changes with direction-aware slide classes', async () => {
    const { container } = renderView(client());
    expect(await screen.findByText('Today')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Next day'));
    expect(
      container.querySelector('.planner-day-content')?.classList.contains('slide-forward'),
    ).toBe(true);

    fireEvent.click(screen.getByTitle('Previous day'));
    expect(
      container.querySelector('.planner-day-content')?.classList.contains('slide-back'),
    ).toBe(true);
  });

  it('lists a task for today with its detected actions', async () => {
    renderView(client({}, [task()]));
    expect(await screen.findByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByTitle('Plan with the New Task agent')).toBeTruthy();
    expect(screen.getByTitle('Start a working session')).toBeTruthy();
  });

  it('previews the detected action as you type and adds the task', async () => {
    const api = client();
    renderView(api);
    const input = await screen.findByLabelText('New task');
    fireEvent.change(input, { target: { value: 'Review PR #42' } });
    expect(screen.getByText('Review the pull request')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(api.createPlannerTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Review PR #42',
          kind: 'pr',
          prUrl: 'Review PR #42',
          repoId: 'r1',
        }),
      ),
    );
  });

  it('offers to open a launched task', async () => {
    renderView(
      client({}, [
        task({ launchKind: 'session', sessionId: 's1', launchLabel: 'Login fix' }),
      ]),
    );
    expect(await screen.findByText('Login fix')).toBeTruthy();
  });

  it('defers a task to the backlog with today as the stamp', async () => {
    const api = client({}, [task()]);
    renderView(api);
    const defer = await screen.findByLabelText('Defer "Fix the login bug" to backlog');
    fireEvent.click(defer);
    await waitFor(() =>
      expect(api.updatePlannerTask).toHaveBeenCalledWith('t1', {
        backloggedAt: todayIso(),
      }),
    );
  });

  it('edits a task title and notes inline', async () => {
    const api = client({}, [task()]);
    renderView(api);
    fireEvent.click(await screen.findByLabelText('Edit "Fix the login bug"'));
    const titleInput = screen.getByLabelText('Edit task title');
    fireEvent.change(titleInput, { target: { value: 'Fix the logout bug' } });
    fireEvent.change(screen.getByLabelText('Edit task notes'), {
      target: { value: 'affects SSO' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(api.updatePlannerTask).toHaveBeenCalledWith('t1', {
        title: 'Fix the logout bug',
        notes: 'affects SSO',
      }),
    );
  });

  it('hides backlogged tasks from the day and restores them from the backlog', async () => {
    const api = client({}, [task({ backloggedAt: '2025-01-02' })]);
    renderView(api);
    // Backlogged task is excluded from the day view.
    expect(await screen.findByText('Nothing planned for this day')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Backlog/ }));
    expect(await screen.findByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByText('Backlogged 2025-01-02')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Restore to the chosen day'));
    await waitFor(() =>
      expect(api.updatePlannerTask).toHaveBeenCalledWith('t1', {
        backloggedAt: null,
        date: todayIso(),
      }),
    );
  });

  it('moves every unfinished task to the next day', async () => {
    const api = client({}, [task(), task({ id: 't2', status: 'done' })]);
    renderView(api);
    const move = await screen.findByTitle('Move every unfinished task to tomorrow');
    fireEvent.click(move);
    await waitFor(() =>
      expect(api.updatePlannerTask).toHaveBeenCalledWith('t1', {
        date: addDays(todayIso(), 1),
      }),
    );
    // The completed task is left where it is.
    expect(api.updatePlannerTask).not.toHaveBeenCalledWith('t2', expect.anything());
  });

  it('exports the day when a task is present', async () => {
    const createUrl = vi.fn(() => 'blob:x');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});
    try {
      renderView(client({}, [task()]));
      fireEvent.click(await screen.findByTitle('Export this day'));
      const md = await screen.findByTitle('Export this day as Markdown');
      fireEvent.click(md);
      expect(createUrl).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('generates and renders an AI summary for the selected scope', async () => {
    const api = client({}, [task()]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'AI summary' }));
    const monthTab = await screen.findByRole('tab', { name: 'Month' });
    fireEvent.click(monthTab);
    fireEvent.change(screen.getByLabelText('Summary guidance'), {
      target: { value: 'focus on blockers' },
    });
    fireEvent.click(screen.getByText('Generate summary'));
    await waitFor(() =>
      expect(api.generatePlannerSummary).toHaveBeenCalledWith({
        scope: 'month',
        date: todayIso(),
        prompt: 'focus on blockers',
      }),
    );
    expect(await screen.findByText('A calm day.')).toBeTruthy();
  });

  it('surfaces an error when summary generation fails', async () => {
    const api = client({ generatePlannerSummary: vi.fn().mockRejectedValue(new Error('boom')) }, [
      task(),
    ]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'AI summary' }));
    fireEvent.click(await screen.findByText('Generate summary'));
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});

const feature = { id: 'f1', name: 'Fix the login bug', repoId: 'r1' };
const startedSession = { id: 's1', featureId: 'f1', name: null } as unknown as Session;

function launchApi(overrides: Partial<ApiClient> = {}, tasks: PlannerTask[] = [task()]) {
  return client(
    {
      listFeatures: vi.fn().mockResolvedValue([]),
      listSessions: vi.fn().mockResolvedValue([]),
      listFeatureAgents: vi.fn().mockResolvedValue([]),
      createFeature: vi.fn().mockResolvedValue(feature),
      createTerminalSession: vi.fn().mockResolvedValue(startedSession),
      renameSession: vi.fn().mockResolvedValue({ ...startedSession, name: 'Fix the login bug' }),
      ...overrides,
    },
    tasks,
  );
}

describe('PlannerView quick add', () => {
  it('ignores Enter while an IME is composing and adds once on a fast double Enter', async () => {
    let release: (value: PlannerTask) => void = () => {};
    const createPlannerTask = vi.fn(() => new Promise<PlannerTask>((resolve) => { release = resolve; }));
    renderView(client({ createPlannerTask }));
    const input = await screen.findByLabelText('New task');
    fireEvent.change(input, { target: { value: 'Write docs' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Process', keyCode: 229 });
    expect(createPlannerTask).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(createPlannerTask).toHaveBeenCalledTimes(1);
    release(task());
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
  });

  it('keeps the draft after a failed add, restores it on remount, and keeps newer typing', async () => {
    const createPlannerTask = vi.fn().mockRejectedValueOnce(new Error('offline'));
    const api = client({ createPlannerTask });
    const first = renderView(api);
    const input = await screen.findByLabelText('New task');
    fireEvent.change(input, { target: { value: 'Write docs' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('offline')).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe('Write docs');
    first.unmount();
    renderView(api);
    expect(((await screen.findByLabelText('New task')) as HTMLTextAreaElement).value).toBe('Write docs');
  });

  it('does not discard text typed while the add request was in flight', async () => {
    let release: (value: PlannerTask) => void = () => {};
    const createPlannerTask = vi.fn(() => new Promise<PlannerTask>((resolve) => { release = resolve; }));
    renderView(client({ createPlannerTask }));
    const input = await screen.findByLabelText('New task');
    fireEvent.change(input, { target: { value: 'Write docs' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'Write docs now' } });
    release(task());
    await waitFor(() => expect(createPlannerTask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe('Write docs now'));
  });

  it('navigates suggestions with the keyboard, exposing the active option', async () => {
    const api = client({}, [
      task({ id: 'a', title: 'Fix login bug' }),
      task({ id: 'b', title: 'Fix logout bug', date: '2000-01-01' }),
    ]);
    renderView(api);
    const input = await screen.findByLabelText('New task');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'fix' } });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect((input as HTMLTextAreaElement).value).toBe('Fix login bug');
    expect(api.createPlannerTask).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: 'fix' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('PlannerView task mutations', () => {
  it('keeps the editor and edits open when saving fails', async () => {
    const updatePlannerTask = vi.fn().mockRejectedValueOnce(new Error('disk full'));
    renderView(client({ updatePlannerTask }, [task()]));
    fireEvent.click(await screen.findByLabelText('Edit "Fix the login bug"'));
    const titleInput = screen.getByLabelText('Edit task title');
    fireEvent.change(titleInput, { target: { value: 'Fix the logout bug' } });
    fireEvent.keyDown(titleInput, { key: 'Enter', isComposing: true });
    expect(updatePlannerTask).not.toHaveBeenCalled();
    fireEvent.keyDown(titleInput, { key: 'Enter' });
    expect(await screen.findByText('disk full')).toBeTruthy();
    expect((screen.getByLabelText('Edit task title') as HTMLInputElement).value).toBe('Fix the logout bug');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByLabelText('Edit task title')).toBeNull());
    expect(updatePlannerTask).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(screen.getByLabelText('Edit "Fix the login bug"'));
  });

  it('surfaces a failed defer instead of rejecting silently', async () => {
    const updatePlannerTask = vi.fn().mockRejectedValue(new Error('nope'));
    renderView(client({ updatePlannerTask }, [task()]));
    fireEvent.click(await screen.findByLabelText('Defer "Fix the login bug" to backlog'));
    expect(await screen.findByText('nope')).toBeTruthy();
  });

  it('confirms before deleting and keeps the dialog open on failure', async () => {
    const removePlannerTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('locked'))
      .mockResolvedValue({ id: 't1' });
    renderView(client({ removePlannerTask }, [task()]));
    fireEvent.click(await screen.findByLabelText('Delete "Fix the login bug"'));
    expect(removePlannerTask).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('locked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(removePlannerTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not delete when the confirmation is cancelled', async () => {
    const api = client({}, [task()]);
    renderView(api);
    fireEvent.click(await screen.findByLabelText('Delete "Fix the login bug"'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.removePlannerTask).not.toHaveBeenCalled();
  });

  it('commits a rename once for Enter followed by blur and ignores Escape', async () => {
    const renameSession = vi.fn().mockResolvedValue({});
    const updatePlannerTask = vi.fn().mockResolvedValue(task());
    renderView(
      client({ renameSession, updatePlannerTask }, [
        task({ launchKind: 'session', sessionId: 's1', launchLabel: 'Login fix' }),
      ]),
    );
    fireEvent.click(await screen.findByLabelText('Rename'));
    const input = screen.getByLabelText('Rename');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Rename' })).toBeNull());
    expect(renameSession).toHaveBeenCalledTimes(1);
    expect(updatePlannerTask).toHaveBeenCalledWith('t1', { launchLabel: 'Renamed' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename' }));

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const again = screen.getByRole('textbox', { name: 'Rename' });
    fireEvent.change(again, { target: { value: 'Discarded' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    fireEvent.blur(again);
    expect(renameSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the rename open with an error when the rename fails for a non-missing reason', async () => {
    const renameSession = vi.fn().mockRejectedValue(new ApiError(500, 'server down'));
    renderView(
      client({ renameSession }, [
        task({ launchKind: 'session', sessionId: 's1', launchLabel: 'Login fix' }),
      ]),
    );
    fireEvent.click(await screen.findByLabelText('Rename'));
    const input = screen.getByLabelText('Rename');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('server down')).toBeTruthy();
    expect((screen.getByLabelText('Rename') as HTMLInputElement).value).toBe('Renamed');
  });

  it('still syncs the task label when the renamed target no longer exists', async () => {
    const renameSession = vi.fn().mockRejectedValue(new ApiError(404, 'gone'));
    const updatePlannerTask = vi.fn().mockResolvedValue(task());
    renderView(
      client({ renameSession, updatePlannerTask }, [
        task({ launchKind: 'session', sessionId: 's1', launchLabel: 'Login fix' }),
      ]),
    );
    fireEvent.click(await screen.findByLabelText('Rename'));
    const input = screen.getByLabelText('Rename');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(updatePlannerTask).toHaveBeenCalledWith('t1', { launchLabel: 'Renamed' }));
  });
});

describe('PlannerView launches', () => {
  const launched = () => task({ launchKind: 'session', sessionId: 's1', featureId: 'f9', launchLabel: 'Login fix' });

  it('does not recreate a session when reopening fails for a non-missing reason', async () => {
    const api = launchApi({ getSession: vi.fn().mockRejectedValue(new ApiError(500, 'boom')) }, [launched()]);
    renderView(api);
    fireEvent.click(await screen.findByTitle('Open Session'));
    expect(await screen.findByText('boom')).toBeTruthy();
    expect(api.createFeature).not.toHaveBeenCalled();
  });

  it('recreates a launched session only when the target is proven missing', async () => {
    const onLaunch = vi.fn();
    const api = launchApi({ getSession: vi.fn().mockRejectedValue(new ApiError(404, 'missing')) }, [launched()]);
    render(
      <ApiProvider value={api}>
        <PlannerView onLaunch={onLaunch} />
      </ApiProvider>,
    );
    fireEvent.click(await screen.findByTitle('Open Session'));
    await waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    expect(api.createTerminalSession).toHaveBeenCalledTimes(1);
  });

  it('reuses the feature created by a failed launch when the user retries', async () => {
    const createTerminalSession = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(422, 'spawn failed'))
      .mockResolvedValue(startedSession);
    const api = launchApi({ createTerminalSession });
    renderView(api);
    fireEvent.click(await screen.findByTitle('Plan with the New Task agent').then(() => screen.getByTitle('Start a working session')));
    expect(await screen.findByText(/spawn failed/)).toBeTruthy();
    expect(screen.getByText(/Retrying continues/)).toBeTruthy();
    const featureCalls = vi.mocked(api.createFeature).mock.calls.length;
    fireEvent.click(await screen.findByTitle('Start a working session'));
    await waitFor(() => expect(createTerminalSession).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.createFeature).mock.calls.length).toBe(featureCalls);
  });

  it('admits only one launch at a time', async () => {
    let release: (value: unknown) => void = () => {};
    const createTerminalSession = vi.fn(() => new Promise<Session>((resolve) => { release = resolve as (value: unknown) => void; }));
    const api = launchApi({ createTerminalSession });
    renderView(api);
    const button = await screen.findByTitle('Start a working session');
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(createTerminalSession).toHaveBeenCalledTimes(1));
    release(startedSession);
    await waitFor(() => expect(api.updatePlannerTask).toHaveBeenCalled());
    expect(createTerminalSession).toHaveBeenCalledTimes(1);
  });
});

describe('PlannerView AI summary dialog', () => {
  it('closes on Escape and returns focus to the opener', async () => {
    renderView(client({}, [task()]));
    const opener = await screen.findByRole('button', { name: 'AI summary' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'AI task summary' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('generates with Ctrl/Cmd+Enter but not while composing', async () => {
    const api = client({}, [task()]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'AI summary' }));
    const prompt = await screen.findByLabelText('Summary guidance');
    fireEvent.keyDown(prompt, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(api.generatePlannerSummary).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(api.generatePlannerSummary).toHaveBeenCalledTimes(1));
  });
});

describe('PlannerView draft backup warning', () => {
  it('warns only while a dirty draft cannot be backed up and keeps the text', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    });
    try {
      renderView(client());
      const input = await screen.findByLabelText('New task');
      expect(screen.queryByText(/Draft backup is unavailable/)).toBeNull();
      fireEvent.change(input, { target: { value: 'Write docs' } });
      expect((await screen.findByRole('alert')).textContent).toMatch(/save or copy/);
      expect((input as HTMLTextAreaElement).value).toBe('Write docs');
      write.mockRestore();
      fireEvent.change(input, { target: { value: 'Write docs 2' } });
      await waitFor(() => expect(screen.queryByText(/Draft backup is unavailable/)).toBeNull());
    } finally {
      write.mockRestore();
    }
  });
});

describe('PlannerView launch ownership across remounts', () => {
  const mountWith = (api: ApiClient, onLaunch = vi.fn()) =>
    render(
      <ApiProvider value={api}>
        <PlannerView onLaunch={onLaunch} />
      </ApiProvider>,
    );

  it('keeps a pending launch blocked after remount and never navigates from the old view', async () => {
    let release: (value: Session) => void = () => {};
    const createTerminalSession = vi.fn(
      () => new Promise<Session>((resolve) => { release = resolve; }),
    );
    const api = launchApi({ createTerminalSession });
    const oldLaunch = vi.fn();
    const first = mountWith(api, oldLaunch);
    fireEvent.click(await screen.findByTitle('Start a working session'));
    await waitFor(() => expect(createTerminalSession).toHaveBeenCalledTimes(1));
    first.unmount();

    const newLaunch = vi.fn();
    mountWith(api, newLaunch);
    expect(await screen.findByText(/Starting session/i)).toBeTruthy();
    expect(screen.queryByTitle('Start a working session')).toBeNull();
    expect(createTerminalSession).toHaveBeenCalledTimes(1);

    const loads = vi.mocked(api.listPlannerTasks).mock.calls.length;
    release(startedSession);
    await waitFor(() => expect(api.updatePlannerTask).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(api.listPlannerTasks).mock.calls.length).toBeGreaterThan(loads));
    expect(oldLaunch).not.toHaveBeenCalled();
    expect(newLaunch).not.toHaveBeenCalled();
    expect(await screen.findByTitle('Start a working session')).toBeTruthy();
  });

  it('retries an unknown create after remount with the same durable key', async () => {
    const createTerminalSession = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(startedSession);
    const api = launchApi({ createTerminalSession });
    const first = mountWith(api);
    fireEvent.click(await screen.findByTitle('Start a working session'));
    expect(await screen.findByText(/Failed to fetch/)).toBeTruthy();
    first.unmount();

    const onLaunch = vi.fn();
    mountWith(api, onLaunch);
    expect(await screen.findByText(/Failed to fetch/)).toBeTruthy();
    fireEvent.click(await screen.findByTitle('Start a working session'));
    await waitFor(() => expect(onLaunch).toHaveBeenCalledTimes(1));
    expect(createTerminalSession).toHaveBeenCalledTimes(2);
    const keys = createTerminalSession.mock.calls.map((call) => (call as unknown[])[2]);
    expect(keys[0]).toEqual({ operationKey: expect.stringMatching(/^op-/) });
    expect(keys[1]).toEqual(keys[0]);
  });

  it('keeps the durable key when the backend reports the operation pending', async () => {
    const pending = new ApiError(409, 'Operation is still pending', 'operation_pending');
    const createTerminalSession = vi.fn().mockRejectedValue(pending);
    const api = launchApi({ createTerminalSession });
    mountWith(api);
    fireEvent.click(await screen.findByTitle('Start a working session'));
    await waitFor(() => expect(createTerminalSession).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByTitle('Start a working session'));
    await waitFor(() => expect(createTerminalSession).toHaveBeenCalledTimes(2));
    const keys = createTerminalSession.mock.calls.map((call) => (call as unknown[])[2]);
    expect(keys[1]).toEqual(keys[0]);
  });});
