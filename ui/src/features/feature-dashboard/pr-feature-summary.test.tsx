import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PrFeatureSummary, pullRequestUrl } from './pr-feature-summary.js';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';

afterEach(cleanup);
const url = 'https://dev.azure.com/org/project/_git/repo/pullrequest/42';
const review = {
  featureId: 'f1', repoId: 'r1', pull: { number: 42, title: 'Fix', url, sourceBranch: 'users/alice/fix', author: 'Alice' },
  baseBranch: 'main', headSha: 'abcdef123456', changedFiles: 3,
  worktreePath: 'C:\\repos\\.ai-worktrees\\repo-pr-42',
  timestamps: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
};
function show(api: Partial<ApiClient>) {
  return render(<ApiProvider value={api as ApiClient}><PrFeatureSummary featureId="f1" url={url} /></ApiProvider>);
}

it('renders a safe clickable PR link and stored branch, author, commit, and changed-file count', async () => {
  const api = { getPrReview: vi.fn().mockResolvedValue(review), listRepoPulls: vi.fn() };
  show(api);
  expect(screen.getByRole('link', { name: url })).toHaveAttribute('href', url);
  expect(screen.getByRole('link', { name: url })).toHaveAttribute('rel', 'noopener noreferrer');
  await screen.findByText('users/alice/fix → main');
  expect(screen.getByText('Alice')).toBeInTheDocument();
  expect(screen.getByTitle('abcdef123456')).toHaveTextContent('abcdef12');
  expect(screen.getByText('Changed files').nextElementSibling).toHaveTextContent('3');
  expect(api.listRepoPulls).not.toHaveBeenCalled();
});

it('fills missing metadata on older imported PRs from the exact matching remote PR', async () => {
  const api = {
    getPrReview: vi.fn().mockResolvedValue({ ...review, pull: { number: 42, title: 'Fix', url } }),
    listRepoPulls: vi.fn().mockResolvedValue([
      { number: 43, sourceBranch: 'wrong', author: 'Wrong author' },
      { number: 42, sourceBranch: 'feature/fix', author: 'Bob' },
    ]),
  };
  show(api);
  await screen.findByText('Bob');
  expect(screen.getByText('feature/fix → main')).toBeInTheDocument();
  expect(screen.queryByText('Wrong author')).toBeNull();
  expect(api.listRepoPulls).toHaveBeenCalledWith('r1');
});

it('keeps the link and existing details when metadata lookup fails and offers retry', async () => {
  const api = {
    getPrReview: vi.fn().mockResolvedValue({ ...review, pull: { ...review.pull, author: null } }),
    listRepoPulls: vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([]),
  };
  show(api);
  await screen.findByText('PR details: Offline');
  expect(screen.getByRole('link', { name: url })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry PR details' }));
  await waitFor(() => expect(screen.queryByText('PR details: Offline')).toBeNull());
  expect(screen.getByText('Not available')).toBeInTheDocument();
});

it.each([
  ['https://github.com/org/repo/pull/2', 'https://github.com/org/repo/pull/2'],
  [url, url], ['https://user:secret@example.com/pull/2', null],
  ['javascript:alert(1)', null], ['A plain feature description', null],
  ['https://example.com/documentation', null],
])('recognizes PR descriptions without unsafe or unrelated links: %s', (input, expected) => {
  expect(pullRequestUrl(input)).toBe(expected);
});
