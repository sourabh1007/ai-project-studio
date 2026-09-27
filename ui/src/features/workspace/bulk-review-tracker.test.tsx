import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { BulkReviewTracker, deriveCard } from './bulk-review-tracker.js';
import { createReviewBoardRunStore, reviewBoardRunStore, type ReviewBoardRunState } from '../review-board-page/review-board-run-store.js';
import { initialLiveState } from '../../lib/stream.js';

vi.mock('../../app/api-context.js', () => ({ useApi: () => ({}) }));
vi.mock('../../hooks/use-agent-usage.js', () => ({
  useAgentUsage: () => ({
    aic: 12.5, operations: 1, unknownOperations: 0, running: false, snapshots: [],
    byFeature: {}, incompleteFeatures: 0, loading: false, error: false,
  }),
}));

function state(statuses: string[], boardStatuses?: string[]): ReviewBoardRunState {
  const initial = createReviewBoardRunStore().getState('test');
  return {
    ...initial,
    analyzed: true,
    board: {
      perspectives: statuses.map((_, i) => ({
        id: `${i}`, name: `${i}`, status: boardStatuses?.[i] ?? 'approved', risk: 'low', findings: [],
      })),
      recommendation: 'needs-review',
    } as unknown as ReviewBoardRunState['board'],
    progress: Object.fromEntries(statuses.map((status, i) => [i, {
      status, skipReason: null, checked: null, rationale: [], checks: [], error: null, attempt: 0,
    }])) as ReviewBoardRunState['progress'],
  };
}

