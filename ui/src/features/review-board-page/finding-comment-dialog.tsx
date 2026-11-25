import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import { MarkdownComposer } from '../../components/markdown-composer.js';
import type { FindingCommentAnchor } from '../../lib/finding-comment.js';
import { ApiError } from '../../lib/api.js';
import type { AddPrCommentInput, ReviewFinding, ReviewPublication } from '../../lib/types.js';

export function FindingCommentDialog({
  featureId, finding, pullNumber, pullUrl, headSha, anchors, isCurrent, onPosted, onClose, onUncertain,
  expectedRunId, expectedAssessmentRevision,
  initialPublicationUncertain = false,
  findingGroupId, publicationRecords = [], publicationHistoryUnavailable = false, onPublicationChange,
}: {
  featureId: string;
  finding: ReviewFinding;
  pullNumber: number;
  pullUrl: string;
  headSha: string | null;
  anchors: FindingCommentAnchor[];
  isCurrent: () => boolean;
  onPosted: () => void;
  onClose: () => void;
  onUncertain?: () => void;
  expectedRunId?: string;
  expectedAssessmentRevision?: number;
  initialPublicationUncertain?: boolean;
  findingGroupId?: string;
  publicationRecords?: ReviewPublication[];
  publicationHistoryUnavailable?: boolean;
  onPublicationChange?: (record: ReviewPublication) => void;
}) {
  const api = useApi();
  const [body, setBody] = useState(`${finding.title}\n\n${finding.detail}`);
  const [selection, setSelection] = useState(anchors.length === 1 ? '0' : '');
  const [confirmedLegacy, setConfirmedLegacy] = useState(false);
  const [confirmedPrLevel, setConfirmedPrLevel] = useState(false);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [error, setError] = useState<string | null>(initialPublicationUncertain
    ? 'Previous publication is uncertain. Check the PR before retrying.' : null);
  const locked = useRef(false);
  const [operation, setOperation] = useState<ReviewPublication | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const durable = Boolean(expectedRunId);
  const groupId = findingGroupId ?? finding.id;
  const operationPrefix = `${JSON.stringify([expectedRunId, groupId]).slice(0, -1)},`;
  const saved = publicationRecords.filter((record) => record.input.expectedRunId === expectedRunId &&
    record.input.publicationKey?.startsWith(operationPrefix)).sort((left, right) => {
    const rank = { uncertain: 0, pending: 1, posted: 2 };
    return rank[left.status] - rank[right.status] || right.startedAt.localeCompare(left.startedAt);
  })[0];
  useEffect(() => {
    if (!saved || locked.current) return;
    setOperation(saved);
    setBody(saved.input.body);
    const index = anchors.findIndex((entry) => entry.path === saved.input.path && entry.line === saved.input.line);
    setSelection(index < 0 ? '' : String(index));
    setPosted(saved.status === 'posted');
    setError(saved.status === 'posted' ? null : saved.error ?? `Publication ${saved.status}. Check the PR and reconcile before taking another action.`);
  }, [saved?.key, saved?.status]);
  const prLevel = anchors.length === 0;
  const anchor = selection === '' ? undefined : anchors[Number(selection)];
  const stale = !isCurrent();
  const anchorReady = prLevel
    ? confirmedPrLevel && Boolean(headSha)
    : Boolean(headSha && anchor) && (!anchor?.legacy || confirmedLegacy);
  const canPost = !posting && !reconciling && !posted && !stale && Boolean(body.trim()) &&
    anchorReady && (!error || (!durable && retryConfirmed)) &&
    (!durable || (!operation && !saved && !initialPublicationUncertain && !publicationHistoryUnavailable));
  const updateOperation = (record: ReviewPublication) => {
    setOperation(record);
    onPublicationChange?.(record);
  };
  const reconcile = async () => {
    if (locked.current || !durable) return;
    locked.current = true;
    setReconciling(true);
    setError(null);
    try {
      const records = await api.getReviewBoardPublications(featureId);
      const found = records.find((record) => record.key === operation?.key ||
        (operation?.input.publicationKey && record.input.publicationKey === operation.input.publicationKey)) ??
        records.find((record) => record.input.expectedRunId === expectedRunId && record.input.publicationKey?.startsWith(operationPrefix));
      if (!found) throw new Error('No durable publication operation was found. Check the PR; no comment was resent.');
      const checked = await api.reconcileReviewBoardPublication(featureId, found.key);
      updateOperation(checked);
      if (checked.status === 'posted') {
        setPosted(true);
        if (isCurrent()) onPosted();
        else setError('Comment posted, but the review changed. The current finding has not been resolved.');
      } else {
        setError(checked.error ?? `Publication remains ${checked.status}. No comment was resent.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reconcile publication. No comment was resent.');
    } finally { locked.current = false; setReconciling(false); }
  };
  const submit = async () => {
    if (locked.current || !canPost || !isCurrent()) return;
    if (!prLevel && (!anchor || !headSha)) return;
    locked.current = true;
    setPosting(true);
    setError(null);
    setRetryConfirmed(false);
    let publicationKey: string | undefined;
    let pending: ReviewPublication | null = null;
    let dispatched = false;
    try {
      if (durable) {
        if (!globalThis.crypto?.subtle) throw new Error('Secure publication identity is unavailable. Open the app in a secure window before posting.');
        const material = JSON.stringify([body.trim(), prLevel ? null : anchor!.path, prLevel ? null : anchor!.line, headSha]);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
        const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        publicationKey = JSON.stringify([expectedRunId, groupId, fingerprint]);
      }
      if (!isCurrent()) throw new Error('The review changed before posting. No comment was sent.');
      const input: AddPrCommentInput = {
        ...(prLevel ? { body: body.trim(), expectedHeadSha: headSha! }
          : { path: anchor!.path, line: anchor!.line, body: body.trim(), expectedHeadSha: headSha! }),
        ...(expectedRunId ? { expectedRunId } : {}),
        ...(expectedAssessmentRevision !== undefined ? { expectedAssessmentRevision } : {}),
        ...(publicationKey ? { publicationKey } : {}),
      };
      pending = publicationKey ? {
        key: publicationKey, status: 'pending', input, startedAt: new Date().toISOString(),
      } : null;
      if (pending) setOperation(pending);
      dispatched = true;
      const created = await api.addPrReviewComment(
        featureId,
        input,
      );
      // A successful mutation must not be repeated even if its returned anchor
      // or the local review changed while the provider was handling the request.
      setPosted(true);
      if (pending) updateOperation({ ...pending, status: 'posted', thread: created });
      if (!prLevel && (created.path !== anchor!.path || created.line !== anchor!.line)) {
        setError('The provider returned a different comment location. Check the PR; this finding has not been resolved.');
        return;
      }
      if (!isCurrent()) {
        setError('Comment posted, but the review changed while posting. The current finding has not been resolved.');
        return;
      }
      onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (!dispatched || (pending && err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408)) {
        setOperation(null);
      } else {
        if (pending) {
          let recovered: ReviewPublication | undefined;
          if (api.getReviewBoardPublications) {
            try { recovered = (await api.getReviewBoardPublications(featureId)).find((record) =>
              record.input.publicationKey === publicationKey || record.key === publicationKey); } catch { /* retain uncertainty */ }
          }
          updateOperation(recovered ?? { ...pending, status: 'uncertain', error: err instanceof Error ? err.message : String(err) });
          if (recovered?.status === 'posted') {
            setPosted(true);
            if (isCurrent()) onPosted();
            else setError('Comment posted, but the review changed. The current finding has not been resolved.');
          }
          if (recovered && recovered.status !== 'uncertain') return;
        }
        onUncertain?.();
      }
    } finally {
      locked.current = false;
      setPosting(false);
    }
  };

  return (
    <Modal title="Leave a comment" dismissible={!posting && !reconciling} onClose={() => { if (!locked.current) onClose(); }}>
      <form className="rb-post-finding" aria-busy={posting || reconciling} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p>
          Post a comment to <a href={pullUrl} target="_blank" rel="noreferrer">PR #{pullNumber}</a>,
          without marking the finding fixed or dismissed. Publication and local disposition are separate.
        </p>
        {stale && <ErrorText error="The review changed or is running. Close this dialog and use the latest finding." />}
        {!headSha && <ErrorText error="The reviewed commit is unknown. Refresh the PR and rerun the review before posting." />}
        {durable && publicationHistoryUnavailable && <p role="alert">Publication history is unavailable or still loading. Posting is disabled to avoid duplicates.</p>}
        {durable && (operation || initialPublicationUncertain) && <section className="rb-publication-status" role="status">
          <p>Publication {operation?.status ?? 'uncertain'}. This status does not fix or dismiss the finding.</p>
          {operation && <p>Started {operation.startedAt}{operation.input.path ? ` · ${operation.input.path}:${operation.input.line}` : ' · PR-level comment'}</p>}
          <a href={pullUrl} target="_blank" rel="noreferrer">Check comment on the PR</a>
          {operation?.status !== 'posted' && <Button disabled={posting || reconciling} onClick={() => void reconcile()}>
            {reconciling ? 'Checking publication…' : 'Reconcile publication'}
          </Button>}
        </section>}
        {prLevel ? (
          <div className="rb-post-prlevel">
            <p>
              No exact new/right-side line was reported in the captured diff, so
              this will be posted as a <strong>PR-level comment</strong> on the
              conversation (not anchored to a line). Open the diff to inspect the
              finding or rerun its review for a precise location.
            </p>
            <label className="rb-post-confirm">
              <input type="checkbox" checked={confirmedPrLevel} disabled={posting || posted || Boolean(operation)}
                onChange={(e) => setConfirmedPrLevel(e.target.checked)} />
              Post this as an unanchored PR-level comment.
            </label>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="finding-comment-location">Agent-reported location (new/right side)</label>
            <select id="finding-comment-location" className="select" value={selection} disabled={posting || posted || Boolean(operation)}
              onChange={(e) => { setSelection(e.target.value); setConfirmedLegacy(false); }}>
              {anchors.length > 1 && <option value="">Select the reported line to comment on</option>}
              {anchors.map((item, i) => (
                <option key={`${item.path}:${item.line}`} value={String(i)}>{item.path}:{item.line}</option>
              ))}
            </select>
            {anchor && <code className="rb-post-path">{anchor.path}:{anchor.line} (RIGHT)</code>}
            {anchor && <pre className="rb-post-anchor">{anchor.line}: {anchor.text}</pre>}
          </div>
        )}
        {anchor?.legacy && (
          <label className="rb-post-confirm">
            <input type="checkbox" checked={confirmedLegacy} disabled={posting || posted || Boolean(operation)}
              onChange={(e) => setConfirmedLegacy(e.target.checked)} />
            This older finding has no diff-side metadata. I confirm this is the agent-reported line on the new/right side, not a deleted/old line.
          </label>
        )}
        <div className="field">
          <label htmlFor="finding-comment-body">Comment</label>
          <MarkdownComposer
            id="finding-comment-body"
            value={body}
            onChange={(value) => { setBody(value); if (durable && !operation && !saved) setError(null); }}
            ariaLabel="Comment body"
            rows={9}
            disabled={posting || posted || Boolean(operation)}
            onSubmit={() => { if (canPost) void submit(); }}
          />
        </div>
        <ErrorText error={error} />
        {error && !posted && !durable && (
          <label className="rb-post-confirm">
            <input type="checkbox" checked={retryConfirmed} disabled={posting}
              onChange={(e) => setRetryConfirmed(e.target.checked)} />
            I checked the PR and confirmed this comment was not posted before retrying.
          </label>
        )}
        <div className="row modal-actions">
          {initialPublicationUncertain && !posted && !durable && <Button variant="ghost" disabled={posting || stale}
            onClick={() => { if (isCurrent()) { setPosted(true); onPosted(); } }}>I found this comment on the PR</Button>}
          <Button variant="ghost" disabled={posting || reconciling} onClick={onClose}>{posted ? 'Close' : 'Cancel'}</Button>
          <Button type="submit" disabled={!canPost} loading={posting}>
            {posting ? 'Posting comment...' : 'Leave comment'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
