import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { initialLiveState } from '../../lib/stream.js';
import type { Automation, AutomationRun, Subagent } from '../../lib/types.js';
import { AutomationsView } from './automations-view.js';

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Watch CI',
    mode: 'long',
    status: 'active',
    origin: { sessionId: null, featureId: 'f1' },
    check: { type: 'ci-pipeline', repo: 'o/r' },
    condition: { type: 'ai-verdict' },
    action: { type: 'report', prompt: 'go' },
    intervalMs: 300_000,
    maxRuns: null,
    runCount: 0,
    progress: null,
    plannedSteps: [],
    lastOccurrenceKey: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    lastCheckedAt: null,
    nextRunAt: null,
    failure: null,
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'r1',
    automationId: 'a1',
    source: 'scheduled',
    phase: 'finished',
    scheduledForAt: null,
    occurrenceKey: null,
    dedupeKey: 'scheduled:a1:r1',
    startedAt: '2024-01-01T00:00:00.000Z',
    dispatchedAt: '2024-01-01T00:00:00.000Z',
    endedAt: '2024-01-01T00:00:01.000Z',
    triggered: true,
    status: 'ok',
    detail: 'went green',
    sessionId: null,
    report: null,
    ...overrides,
  };
}

function client(
  automations: Automation[],
  overrides: Partial<ApiClient> = {},
  subagents: Subagent[] = [],
): ApiClient {
  return {
    listAutomations: vi.fn().mockResolvedValue({ automations, subagents }),
    getAutomation: vi.fn().mockResolvedValue({
      automation: automations[0] ?? null,
      runs: [run()],
      subagents: [],
    }),
    pauseAutomation: vi.fn().mockResolvedValue(automation()),
    resumeAutomation: vi.fn().mockResolvedValue(automation()),
    cancelAutomation: vi.fn().mockResolvedValue(automation()),
    runAutomation: vi.fn().mockResolvedValue(automation()),
    deleteAutomation: vi.fn().mockResolvedValue({ id: 'a1' }),
    updateAutomationInterval: vi.fn().mockResolvedValue(automation()),
    ...overrides,
  } as unknown as ApiClient;
}

function renderView(api: ApiClient, live = initialLiveState) {
  return render(
    <ApiProvider value={api}>
      <AutomationsView live={live} />
    </ApiProvider>,
  );
}

