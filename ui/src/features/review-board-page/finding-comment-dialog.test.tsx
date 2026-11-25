import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { ApiProvider } from '../../app/api-context.js';
import type { ApiClient } from '../../lib/api.js';
import type { FindingCommentAnchor } from '../../lib/finding-comment.js';
import type { AddPrCommentInput, PrCommentThread, ReviewFinding, ReviewPublication } from '../../lib/types.js';
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
  expectedRunId?: string;
  expectedAssessmentRevision?: number;
  initialPublicationUncertain?: boolean;
  findingGroupId?: string;
  publicationRecords?: ReviewPublication[];
  publicationHistoryUnavailable?: boolean;
  getPublications?: ReturnType<typeof vi.fn>;
  reconcile?: ReturnType<typeof vi.fn>;
} = {}) {
  const post = options.post ?? vi.fn().mockResolvedValue(created);
  const api: Partial<ApiClient> = {
    addPrReviewComment: post,
    getReviewBoardPublications: options.getPublications ?? vi.fn().mockResolvedValue(options.publicationRecords ?? []),
    reconcileReviewBoardPublication: options.reconcile ?? vi.fn(),
  };
  const onPosted = vi.fn();
  const onClose = vi.fn();
  const onPublicationChange = vi.fn();
  const view = render(
    <ApiProvider value={api as ApiClient}>
      <FindingCommentDialog featureId="feature-7" finding={finding} pullNumber={2312070}
        pullUrl="https://example.test/pr/2312070" headSha={options.headSha === undefined ? 'reviewed-sha' : options.headSha}
        anchors={options.anchors ?? [anchor]} isCurrent={options.current ?? (() => true)}
        expectedRunId={options.expectedRunId} expectedAssessmentRevision={options.expectedAssessmentRevision}
        initialPublicationUncertain={options.initialPublicationUncertain}
        findingGroupId={options.findingGroupId} publicationRecords={options.publicationRecords}
        publicationHistoryUnavailable={options.publicationHistoryUnavailable} onPublicationChange={onPublicationChange}
        onPosted={onPosted} onClose={onClose} />
    </ApiProvider>,
  );
  return { post, onPosted, onClose, onPublicationChange, ...view };
}

