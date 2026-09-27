import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { WorktreesSection } from './worktrees-section.js';

afterEach(cleanup);
afterEach(() => vi.useRealTimers());

function apiWith(worktrees: Awaited<ReturnType<ApiClient['listWorktrees']>>) {
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    removeWorktree: vi.fn().mockResolvedValue({}),
  } satisfies Partial<ApiClient>;
}

it('renders the review worktrees heading by default', async () => {
  const api = apiWith([]);
  render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection /></ApiProvider>);
  expect(screen.getByRole('heading', { name: 'Review worktrees' })).toBeInTheDocument();
  expect(await screen.findByText('No review worktrees on disk.')).toBeInTheDocument();
});

it('renders worktree rows without the heading when embedded and removes an entry', async () => {
  const api = apiWith([{ repoId: 'repo-id', repoName: 'repo', pullNumber: 42, branch: 'feature', path: 'C:\\repo\\.ai-worktrees\\repo-42' }]);
  render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection embedded /></ApiProvider>);
  expect(screen.queryByRole('heading', { name: 'Review worktrees' })).toBeNull();
  expect(await screen.findByText('repo')).toBeInTheDocument();
  expect(screen.getAllByText(/\.ai-worktrees/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
  await waitFor(() => expect(api.removeWorktree).toHaveBeenCalledWith('C:\\repo\\.ai-worktrees\\repo-42'));
});

it('surfaces worktree removal errors in the body', async () => {
  const api = apiWith([{ repoId: 'repo-id', repoName: 'repo', pullNumber: null, branch: null, path: 'C:\\repo\\wt' }]);
  api.removeWorktree.mockRejectedValueOnce(new Error('remove failed'));
  render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection embedded /></ApiProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Remove/ }));
  expect(await screen.findByText('remove failed')).toBeInTheDocument();
});

function concurrentApi(count = 4) {
  const worktrees = Array.from({ length: count }, (_, i) => ({
    repoId: 'repo-id', repoName: `repo-${i}`, pullNumber: null, branch: 'master',
    path: `C:\\repos\\.ai-worktrees\\repo-session-${i}`,
  }));
  const completions = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
  const api = apiWith(worktrees);
  api.removeWorktree.mockImplementation((path: string) => new Promise<void>((resolve, reject) => {
    completions.set(path, { resolve, reject });
  }));
  return { api, worktrees, completions };
}

function row(name: string) {
  return within(screen.getByText(name).closest('li')!);
}

it('refreshes background feature cleanup and shows its real phase or retryable failure', async () => {
  const { api, worktrees } = concurrentApi(1);
  api.listWorktrees.mockResolvedValue([{ ...worktrees[0],
    removal: { status: 'deleting' as const, message: 'Deleting worktree files...' },
  }]);
  const view = render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection /></ApiProvider>);
  expect(await screen.findByText('Deleting worktree files...')).toBeInTheDocument();
  expect(row('repo-0').getByRole('button', { name: /Remove/ })).toBeDisabled();
  api.listWorktrees.mockResolvedValue([{ ...worktrees[0],
    removal: { status: 'failed' as const, message: 'File is locked' },
  }]);
  fireEvent(window, new Event('focus'));
  expect(await screen.findByText('File is locked')).toBeInTheDocument();
  expect(row('repo-0').getByRole('button', { name: 'Retry removal' })).toBeEnabled();
  vi.useFakeTimers();
  api.listWorktrees.mockResolvedValue([]);
  // Remount ensures the timer is registered with the fake clock.
  view.unmount();
  const refreshed = render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection /></ApiProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText('No review worktrees on disk.')).toBeInTheDocument();
  refreshed.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('starts a second removal before the first finishes, keeps other rows usable, and hides stale removed rows', async () => {
  const { api, worktrees, completions } = concurrentApi();
  render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection /></ApiProvider>);
  await screen.findByText('repo-0');
  fireEvent.click(row('repo-0').getByRole('button', { name: 'Remove' }));
  expect(row('repo-1').getByRole('button', { name: 'Remove' })).toBeEnabled();
  fireEvent.click(row('repo-1').getByRole('button', { name: 'Remove' }));
  expect(api.removeWorktree).toHaveBeenCalledTimes(2);
  expect(row('repo-0').getByRole('status', { name: 'Removal status' })).toHaveTextContent('Deleting worktree');
  expect(row('repo-1').getByRole('status', { name: 'Removal status' })).toHaveTextContent('Deleting worktree');
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await act(async () => { completions.get(worktrees[1].path)!.resolve(); });
  await waitFor(() => expect(api.listWorktrees).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('repo-1')).toBeNull();
  expect(row('repo-0').getByRole('status', { name: 'Removal status' })).toHaveTextContent('Deleting worktree');
  expect(row('repo-2').getByRole('button', { name: 'Remove' })).toBeEnabled();
  await act(async () => { completions.get(worktrees[0].path)!.resolve(); });
});

