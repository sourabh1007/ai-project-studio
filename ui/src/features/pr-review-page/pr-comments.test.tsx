import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { PrCommentThread } from '../../lib/types.js';
import {
  CommentableDiff,
  PrCommentsPanel,
  usePrComments,
  type PrCommentsController,
} from './pr-comments.js';

function thread(overrides: Partial<PrCommentThread> & { id: string }): PrCommentThread {
  return {
    path: 'src/a.cs',
    line: 3,
    status: 'active',
    comments: [{ id: `${overrides.id}-c`, author: 'alice', body: 'nit', createdAt: null }],
    ...overrides,
  };
}

/** Renders a child that consumes the controller so the hook can be exercised. */
function Harness({
  client,
  featureId = 'f1',
  children,
}: {
  client: Partial<ApiClient>;
  featureId?: string;
  children: (c: PrCommentsController) => React.ReactNode;
}) {
  function Inner() {
    const controller = usePrComments(featureId);
    return <>{children(controller)}</>;
  }
  return (
    <ApiProvider value={client as unknown as ApiClient}>
      <Inner />
    </ApiProvider>
  );
}

describe('PrCommentsPanel', () => {
  it('lists loaded threads and the open count', async () => {
    const client: Partial<ApiClient> = {
      listPrReviewComments: vi
        .fn()
        .mockResolvedValue([
          thread({ id: 't1' }),
          thread({ id: 't2', line: 9, status: 'resolved' }),
        ]),
    };
    render(
      <Harness client={client}>
        {(c) => <PrCommentsPanel comments={c} />}
      </Harness>,
    );
    expect(await screen.findByText('a.cs:3')).toBeInTheDocument();
    expect(screen.getByText('1 open')).toBeInTheDocument();
  });

  it('renders comment bodies as sanitized Markdown and HTML', async () => {
    const client: Partial<ApiClient> = {
      listPrReviewComments: vi.fn().mockResolvedValue([
        thread({
          id: 't1',
          comments: [
            {
              id: 'c1',
              author: 'alice',
              body: [
                '## Violation',
                '',
                '**bold** [docs](https://example.test)',
                '',
                '<details><summary>More</summary><table><tr><td>x</td></tr></table></details>',
                '<script>alert(1)</script>',
              ].join('\n'),
              createdAt: null,
            },
          ],
        }),
      ]),
    };
    render(
      <Harness client={client}>
        {(c) => <PrCommentsPanel comments={c} />}
      </Harness>,
    );

    expect(
      await screen.findByRole('heading', { name: 'Violation' }),
    ).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('More').tagName).toBe('SUMMARY');
    expect(document.querySelector('.pr-comment-body script')).toBeNull();
  });

  it('shows an empty state when there are no threads', async () => {
    const client: Partial<ApiClient> = {
      listPrReviewComments: vi.fn().mockResolvedValue([]),
    };
    render(
      <Harness client={client}>
        {(c) => <PrCommentsPanel comments={c} />}
      </Harness>,
    );
    expect(
      await screen.findByText('No comments on this PR yet.'),
    ).toBeInTheDocument();
  });

  it('resolves a thread and reflects the new status', async () => {
    const client: Partial<ApiClient> = {
      listPrReviewComments: vi.fn().mockResolvedValue([thread({ id: 't1' })]),
      setPrReviewCommentStatus: vi
        .fn()
        .mockResolvedValue(thread({ id: 't1', status: 'resolved' })),
    };
    render(
      <Harness client={client}>
        {(c) => <PrCommentsPanel comments={c} />}
      </Harness>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(client.setPrReviewCommentStatus).toHaveBeenCalledWith(
        'f1',
        't1',
        'resolved',
      ),
    );
    expect(await screen.findByText('0 open')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reopen' }),
    ).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    const client: Partial<ApiClient> = {
      listPrReviewComments: vi.fn().mockRejectedValue(new Error('nope')),
    };
    render(
      <Harness client={client}>
        {(c) => <PrCommentsPanel comments={c} />}
      </Harness>,
    );
    expect(await screen.findByText('nope')).toBeInTheDocument();
  });
});

const DIFF = ['@@ -1,1 +1,2 @@', ' ctx', '+added'].join('\n');

describe('CommentableDiff', () => {
  it('posts a comment on the clicked line in place', async () => {
    const created = thread({ id: 'new', line: 2, comments: [] });
    const client: Partial<ApiClient> = {
      listPrReviewComments: vi.fn().mockResolvedValue([]),
      addPrReviewComment: vi.fn().mockResolvedValue(created),
    };
    render(
      <Harness client={client}>
        {(c) => <CommentableDiff comments={c} path="src/a.cs" diff={DIFF} />}
      </Harness>,
    );
    // Click the added line (new-side line 2) to open the in-place composer.
    fireEvent.click(await screen.findByLabelText('Comment on line 2'));
    fireEvent.change(screen.getByLabelText('Comment body'), {
      target: { value: 'looks good' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() =>
      expect(client.addPrReviewComment).toHaveBeenCalledWith('f1', {
        path: 'src/a.cs',
        line: 2,
        body: 'looks good',
      }),
    );
  });

  it('closes the composer when Cancel is clicked', async () => {
    const client: Partial<ApiClient> = {
      listPrReviewComments: vi.fn().mockResolvedValue([]),
    };
    render(
      <Harness client={client}>
        {(c) => <CommentableDiff comments={c} path="src/a.cs" diff={DIFF} />}
      </Harness>,
    );
    fireEvent.click(await screen.findByLabelText('Comment on line 1'));
    expect(screen.getByLabelText('Comment body')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Comment body')).not.toBeInTheDocument();
  });

  it('renders an existing thread inline at its line and loose threads above', async () => {
    const client: Partial<ApiClient> = {
      listPrReviewComments: vi
        .fn()
        .mockResolvedValue([
          thread({ id: 't1', path: 'src/a.cs', line: 2 }),
          thread({ id: 't2', path: 'src/a.cs', line: 99 }),
          thread({ id: 't3', path: 'src/other.cs', line: 2 }),
        ]),
    };
    render(
      <Harness client={client}>
        {(c) => <CommentableDiff comments={c} path="src/a.cs" diff={DIFF} />}
      </Harness>,
    );
    // Inline thread on line 2 and the off-diff thread on line 99 both show; the
    // other file's thread does not.
    expect(await screen.findByText('a.cs:2')).toBeInTheDocument();
    expect(screen.getByText('a.cs:99')).toBeInTheDocument();
    expect(screen.queryByText('other.cs:2')).not.toBeInTheDocument();
  });

  it('reports when there is no diff to comment on', async () => {
    const client: Partial<ApiClient> = {
      listPrReviewComments: vi.fn().mockResolvedValue([]),
    };
    render(
      <Harness client={client}>
        {(c) => <CommentableDiff comments={c} path="src/a.cs" diff="" />}
      </Harness>,
    );
    expect(
      await screen.findByText(/No diff is available/),
    ).toBeInTheDocument();
  });
});
