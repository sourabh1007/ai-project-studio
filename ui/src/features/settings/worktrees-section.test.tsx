import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import { WorktreesSection } from './worktrees-section.js';

afterEach(cleanup);

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
