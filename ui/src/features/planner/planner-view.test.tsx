import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { PlannerTask, Repository } from '../../lib/types.js';
import { addDays, todayIso } from '../../lib/planner-dates.js';
import { actionsForTask, PlannerView } from './planner-view.js';

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

describe('PlannerView', () => {
  it('shows the day heading and empty state with no tasks', async () => {
    renderView(client());
    expect(await screen.findByText('Today')).toBeTruthy();
    expect(screen.getByText('Nothing planned for this day')).toBeTruthy();
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
