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
    startedAt: '2024-01-01T00:00:00.000Z',
    endedAt: '2024-01-01T00:00:01.000Z',
    triggered: true,
    status: 'ok',
    detail: 'went green',
    sessionId: null,
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

function renderView(api: ApiClient) {
  return render(
    <ApiProvider value={api}>
      <AutomationsView live={initialLiveState} />
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
      expect(api.runAutomation).toHaveBeenCalledWith('a1');
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

  it('expands detailed logs and lists runs', async () => {
    const api = client([automation()]);
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /logs/i }));
    expect(await screen.findByText(/Triggered · went green/)).toBeInTheDocument();
    expect(api.getAutomation).toHaveBeenCalledWith('a1');
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
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

  it('surfaces a lifecycle action error', async () => {
    const api = client([automation({ status: 'active' })], {
      pauseAutomation: vi.fn().mockRejectedValue(new Error('nope')),
    });
    renderView(api);
    await screen.findByText('Watch CI');
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(await screen.findByText('nope')).toBeInTheDocument();
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

  it('renders subagents when present', async () => {
    const subagent: Subagent = {
      id: 'g1',
      automationId: 'a1',
      origin: { sessionId: null, featureId: null },
      task: 'Analyze failure',
      status: 'running',
      progress: 'reading logs',
      result: null,
      sessionId: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const api = client([], {}, [subagent]);
    renderView(api);
    expect(await screen.findByText('Analyze failure')).toBeInTheDocument();
    expect(screen.getByText('Subagents')).toBeInTheDocument();
    expect(screen.getByText('reading logs')).toBeInTheDocument();
  });
});