describe('bulk review completion', () => {
  beforeEach(() => {
    vi.spyOn(reviewBoardRunStore, 'load').mockResolvedValue();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
  it.each([
    [['done', 'done'], 'done', 2],
    [['done', 'error'], 'failed', 1],
    [['error', 'error'], 'failed', 0],
    [['skipped', 'skipped'], 'skipped', 0],
    [['done', 'skipped'], 'partial', 1],
    [['done', 'pending'], 'incomplete', 1],
    [[], 'incomplete', 0],
  ])('counts successful reviews only: %j', (statuses, expected, done) => {
    const model = deriveCard(state(statuses as string[]));
    expect(model.status).toBe(expected);
    expect(model.done).toBe(done);
  });

  it('rejects stale success counters paired with a blank board', () => {
    expect(deriveCard(state(['done', 'done'], ['not-started', 'not-started']))).toMatchObject({
      status: 'incomplete', done: 0, total: 2,
    });
  });

  it('ignores progress from perspectives no longer on the board', () => {
    const s = state(['done']);
    s.progress.obsolete = { ...s.progress['0'], status: 'error' };
    expect(deriveCard(s)).toMatchObject({ status: 'done', total: 1, failed: 0 });
  });

  it('reflects preparation errors and active lifecycle states', () => {
    const s = state(['done']);
    expect(deriveCard({ ...s, running: true }).status).toBe('reviewing');
    expect(deriveCard({ ...s, prep: { active: true, message: '', error: null } }).status).toBe('preparing');
    expect(deriveCard({ ...s, prep: { active: false, message: '', error: 'failed' } }).status).toBe('failed');
    expect(deriveCard({ ...s, loadError: 'offline' }).status).toBe('failed');
    expect(deriveCard({ ...s, analyzed: false }).status).toBe('queued');
  });

  it('shows honest counts and provides retry instead of a green completed row', () => {
    const s = state(['done', 'error']);
    const get = vi.spyOn(reviewBoardRunStore, 'getState').mockReturnValue(s);
    const subscribe = vi.spyOn(reviewBoardRunStore, 'subscribe').mockReturnValue(() => {});
    const enqueue = vi.spyOn(reviewBoardRunStore, 'enqueueBulk').mockImplementation(() => {});
    const view = render(<BulkReviewTracker prs={[{ featureId: 'f1', number: 7, title: 'Review' }]} />);
    expect(screen.getByText('0 completed')).toBeTruthy();
    expect(screen.getByText(/12.5.*AIC/)).toBeTruthy();
    expect(screen.getByText('1/2 reviewed')).toBeTruthy();
    expect(screen.queryByText('Completed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry review for PR #7' }));
    expect(enqueue).toHaveBeenCalledWith(['f1'], expect.anything(), { retry: true });
    view.unmount();
    get.mockRestore(); subscribe.mockRestore(); enqueue.mockRestore();
  });
  it('shows frozen per-PR duration and wall-clock batch time rather than summing parallel reviews', () => {
    const a = { ...state(['done']), timing: { startedAt: 1000, finishedAt: 61_000 } };
    const b = { ...state(['done']), timing: { startedAt: 2000, finishedAt: 91_000 } };
    vi.spyOn(reviewBoardRunStore, 'getState').mockImplementation((id) => id === 'a' ? a : b);
    vi.spyOn(reviewBoardRunStore, 'subscribe').mockReturnValue(() => {});
    vi.spyOn(reviewBoardRunStore, 'enqueueBulk').mockImplementation(() => {});
    render(<BulkReviewTracker prs={[
      { featureId: 'a', number: 1, title: 'First' }, { featureId: 'b', number: 2, title: 'Second' },
    ]} />);
    expect(screen.getByText('Batch review time: 1m 30s')).toBeTruthy();
    expect(screen.getByText('Review time: 1m 0s')).toBeTruthy();
    expect(screen.getByText('Review time: 1m 29s')).toBeTruthy();
  });
  it('updates live time and reads newly opened PRs without scheduling or cancelling reviews', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const running = { ...state(['pending']), running: true, timing: { startedAt: 5000, finishedAt: null } };
    vi.spyOn(reviewBoardRunStore, 'getState').mockReturnValue(running);
    vi.spyOn(reviewBoardRunStore, 'subscribe').mockReturnValue(() => {});
    const enqueue = vi.spyOn(reviewBoardRunStore, 'enqueueBulk').mockImplementation(() => {});
    const first = [{ featureId: 'a', number: 1, title: 'First' }];
    const view = render(<BulkReviewTracker prs={first} />);
    expect(screen.getByText('Batch elapsed: 5s')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('Elapsed: 7s')).toBeTruthy();
    view.rerender(<BulkReviewTracker prs={[...first, { featureId: 'b', number: 2, title: 'Second' }]} />);
    expect(reviewBoardRunStore.load).toHaveBeenCalledWith('b', expect.anything());
    expect(enqueue).not.toHaveBeenCalled();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    render(<BulkReviewTracker prs={[...first, { featureId: 'b', number: 2, title: 'Second' }]} />);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('shows per-PR preparation and the latest active perspective activity from the existing live stream', () => {
    const s = { ...state(['analyzing']), running: true };
    const get = vi.spyOn(reviewBoardRunStore, 'getState').mockReturnValue(s);
    vi.spyOn(reviewBoardRunStore, 'subscribe').mockReturnValue(() => {});
    vi.spyOn(reviewBoardRunStore, 'enqueueBulk').mockImplementation(() => {});
    const prs = [{ featureId: 'f-live', number: 7, title: 'Live review' }];
    const view = render(<BulkReviewTracker prs={prs} live={{
      ...initialLiveState,
      reviewBoardActivity: { 'f-live:0': { sessionId: 's1', lines: ['Reading code', 'Checking caller paths'] } },
    }} />);
    expect(screen.getByText('0: Checking caller paths')).toBeTruthy();
    expect(screen.queryByText('Reading code')).toBeNull();
    get.mockReturnValue({ ...s, running: false, prep: { active: true, message: 'Waiting for change evidence…', error: null }, progress: {} });
    view.rerender(<BulkReviewTracker prs={prs} />);
    expect(screen.getByText('Waiting for change evidence…')).toBeTruthy();
  });
});
