import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { PlannerTaskEvidence, PlannerTrackingControl } from './planner-tracking.js';
import type { PlannerTrackingJob, PlannerTrackingStatus } from '../../lib/types.js';
import { PlannerView } from './planner-view.js';
import { todayIso } from '../../lib/planner-dates.js';

afterEach(() => vi.useRealTimers());
const status: PlannerTrackingStatus = {
  enabled: true, running: false, queued: 0, lastUpdatedAt: null, error: null,
};
const job: PlannerTrackingJob = {
  featureId: 'feature-lock', workspaceName: 'Release the initialization lock', repositoryName: 'org/platform',
  queuedAt: '2026-04-04T10:00:00Z', startedAt: null, phase: 'queued', retryAt: null, evidenceCount: null, sessionCount: null,
};
function api() {
  return {
    plannerTrackingStatus: vi.fn(async () => status),
    setPlannerTracking: vi.fn(async (enabled: boolean) => ({ ...status, enabled })),
    plannerTaskEvidence: vi.fn(async () => null as unknown),
  };
}
describe('quiet incremental Planner tracking', () => {
  it('shows actual active and queued workspace identities, evidence counts, timing and retry eligibility', async () => {
    const client = api();
    client.plannerTrackingStatus.mockResolvedValue({
      ...status, running: true, queued: 1, pollIntervalMs: 15000,
      currentJob: { ...job, phase: 'analyzing', startedAt: job.queuedAt, evidenceCount: 6, sessionCount: 2 },
      jobs: [{ ...job, featureId: 'feature-retry', workspaceName: 'Check repository import', repositoryName: null, phase: 'retry-wait', retryAt: '2026-04-04T10:01:00Z' }],
    });
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Tracking work' }));
    const queue = screen.getByRole('region', { name: 'Tracking jobs' });
    expect(within(queue).getByText(job.workspaceName)).toBeInTheDocument();
    expect(within(queue).getByText('org/platform')).toBeInTheDocument();
    expect(within(queue).getByText('Analyzing evidence')).toBeInTheDocument();
    expect(within(queue).getByText(/6 evidence records.*2 sessions in evidence/)).toBeInTheDocument();
    expect(within(queue).getByText('Check repository import')).toBeInTheDocument();
    expect(within(queue).getByText('No linked repository')).toBeInTheDocument();
    expect(within(queue).getByText('Retry wait')).toBeInTheDocument();
    expect(within(queue).getByText(/Retry eligible after/).querySelector('time')).toHaveAttribute('datetime', '2026-04-04T10:01:00Z');
    expect(screen.getByText('How tracking works').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('How tracking works'));
    expect(screen.getByText(/Manual edits are preserved/)).toBeVisible();
    expect(screen.getByText(/Discovery may reorder the queue/)).toBeInTheDocument();
  });
  it('keeps waiting work visibly paused and distinguishes an empty successful pass from a skipped one', async () => {
    const client = api();
    client.plannerTrackingStatus.mockResolvedValue({
      ...status, enabled: false, queued: 1, jobs: [job],
      lastRun: { job, finishedAt: job.queuedAt, outcome: 'updated', taskCount: 0 },
    });
    const { unmount } = render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Tracking paused' }));
    expect(within(screen.getByRole('region', { name: 'Tracking jobs' })).getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Queued work is retained while paused.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Last tracking pass' })).getByText('No task changes')).toBeInTheDocument();
    unmount();
    client.plannerTrackingStatus.mockResolvedValue({
      ...status, jobs: [], lastRun: { job, finishedAt: job.queuedAt, outcome: 'unchanged', taskCount: null },
    });
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Auto tracking' }));
    expect(screen.getByText('No new evidence')).toBeInTheDocument();
    expect(screen.getByText(/Nothing waiting/)).toBeInTheDocument();
  });
  it('hides stale active/queue details after a poll failure but retains a clearly labelled last-known failed pass', async () => {
    vi.useFakeTimers();
    const client = api();
    client.plannerTrackingStatus.mockResolvedValue({
      ...status, running: true, queued: 1, jobs: [{ ...job, workspaceName: 'Waiting workspace' }],
      currentJob: { ...job, phase: 'reading', startedAt: job.queuedAt },
      lastRun: { job: { ...job, retryAt: '2026-04-04T10:01:00Z' }, finishedAt: job.queuedAt, outcome: 'failed', taskCount: null },
    });
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Tracking work' }));
    expect(screen.getByText('Reading activity')).toBeInTheDocument();
    client.plannerTrackingStatus.mockRejectedValue(new Error('offline'));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    const queue = screen.getByRole('region', { name: 'Tracking jobs' });
    expect(within(queue).queryByText('Reading activity')).not.toBeInTheDocument();
    expect(within(queue).queryByText('Waiting workspace')).not.toBeInTheDocument();
    expect(within(queue).getByText('Queue details are unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Last known pass')).toBeInTheDocument();
    expect(screen.getByText('Pass failed')).toBeInTheDocument();
    expect(screen.getByText(/rediscovery or new activity schedules another check/)).toBeInTheDocument();
  });
  it.each([
    { paneRight: 900, anchorLeft: 337, expectedWidth: '360px', expectedLeft: '0px' },
    { paneRight: 900, anchorLeft: 860, expectedWidth: '360px', expectedLeft: '-328px' },
    { paneRight: 340, anchorLeft: 300, expectedWidth: '264px', expectedLeft: '-232px' },
  ])('keeps the disclosure inside the workspace at $paneRight/$anchorLeft', async ({ paneRight, anchorLeft, expectedWidth, expectedLeft }) => {
    render(<ApiProvider value={api() as unknown as ApiClient}><div className="planner">
      <PlannerTrackingControl onUpdated={vi.fn()} />
    </div></ApiProvider>);
    const trigger = await screen.findByRole('button', { name: 'Auto tracking' });
    const disclosure = trigger.closest('details')!;
    const popup = disclosure.querySelector<HTMLElement>('.planner-tracking-popover')!;
    vi.spyOn(disclosure.closest('.planner')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(60, 0, paneRight - 60, 700));
    vi.spyOn(disclosure, 'getBoundingClientRect').mockReturnValue(new DOMRect(anchorLeft, 40, 28, 28));
    Object.defineProperty(popup, 'scrollHeight', { configurable: true, value: 500 });
    fireEvent.click(trigger);
    fireEvent(disclosure, new Event('toggle'));
    expect(popup.style.width).toBe(expectedWidth);
    expect(popup.style.left).toBe(expectedLeft);
    expect(screen.getByRole('button', { name: 'Pause tracking' })).toBeInTheDocument();
    vi.mocked(disclosure.getBoundingClientRect).mockReturnValue(new DOMRect(anchorLeft, window.innerHeight - 60, 28, 28));
    fireEvent(window, new Event('resize'));
    expect(popup.style.top).toBe('auto');
    expect(popup.style.bottom).toBe('calc(100% + 4px)');
  });
  it('refreshes captured tasks without replacing the quick-add or row-edit drafts', async () => {
    vi.useFakeTimers();
    localStorage.clear();
    const task = {
      id: 'task', title: 'Captured work', notes: '', date: todayIso(), status: 'open', priority: 'p2',
      kind: 'task', prUrl: '', repoId: null, launchKind: null, featureId: null, sessionId: null,
      launchLabel: null, backloggedAt: null, createdAt: '', updatedAt: '', automaticallyTracked: true,
    };
    const client = {
      ...api(), listPlannerTasks: vi.fn(async () => [task]), listRepos: vi.fn(async () => []),
    };
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerView onLaunch={vi.fn()} /></ApiProvider>);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Show tracked work evidence' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New task'), { target: { value: 'My unsaved next task' } });
    fireEvent.click(screen.getByRole('button', { name: 'Captured work' }));
    fireEvent.change(screen.getByLabelText('Edit task title'), { target: { value: 'My own work wording' } });
    client.plannerTrackingStatus.mockResolvedValue({ ...status, lastUpdatedAt: '2026-04-04T10:00:00Z' });
    client.listPlannerTasks.mockResolvedValue([{ ...task, title: 'A new generated title' }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(client.listPlannerTasks).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('New task')).toHaveValue('My unsaved next task');
    expect(screen.getByLabelText('Edit task title')).toHaveValue('My own work wording');
  });
  it.each([
    { next: status, label: 'Auto tracking', description: 'Auto tracking is enabled.', activity: 'Watching for work' },
    { next: { ...status, running: true }, label: 'Tracking work', description: 'Auto tracking is processing recorded work.', activity: 'Processing work' },
    { next: { ...status, enabled: false }, label: 'Tracking paused', description: 'Auto tracking is paused.', activity: 'Paused' },
    { next: { ...status, error: 'Tracking needs attention.' }, label: 'Auto tracking', description: 'Tracking needs attention.', activity: 'Needs attention' },
    { next: { ...status, queued: 2 }, label: 'Auto tracking', description: 'Auto tracking is enabled.', activity: 'Waiting for next pass' },
    { next: { ...status, running: true, error: 'Previous tracking pass failed.' }, label: 'Tracking work', description: 'Previous tracking pass failed.', activity: 'Processing work' },
  ])('keeps the icon-only $label control accessible with an honest status', async ({ next, label, description, activity }) => {
    const client = api();
    client.plannerTrackingStatus.mockResolvedValue(next);
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    const control = await screen.findByRole('button', { name: label });
    expect(control.textContent).toBe('');
    expect(control).toHaveAttribute('title', `${description} Click for settings and details.`);
    fireEvent.click(control);
    expect(control.closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('status')).toHaveTextContent(activity);
    expect(screen.getByRole('status')).toHaveTextContent('No successful update this launch yet.');
    expect(screen.getByRole('button', { name: next.enabled ? 'Pause tracking' : 'Resume tracking' })).toBeInTheDocument();
  });
  it('does not present unavailable status as an empty successful-update history', async () => {
    const client = api();
    client.plannerTrackingStatus.mockRejectedValue(new Error('Unavailable'));
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Work tracking' }));
    expect(screen.getByRole('status')).toHaveTextContent('Checking status');
    await screen.findByText('Tracking status is unavailable.');
    expect(screen.getByRole('status')).toHaveTextContent('Needs attention');
    expect(screen.getByRole('status')).not.toHaveTextContent('No successful update');
  });
  it('stops indicating active work when status becomes unavailable, retaining the last successful update', async () => {
    vi.useFakeTimers();
    const client = api();
    client.plannerTrackingStatus.mockResolvedValue({
      ...status, running: true, lastUpdatedAt: '2026-04-04T10:00:00Z',
    });
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    await act(async () => {});
    const control = screen.getByRole('button', { name: 'Tracking work' });
    fireEvent.click(control);
    expect(control).toHaveAttribute('data-state', 'running');
    client.plannerTrackingStatus.mockRejectedValue(new Error('Unavailable'));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(control).toHaveAttribute('data-state', 'error');
    expect(screen.getByRole('button', { name: 'Work tracking' })).toBe(control);
    expect(screen.getByRole('status')).toHaveTextContent('Needs attention');
    expect(screen.getByText(/Last successful update:/).querySelector('time'))
      .toHaveAttribute('datetime', '2026-04-04T10:00:00Z');
  });
  it('shows a compact disclosure, persists pause/resume and reloads only when work changes', async () => {
    vi.useFakeTimers();
    const client = api();
    const onUpdated = vi.fn();
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={onUpdated} /></ApiProvider>);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Auto tracking' })).toBeInTheDocument();
    expect(onUpdated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Auto tracking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause tracking' }));
    await act(async () => {});
    expect(client.setPlannerTracking).toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: 'Tracking paused' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume tracking' }));
    await act(async () => {});
    client.plannerTrackingStatus.mockResolvedValue({ ...status, lastUpdatedAt: '2026-04-04T10:00:00Z' });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Last successful update:/).querySelector('time'))
      .toHaveAttribute('datetime', '2026-04-04T10:00:00Z');
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });
  it('does not load evidence until requested, then shows source kinds and reported completion honestly', async () => {
    const client = api();
    client.plannerTaskEvidence.mockResolvedValue({
      featureId: 'f', updatedAt: '', completion: 'reported-complete',
      evidence: [{
        id: 'skill', kind: 'skill', label: 'Repo review (repository; context-injected)',
        text: 'Prepared for context, not a recorded invocation.', at: '', sessionId: 's', completed: false, truncated: true,
      }],
    });
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTaskEvidence taskId="task" /></ApiProvider>);
    expect(client.plannerTaskEvidence).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show tracked work evidence' }));
    expect(await screen.findByText(/Reported complete, not independently verified/)).toBeInTheDocument();
    expect(client.plannerTaskEvidence).toHaveBeenCalledWith('task');
    fireEvent.click(screen.getByText('skill: Repo review (repository; context-injected)'));
    expect(screen.getByText('Prepared for context, not a recorded invocation.')).toBeInTheDocument();
    expect(screen.getByText(/Excerpt only/)).toBeInTheDocument();
  });
  it('shows failures without claiming empty evidence or successful preference changes', async () => {
    const client = api();
    client.setPlannerTracking.mockRejectedValue(new Error('offline'));
    const { unmount } = render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    await screen.findByRole('button', { name: 'Auto tracking' });
    fireEvent.click(screen.getByRole('button', { name: 'Auto tracking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause tracking' }));
    await screen.findByText('Tracking preference could not be saved.');
    expect(screen.getByRole('button', { name: 'Work tracking' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause tracking' })).toBeInTheDocument();
    unmount();
    client.plannerTaskEvidence.mockRejectedValue(new Error('Evidence unavailable'));
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTaskEvidence taskId="task" /></ApiProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Show tracked work evidence' }));
    await screen.findByText('Evidence unavailable');
    expect(screen.queryByText('No recorded tracking evidence.')).not.toBeInTheDocument();
  });
  it('ignores stale in-flight status after pause and stops polling after unmount', async () => {
    vi.useFakeTimers();
    const client = api();
    let resolve!: (value: PlannerTrackingStatus) => void;
    const { unmount } = render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    await act(async () => {});
    client.plannerTrackingStatus.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    fireEvent.click(screen.getByRole('button', { name: 'Auto tracking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause tracking' }));
    await act(async () => {});
    await act(async () => { resolve(status); });
    expect(screen.getByRole('button', { name: 'Tracking paused' })).toBeInTheDocument();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(client.plannerTrackingStatus).toHaveBeenCalledTimes(2);
  });
  it('polls no work while the window is hidden and refreshes on visibility', async () => {
    const client = api();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<ApiProvider value={client as unknown as ApiClient}><PlannerTrackingControl onUpdated={vi.fn()} /></ApiProvider>);
    expect(client.plannerTrackingStatus).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(client.plannerTrackingStatus).toHaveBeenCalledTimes(1));
    visibility.mockRestore();
  });
});
