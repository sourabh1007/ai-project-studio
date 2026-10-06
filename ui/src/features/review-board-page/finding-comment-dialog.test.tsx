import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { FindingCommentAnchor } from '../../lib/finding-comment.js';
import type { PrCommentThread, ReviewFinding } from '../../lib/types.js';
import { FindingCommentDialog } from './finding-comment-dialog.js';

const finding: ReviewFinding = {
  id: 'security/ai-0', perspectiveId: 'security', title: 'Wrong buffer lifetime',
  detail: 'Keep the buffer alive.', severity: 'high', status: 'warning', evidence: [],
};
const anchor: FindingCommentAnchor = { path: 'src/Buffer.cpp', line: 2647, text: 'release(buffer);', legacy: false };
const created: PrCommentThread = {
  id: 'thread-1', path: anchor.path, line: anchor.line, status: 'active', comments: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function setup(options: {
  post?: ReturnType<typeof vi.fn>;
  anchors?: FindingCommentAnchor[];
  current?: () => boolean;
  headSha?: string | null;
} = {}) {
  const post = options.post ?? vi.fn().mockResolvedValue(created);
  const api: Partial<ApiClient> = { addPrReviewComment: post };
  const onPosted = vi.fn();
  const onClose = vi.fn();
  render(
    <ApiProvider value={api as ApiClient}>
      <FindingCommentDialog featureId="feature-7" finding={finding} pullNumber={2312070}
        pullUrl="https://example.test/pr/2312070" headSha={options.headSha === undefined ? 'reviewed-sha' : options.headSha}
        anchors={options.anchors ?? [anchor]} isCurrent={options.current ?? (() => true)}
        onPosted={onPosted} onClose={onClose} />
    </ApiProvider>,
  );
  return { post, onPosted, onClose };
}

describe('FindingCommentDialog', () => {
  it('does not post on open or cancel and allows comment editing', () => {
    const { post, onPosted, onClose } = setup();
    expect(screen.getByLabelText('Comment')).toHaveValue('Wrong buffer lifetime\n\nKeep the buffer alive.');
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Edited suggestion' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(post).not.toHaveBeenCalled();
    expect(onPosted).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('posts edited text exactly once to the reported line and resolves the finding only after success', async () => {
    const pending = deferred<PrCommentThread>();
    const { post, onPosted, onClose } = setup({ post: vi.fn().mockReturnValue(pending.promise) });
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: '  Edited suggestion  ' } });
    const submit = screen.getByRole('button', { name: 'Leave comment' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith('feature-7', {
      path: 'src/Buffer.cpp', line: 2647, body: 'Edited suggestion', expectedHeadSha: 'reviewed-sha',
    });
    expect(screen.getByRole('button', { name: /Posting comment/ })).toBeDisabled();
    expect(onPosted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    pending.resolve(created);
    await waitFor(() => expect(onPosted).toHaveBeenCalledOnce());
  });

  it('preserves the draft on errors and requires checking the PR before a manual retry', async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error('Provider timed out')).mockResolvedValueOnce(created);
    const { onPosted } = setup({ post });
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await screen.findByText('Provider timed out');
    expect(onPosted).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Comment')).toHaveValue('Keep this draft');
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I checked the PR/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await waitFor(() => expect(onPosted).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('requires explicit selection among reported lines and confirmation of legacy diff side', async () => {
    const { post } = setup({ anchors: [{ ...anchor, line: 20 }, { ...anchor, legacy: true }] });
    const submit = screen.getByRole('button', { name: 'Leave comment' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Agent-reported location/), { target: { value: '1' } });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /This older finding/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0][1].line).toBe(2647);
  });

  it.each([
    { headSha: null, text: /reviewed commit is unknown/ },
    { current: () => false, text: /review changed or is running/ },
  ])('blocks posting when the anchor or identity is unavailable', (options) => {
    const { post } = setup(options);
    expect(screen.getByText(options.text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('offers a PR-level fallback when no precise anchor exists and posts an unanchored comment', async () => {
    const post = vi.fn().mockResolvedValue({ ...created, path: null, line: null });
    const { onPosted } = setup({ anchors: [], headSha: null, post });
    expect(screen.getByText(/this will be posted as a/)).toBeInTheDocument();
    // Blocked until the reviewer opts in to the unanchored post.
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Post this as an unanchored PR-level comment/));
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0][1]).toEqual({ body: 'Wrong buffer lifetime\n\nKeep the buffer alive.' });
    await waitFor(() => expect(onPosted).toHaveBeenCalledOnce());
  });

  it('blocks blank comments', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: ' \n ' } });
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
  });

  it('never resolves or reposts after a successful post against a now-stale finding', async () => {
    const pending = deferred<PrCommentThread>();
    let current = true;
    const { onPosted } = setup({ current: () => current, post: vi.fn().mockReturnValue(pending.promise) });
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    current = false;
    pending.resolve(created);
    await screen.findByText(/Comment posted, but the review changed/);
    expect(onPosted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
  });

  it('does not resolve a finding if the provider returns a different line', async () => {
    const { onPosted } = setup({ post: vi.fn().mockResolvedValue({ ...created, line: 20 }) });
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await screen.findByText(/provider returned a different comment location/);
    expect(onPosted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
  });
});