describe('AutomationsView', () => {
  it('segregates monitors into running, needs-sign-in, paused, and finished', async () => {
    const api = client([
      automation({ id: 'r', name: 'Running one', status: 'active' }),
      automation({ id: 'p', name: 'Paused one', status: 'paused' }),
      automation({ id: 'n', name: 'Auth one', status: 'needs-auth' }),
      automation({ id: 'f', name: 'Done one', status: 'completed' }),
    ]);
    const { container } = renderView(api);
    expect(await screen.findByText('Running one')).toBeInTheDocument();
    const titles = Array.from(
      container.querySelectorAll('.automation-section-title'),
    ).map((el) => el.textContent);
    expect(titles.some((t) => t?.includes('Running'))).toBe(true);
    expect(titles.some((t) => t?.includes('Paused'))).toBe(true);
    expect(titles.some((t) => t?.includes('Needs sign-in'))).toBe(true);
    expect(titles.some((t) => t?.includes('Finished'))).toBe(true);
  });

  it('shows an animated status dot per motion state', async () => {
    const { container } = renderView(
      client([
        automation({ id: 'r', name: 'R', status: 'active' }),
        automation({ id: 'p', name: 'P', status: 'paused' }),
        automation({ id: 'f', name: 'F', status: 'failed' }),
      ]),
    );
    await screen.findByText('R');
    const motions = Array.from(
      container.querySelectorAll('.monitor-status-dot'),
    ).map((el) => el.getAttribute('data-motion'));
    expect(motions).toContain('running');
    expect(motions).toContain('paused');
    expect(motions).toContain('stopped');
  });

  it('refreshes the monitor list on demand', async () => {
    const api = client([automation()]);
    renderView(api);
    await screen.findByText('Watch CI');

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(api.listAutomations).toHaveBeenCalledTimes(2));
  });

  it('renders a progress bar, ETA, and current call for a capped running monitor', async () => {
    const { container } = renderView(
      client([
        automation({
          maxRuns: 288,
          runCount: 144,
          intervalMs: 300_000,
          plannedSteps: [
            { id: 's1', label: 'Wait for green', status: 'active', detail: null },
          ],
        }),
      ]),
    );
    await screen.findByText('Watch CI');
    expect(container.querySelector('.automation-progressbar')).not.toBeNull();
    expect(screen.getByText(/left/)).toBeInTheDocument();
    expect(screen.getByText(/Now: Wait for green/)).toBeInTheDocument();
  });

  it('renders planned step details when present', async () => {
    renderView(
      client([
        automation({
          plannedSteps: [
            {
              id: 's1',
              label: 'Wait for green',
              status: 'active',
              detail: 'Watching workflow 42',
            },
          ],
        }),
      ]),
    );

    await screen.findByText('Watch CI');
    expect(screen.getByText('Watching workflow 42')).toBeInTheDocument();
  });

  it('shows last-checked and countdown metadata when available', async () => {
    renderView(
      client([
        automation({
          lastCheckedAt: '2024-01-01T00:00:00.000Z',
          nextRunAt: '2099-01-01T00:00:30.000Z',
        }),
      ]),
    );

    await screen.findByText('Watch CI');
    expect(screen.getByText(/Last checked/i)).toBeInTheDocument();
    expect(screen.getByText(/in /i)).toBeInTheDocument();
  });

  it('pauses, runs, stops, and deletes a running monitor', async () => {
    const api = client([automation({ status: 'active' })]);
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    await waitFor(() => {
      expect(api.pauseAutomation).toHaveBeenCalledWith('a1');
      expect(api.runAutomation).toHaveBeenCalledWith('a1', undefined);
      expect(api.cancelAutomation).toHaveBeenCalledWith('a1');
      expect(api.deleteAutomation).toHaveBeenCalledWith('a1');
    });
  });

  it('resumes a paused monitor', async () => {
    const api = client([automation({ status: 'paused' })]);
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await waitFor(() => expect(api.resumeAutomation).toHaveBeenCalledWith('a1'));
  });

  it('changes the poll frequency', async () => {
    const api = client([automation({ intervalMs: 300_000 })]);
    renderView(api);
    await screen.findByText('Watch CI');
    const select = screen.getByLabelText(/Poll frequency/i) as HTMLSelectElement;
    expect(select.value).toBe('300000');
    fireEvent.change(select, { target: { value: '60000' } });
    await waitFor(() =>
      expect(api.updateAutomationInterval).toHaveBeenCalledWith('a1', 60_000),
    );
  });

  it('surfaces a poll-frequency update error', async () => {
    const api = client([automation({ intervalMs: 300_000 })], {
      updateAutomationInterval: vi
        .fn()
        .mockRejectedValue(new Error('interval boom')),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.change(screen.getByLabelText(/Poll frequency/i), {
      target: { value: '60000' },
    });
    expect(await screen.findByText('interval boom')).toBeInTheDocument();
  });

  it('stringifies non-Error poll-frequency update failures', async () => {
    const api = client([automation({ intervalMs: 300_000 })], {
      updateAutomationInterval: vi.fn().mockRejectedValue('interval boom'),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.change(screen.getByLabelText(/Poll frequency/i), {
      target: { value: '60000' },
    });
    expect(await screen.findByText('interval boom')).toBeInTheDocument();
  });

  it('expands detailed logs and lists runs', async () => {
    const api = client([automation()]);
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    expect(await screen.findByText(/Triggered · went green/)).toBeInTheDocument();
    expect(api.getAutomation).toHaveBeenCalledWith('a1');
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
  });

  it('renders a persisted report body in the run history', async () => {
    const api = client([automation()], {
      getAutomation: vi.fn().mockResolvedValue({
        automation: automation(),
        runs: [
          run({
            id: 'report-run',
            detail: 'Report generated',
            report: 'Durable report body',
          }),
        ],
        subagents: [],
      }),
    });

    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: /Logs/i }));

    expect(await screen.findByText('Durable report body')).toBeInTheDocument();
  });

  it('shows a loading state while logs are in flight', async () => {
    let resolveLogs!: (value: {
      automation: Automation;
      runs: AutomationRun[];
      subagents: Subagent[];
    }) => void;
    const api = client([automation()], {
      getAutomation: vi.fn(
        () =>
          new Promise<{
            automation: Automation;
            runs: AutomationRun[];
            subagents: Subagent[];
          }>((resolve) => {
            resolveLogs = resolve;
          }),
      ),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    expect(await screen.findByText(/loading logs/i)).toBeInTheDocument();

    resolveLogs({
      automation: automation(),
      runs: [run()],
      subagents: [],
    });

    expect(await screen.findByText(/Triggered · went green/)).toBeInTheDocument();
  });

  it('renders queued and uncertain run phases truthfully in the logs', async () => {
    const api = client([automation()], {
      getAutomation: vi.fn().mockResolvedValue({
        automation: automation(),
        runs: [
          run({ id: 'queued', phase: 'queued', status: 'skipped', detail: 'Queued to check' }),
          run({
            id: 'uncertain',
            phase: 'uncertain',
            status: 'failed',
            detail: 'Previous backend stopped before this run completed',
          }),
        ],
        subagents: [],
      }),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Uncertain')).toBeInTheDocument();
    expect(
      screen.getByText('Previous backend stopped before this run completed'),
    ).toBeInTheDocument();
  });

  it('shows an empty log message when a monitor has no runs', async () => {
    const api = client([automation()], {
      getAutomation: vi.fn().mockResolvedValue({
        automation: automation(),
        runs: [],
        subagents: [],
      }),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    expect(
      await screen.findByText('No runs recorded yet.'),
    ).toBeInTheDocument();
  });

  it('refreshes visible logs when the automation updates and when the logs are reopened', async () => {
    const getAutomation = vi
      .fn()
      .mockResolvedValueOnce({
        automation: automation(),
        runs: [run({ id: 'queued', phase: 'queued', status: 'skipped', detail: 'Queued to check' })],
        subagents: [],
      })
      .mockResolvedValueOnce({
        automation: automation({ progress: 'Running action', updatedAt: '2024-01-01T00:01:00.000Z' }),
        runs: [run({ id: 'acting', phase: 'acting', status: 'skipped', detail: 'Running action' })],
        subagents: [],
      })
      .mockResolvedValueOnce({
        automation: automation({ updatedAt: '2024-01-01T00:02:00.000Z' }),
        runs: [run({ id: 'done', detail: 'went green' })],
        subagents: [],
      });
    const api = client([automation()], { getAutomation });
    const view = renderView(api);
    await screen.findByText('Watch CI');

    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();

    view.rerender(
      <ApiProvider value={api}>
        <AutomationsView
          live={{
            ...initialLiveState,
            automations: {
              a1: automation({
                progress: 'Running action',
                updatedAt: '2024-01-01T00:01:00.000Z',
              }),
            },
          }}
        />
      </ApiProvider>,
    );

    expect(await screen.findByText('Running action')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^logs$/i }));
    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    expect(await screen.findByText(/Triggered · went green/)).toBeInTheDocument();
    expect(getAutomation).toHaveBeenCalledTimes(3);
  });

  it('ignores stale log responses after a newer refresh wins', async () => {
    let resolveFirst!: (value: {
      automation: Automation;
      runs: AutomationRun[];
      subagents: Subagent[];
    }) => void;
    const getAutomation = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        automation: automation({ progress: 'Running action', updatedAt: '2024-01-01T00:01:00.000Z' }),
        runs: [run({ id: 'new', detail: 'fresh detail' })],
        subagents: [],
      });
    const api = client([automation()], { getAutomation });
    const view = renderView(api);
    await screen.findByText('Watch CI');

    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    await waitFor(() => expect(getAutomation).toHaveBeenCalledTimes(1));

    view.rerender(
      <ApiProvider value={api}>
        <AutomationsView
          live={{
            ...initialLiveState,
            automations: {
              a1: automation({
                progress: 'Running action',
                updatedAt: '2024-01-01T00:01:00.000Z',
              }),
            },
          }}
        />
      </ApiProvider>,
    );

    expect(await screen.findByText(/fresh detail/)).toBeInTheDocument();
    resolveFirst({
      automation: automation(),
      runs: [run({ id: 'old', detail: 'stale detail' })],
      subagents: [],
    });

    await waitFor(() => {
      expect(screen.queryByText(/stale detail/)).toBeNull();
    });
    expect(screen.getByText(/fresh detail/)).toBeInTheDocument();
  });

  it('surfaces a lifecycle action error', async () => {
    const api = client([automation({ status: 'active' })], {
      pauseAutomation: vi.fn().mockRejectedValue(new Error('nope')),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });

  it('stringifies non-Error lifecycle failures', async () => {
    const api = client([automation({ status: 'active' })], {
      pauseAutomation: vi.fn().mockRejectedValue('nope'),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });

  it('surfaces a delete failure', async () => {
    const api = client([automation({ status: 'active' })], {
      deleteAutomation: vi.fn().mockRejectedValue(new Error('delete boom')),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /delete watch ci/i }));
    expect(await screen.findByText('delete boom')).toBeInTheDocument();
  });

  it('renders a failure message when a monitor failed without uncertainty', async () => {
    renderView(
      client([
        automation({
          status: 'failed',
          failure: 'Check failed: boom',
        }),
      ]),
    );

    expect(await screen.findByText('Check failed: boom')).toBeInTheDocument();
  });

  it('surfaces a logs load error', async () => {
    const api = client([automation()], {
      getAutomation: vi.fn().mockRejectedValue(new Error('logs boom')),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    expect(await screen.findByText('logs boom')).toBeInTheDocument();
  });

  it('stringifies non-Error log load failures', async () => {
    const api = client([automation()], {
      getAutomation: vi.fn().mockRejectedValue('logs boom'),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    expect(await screen.findByText('logs boom')).toBeInTheDocument();
  });

  it('renders the empty state when there are no monitors', async () => {
    const api = client([]);
    renderView(api);
    expect(await screen.findByText('No monitors yet')).toBeInTheDocument();
  });

  it('shows the sign-in guidance and resume for a needs-auth monitor', async () => {
    const api = client([automation({ status: 'needs-auth' })]);
    renderView(api);
    const card = (await screen.findByText('Watch CI')).closest(
      '.automation-card',
    ) as HTMLElement;
    expect(within(card).getByRole('alert')).toHaveTextContent(
      'Sign-in required',
    );
    fireEvent.click(
      within(card).getByRole('button', { name: /Signed in — resume/i }),
    );
    await waitFor(() => expect(api.resumeAutomation).toHaveBeenCalledWith('a1'));
  });

  it('requires explicit confirmation before retrying uncertain work', async () => {
    const uncertain = automation({
      status: 'failed',
      mode: 'short',
      progress:
        'A previous action may already have executed for occurrence "run-1".',
      uncertainty: {
        summary:
          'A previous action may already have executed for occurrence "run-1". Automatic retries stay blocked until you explicitly confirm a retry.',
        unresolvedRunIds: ['u1', 'u2'],
      },
    });
    const api = client([uncertain]);
    renderView(api);

    const card = (await screen.findByText('Watch CI')).closest(
      '.automation-card',
    ) as HTMLElement;
    expect(within(card).getByRole('alert')).toHaveTextContent(
      /possible duplicate action/i,
    );

    fireEvent.click(within(card).getByRole('button', { name: /run now/i }));
    expect(api.runAutomation).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/retry a possibly duplicated action/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry anyway/i }));

    await waitFor(() =>
      expect(api.runAutomation).toHaveBeenCalledWith('a1', {
        uncertaintyAcknowledgement: {
          snapshotRunIds: ['u1', 'u2'],
          targetRunIds: ['u1', 'u2'],
        },
      }),
    );
  });

  it('lets the user dismiss an uncertain retry confirmation without dispatching', async () => {
    const api = client([
      automation({
        status: 'failed',
        mode: 'short',
        uncertainty: {
          summary: 'Possible duplicate action.',
          unresolvedRunIds: ['u1'],
        },
      }),
    ]);
    renderView(api);
    const card = (await screen.findByText('Watch CI')).closest(
      '.automation-card',
    ) as HTMLElement;

    fireEvent.click(within(card).getByRole('button', { name: /run now/i }));
    expect(await screen.findByText(/retry a possibly duplicated action/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/retry a possibly duplicated action/i)).toBeNull();
    });
    expect(api.runAutomation).not.toHaveBeenCalled();
  });

  it('keeps the uncertainty confirmation open when an acknowledged retry is rejected', async () => {
    const api = client([
      automation({
        status: 'failed',
        mode: 'short',
        uncertainty: {
          summary: 'Possible duplicate action.',
          unresolvedRunIds: ['u1'],
        },
      }),
    ], {
      runAutomation: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'A queued scheduled run already owns this monitor, so the retry acknowledgement could not be applied. Wait for it to finish or cancel it, then refresh and retry.',
          ),
        ),
    });
    renderView(api);
    const card = (await screen.findByText('Watch CI')).closest(
      '.automation-card',
    ) as HTMLElement;

    fireEvent.click(within(card).getByRole('button', { name: /run now/i }));
    fireEvent.click(screen.getByRole('button', { name: /retry anyway/i }));

    expect(
      await screen.findByText(/retry acknowledgement could not be applied/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/retry a possibly duplicated action/i),
    ).toBeInTheDocument();
    expect(api.runAutomation).toHaveBeenCalledTimes(1);
  });

  it('keeps the uncertainty warning visible across live refreshes', async () => {
    const initial = automation({
      status: 'active',
      uncertainty: {
        summary:
          'A previous action may already have executed for occurrence "run-1". Automatic retries stay blocked until you explicitly confirm a retry.',
        unresolvedRunIds: ['u1'],
      },
    });
    const api = client([initial]);
    const view = renderView(api);
    const card = (await screen.findByText('Watch CI')).closest(
      '.automation-card',
    ) as HTMLElement;
    expect(within(card).getByRole('alert')).toHaveTextContent(
      /possible duplicate action/i,
    );

    view.rerender(
      <ApiProvider value={api}>
        <AutomationsView
          live={{
            ...initialLiveState,
            automations: {
              a1: automation({
                status: 'active',
                progress: 'Waiting for status "completed" · last result: completed',
                updatedAt: '2024-01-01T00:01:00.000Z',
                uncertainty: {
                  summary:
                    'A previous action may already have executed for occurrence "run-1". Automatic retries stay blocked until you explicitly confirm a retry.',
                  unresolvedRunIds: ['u1'],
                },
              }),
            },
          }}
        />
      </ApiProvider>,
    );

    expect(within(card).getByRole('alert')).toHaveTextContent(
      /possible duplicate action/i,
    );
    expect(within(card).getByRole('alert')).toHaveTextContent(
      /automatic retries stay blocked/i,
    );
  });

  it('renders subagents when present', async () => {
    const subagent: Subagent = {
      id: 'g1',
      automationId: 'a1',
      origin: { sessionId: null, featureId: null },
      task: 'Analyze failure',
      status: 'running',
      progress: 'reading logs',
      result: 'final summary',
      sessionId: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const api = client([], {}, [subagent]);
    renderView(api);
    expect(await screen.findByText('Analyze failure')).toBeInTheDocument();
    expect(screen.getByText('Subagents')).toBeInTheDocument();
    expect(screen.getByText('reading logs')).toBeInTheDocument();
    expect(screen.getByText(/final summary/i)).toBeInTheDocument();
  });
});