it('queues only excess rows and starts the next even when another fails; errors and retry are row-local', async () => {
  const { api, worktrees, completions } = concurrentApi();
  render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection embedded /></ApiProvider>);
  await screen.findByText('repo-0');
  for (let i = 0; i < 4; i++) fireEvent.click(row(`repo-${i}`).getByRole('button', { name: 'Remove' }));
  expect(api.removeWorktree).toHaveBeenCalledTimes(3);
  expect(row('repo-3').getByRole('status', { name: 'Removal status' })).toHaveTextContent('Queued for removal');
  await act(async () => { completions.get(worktrees[0].path)!.reject(new Error('checkout is busy')); });
  expect(api.removeWorktree).toHaveBeenCalledTimes(4);
  expect(row('repo-0').getByText('checkout is busy')).toBeInTheDocument();
  expect(row('repo-0').getByRole('button', { name: 'Retry removal' })).toBeEnabled();
  expect(row('repo-3').getByRole('status', { name: 'Removal status' })).toHaveTextContent('Deleting worktree');
  expect(row('repo-1').queryByText('checkout is busy')).toBeNull();
  fireEvent.click(row('repo-0').getByRole('button', { name: 'Retry removal' }));
  expect(row('repo-0').getByRole('status', { name: 'Removal status' })).toHaveTextContent('Queued for removal');
  expect(screen.queryByText('checkout is busy')).toBeNull();
  await act(async () => { completions.get(worktrees[1].path)!.resolve(); });
  expect(api.removeWorktree).toHaveBeenCalledTimes(5);
  await act(async () => {
    completions.get(worktrees[0].path)!.resolve();
    completions.get(worktrees[2].path)!.resolve();
    completions.get(worktrees[3].path)!.resolve();
  });
  expect(await screen.findByText('No review worktrees on disk.')).toBeInTheDocument();
});

it('retains pending rows through refresh and does not replace the list with a loading screen', async () => {
  const { api, worktrees, completions } = concurrentApi(2);
  let finishRefresh!: (value: typeof worktrees) => void;
  render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection /></ApiProvider>);
  await screen.findByText('repo-0');
  fireEvent.click(row('repo-0').getByRole('button', { name: 'Remove' }));
  api.listWorktrees.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(row('repo-1').getByRole('button', { name: 'Remove' })).toBeEnabled();
  expect(screen.queryByText('Loading worktrees')).toBeNull();
  await act(async () => { finishRefresh([]); });
  expect(row('repo-0').getByRole('status', { name: 'Removal status' })).toHaveTextContent('Deleting worktree');
  await act(async () => { completions.get(worktrees[0].path)!.reject('still locked'); });
  expect(row('repo-0').getByText('still locked')).toBeInTheDocument();
});

it('finishes admitted removals after leaving the page without refreshing the unmounted view', async () => {
  const { api, worktrees, completions } = concurrentApi();
  const view = render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection /></ApiProvider>);
  await screen.findByText('repo-0');
  for (let i = 0; i < 4; i++) fireEvent.click(row(`repo-${i}`).getByRole('button', { name: 'Remove' }));
  view.unmount();
  await act(async () => {
    completions.get(worktrees[0].path)!.resolve();
    completions.get(worktrees[1].path)!.reject(new Error('late error'));
    completions.get(worktrees[2].path)!.resolve();
  });
  expect(api.removeWorktree).toHaveBeenCalledTimes(4);
  await act(async () => { completions.get(worktrees[3].path)!.resolve(); });
  expect(api.listWorktrees).toHaveBeenCalledTimes(1);
});

it('allows a subsequently recreated checkout to appear after its removal was confirmed by a refresh', async () => {
  const { api, worktrees, completions } = concurrentApi(1);
  render(<ApiProvider value={api as unknown as ApiClient}><WorktreesSection /></ApiProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
  api.listWorktrees.mockResolvedValueOnce([]);
  await act(async () => { completions.get(worktrees[0].path)!.resolve(); });
  expect(await screen.findByText('No review worktrees on disk.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('repo-0')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled();
});