describe('FindingCommentDialog', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it('uses a stable run/group/body/anchor operation key and recovers a posted operation after remount', async () => {
    const first = setup({ expectedRunId: 'run-one', expectedAssessmentRevision: 4, findingGroupId: 'group-one' });
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Edited actionable comment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await waitFor(() => expect(first.onPosted).toHaveBeenCalledOnce());
    const input = first.post.mock.calls[0][1] as AddPrCommentInput;
    expect(input.publicationKey).toMatch(/^\["run-one","group-one","[a-f0-9]{64}"\]$/);
    first.unmount();
    const record: ReviewPublication = { key: 'server-hash', status: 'posted', input, startedAt: '2026-01-01', thread: created };
    const restored = setup({ expectedRunId: 'run-one', expectedAssessmentRevision: 8, findingGroupId: 'group-one', publicationRecords: [record] });
    expect(screen.getByLabelText('Comment')).toHaveValue('Edited actionable comment');
    expect(screen.getByText('Publication posted. This status does not fix or dismiss the finding.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    expect(restored.post).not.toHaveBeenCalled();
  });

  it('keeps publication keys bounded for long edited comments and stable across assessment revisions', async () => {
    const body = 'Detailed explanation. '.repeat(60);
    const first = setup({ expectedRunId: 'run-one', expectedAssessmentRevision: 4, findingGroupId: 'group-one' });
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: body } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await waitFor(() => expect(first.onPosted).toHaveBeenCalledOnce());
    const key = first.post.mock.calls[0][1].publicationKey;
    expect(key.length).toBeLessThan(500);
    first.unmount();
    const second = setup({ expectedRunId: 'run-one', expectedAssessmentRevision: 5, findingGroupId: 'group-one' });
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: body } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await waitFor(() => expect(second.onPosted).toHaveBeenCalledOnce());
    expect(second.post.mock.calls[0][1].publicationKey).toBe(key);
  });

  it('does not send a mutation or record an uncertain publication when secure identity is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    const { post, onPublicationChange } = setup({ expectedRunId: 'run-one', expectedAssessmentRevision: 4 });
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await screen.findByText(/Secure publication identity is unavailable/);
    expect(post).not.toHaveBeenCalled();
    expect(onPublicationChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reconcile publication' })).not.toBeInTheDocument();
  });

  it('reconciles an ambiguous timeout without offering a blind retry or resending the comment', async () => {
    const post = vi.fn().mockRejectedValue(new Error('Provider timed out after accepting the request.'));
    const record = (): ReviewPublication => ({
      key: 'server-operation', status: 'uncertain', input: post.mock.calls[0][1],
      startedAt: '2026-01-01', error: 'Provider acknowledgement is unavailable.',
    });
    const getPublications = vi.fn(async () => [record()]);
    const reconcile = vi.fn(async () => ({ ...record(), status: 'posted' as const, thread: created }));
    const { onPosted, onPublicationChange } = setup({
      expectedRunId: 'run-one', expectedAssessmentRevision: 4, findingGroupId: 'group-one', post, getPublications, reconcile,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await screen.findByText('Provider timed out after accepting the request.');
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    expect(screen.queryByRole('checkbox', { name: /I checked the PR/ })).not.toBeInTheDocument();
    expect(onPublicationChange).toHaveBeenCalledWith(expect.objectContaining({ key: 'server-operation', status: 'uncertain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile publication' }));
    await waitFor(() => expect(onPosted).toHaveBeenCalledOnce());
    expect(reconcile).toHaveBeenCalledWith('feature-7', 'server-operation');
    expect(post).toHaveBeenCalledOnce();
    expect(onPublicationChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'posted' }));
  });

  it('restores pending publication and retains uncertainty if live provider reconciliation finds no confirmed match', async () => {
    const input: AddPrCommentInput = {
      expectedRunId: 'run-one', expectedAssessmentRevision: 4, expectedHeadSha: 'reviewed-sha',
      path: anchor.path, line: anchor.line, body: 'Saved draft',
      publicationKey: JSON.stringify(['run-one', 'group-one', 'Saved draft', anchor.path, anchor.line, 'reviewed-sha']),
    };
    const pending: ReviewPublication = { key: 'operation', status: 'pending', input, startedAt: '2026-01-01' };
    const { post, onPosted } = setup({
      expectedRunId: 'run-one', expectedAssessmentRevision: 4, findingGroupId: 'group-one',
      publicationRecords: [pending], reconcile: vi.fn().mockResolvedValue({ ...pending, status: 'uncertain', error: 'No confirmed provider match.' }),
    });
    expect(screen.getByLabelText('Comment')).toHaveValue('Saved draft');
    expect(screen.getByLabelText('Comment')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile publication' }));
    await screen.findByText('No confirmed provider match.');
    expect(post).not.toHaveBeenCalled();
    expect(onPosted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
  });

  it('fails closed until durable publication history has been restored', () => {
    const { post } = setup({ expectedRunId: 'run-one', expectedAssessmentRevision: 4, publicationHistoryUnavailable: true });
    expect(screen.getByText(/Publication history is unavailable or still loading/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('can reconcile an uncertain publication after reopening without posting it twice', async () => {
    const { post, onPosted } = setup({ initialPublicationUncertain: true });
    expect(screen.getByText('Previous publication is uncertain. Check the PR before retrying.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'I found this comment on the PR' }));
    expect(onPosted).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
  });
  it.each([false, true])('pins inline and PR-level publication to the immutable run (PR-level: %s)', async (prLevel) => {
    const { post } = setup({
      anchors: prLevel ? [] : [anchor],
      expectedRunId: 'run-one', expectedAssessmentRevision: 4,
      post: vi.fn().mockResolvedValue(prLevel ? { ...created, path: null, line: null } : created),
    });
    if (prLevel) fireEvent.click(screen.getByLabelText(/Post this as an unanchored PR-level comment/));
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0][1]).toMatchObject({
      expectedHeadSha: 'reviewed-sha', expectedRunId: 'run-one', expectedAssessmentRevision: 4,
    });
  });
  it('does not post on open or cancel and allows comment editing', () => {
    const { post, onPosted, onClose } = setup();
    expect(screen.getByLabelText('Comment')).toHaveValue('Wrong buffer lifetime\n\nKeep the buffer alive.');
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Edited suggestion' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(post).not.toHaveBeenCalled();
    expect(onPosted).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('posts edited text exactly once to the reported line and reports publication only after success', async () => {
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
    const { onPosted } = setup({ anchors: [], post });
    expect(screen.getByText(/this will be posted as a/)).toBeInTheDocument();
    // Blocked until the reviewer opts in to the unanchored post.
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Post this as an unanchored PR-level comment/));
    fireEvent.click(screen.getByRole('button', { name: 'Leave comment' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0][1]).toEqual({ body: 'Wrong buffer lifetime\n\nKeep the buffer alive.', expectedHeadSha: 'reviewed-sha' });
    await waitFor(() => expect(onPosted).toHaveBeenCalledOnce());
  });

  it('requires a reviewed head for PR-level comments too', () => {
    const { post } = setup({ anchors: [], headSha: null });
    fireEvent.click(screen.getByLabelText(/Post this as an unanchored PR-level comment/));
    expect(screen.getByText(/reviewed commit is unknown/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave comment' })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
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
