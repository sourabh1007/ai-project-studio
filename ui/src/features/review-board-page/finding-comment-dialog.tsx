import { useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import { MarkdownComposer } from '../../components/markdown-composer.js';
import type { FindingCommentAnchor } from '../../lib/finding-comment.js';
import type { ReviewFinding } from '../../lib/types.js';

export function FindingCommentDialog({
  featureId, finding, pullNumber, pullUrl, headSha, anchors, isCurrent, onPosted, onClose,
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
}) {
  const api = useApi();
  const [body, setBody] = useState(`${finding.title}\n\n${finding.detail}`);
  const [selection, setSelection] = useState(anchors.length === 1 ? '0' : '');
  const [confirmedLegacy, setConfirmedLegacy] = useState(false);
  const [confirmedPrLevel, setConfirmedPrLevel] = useState(false);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const prLevel = anchors.length === 0;
  const anchor = selection === '' ? undefined : anchors[Number(selection)];
  const stale = !isCurrent();
  const anchorReady = prLevel
    ? confirmedPrLevel
    : Boolean(headSha && anchor) && (!anchor?.legacy || confirmedLegacy);
  const canPost = !posting && !posted && !stale && Boolean(body.trim()) &&
    anchorReady && (!error || retryConfirmed);
  const submit = async () => {
    if (locked.current || !canPost || !isCurrent()) return;
    if (!prLevel && (!anchor || !headSha)) return;
    locked.current = true;
    setPosting(true);
    setError(null);
    setRetryConfirmed(false);
    try {
      const created = await api.addPrReviewComment(
        featureId,
        prLevel
          ? { body: body.trim() }
          : { path: anchor!.path, line: anchor!.line, body: body.trim(), expectedHeadSha: headSha! },
      );
      // A successful mutation must not be repeated even if its returned anchor
      // or the local review changed while the provider was handling the request.
      setPosted(true);
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
    } finally {
      locked.current = false;
      setPosting(false);
    }
  };

  return (
    <Modal title="Leave a comment" onClose={() => { if (!locked.current) onClose(); }}>
      <form className="rb-post-finding" aria-busy={posting} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <p>
          Post a comment to <a href={pullUrl} target="_blank" rel="noreferrer">PR #{pullNumber}</a>,
          then mark this finding resolved in Review Board. The comment thread stays open on the pull request.
        </p>
        {stale && <ErrorText error="The review changed or is running. Close this dialog and use the latest finding." />}
        {!prLevel && !headSha && <ErrorText error="The reviewed commit is unknown. Refresh the PR and rerun the review before posting." />}
        {prLevel ? (
          <div className="rb-post-prlevel">
            <p>
              No exact new/right-side line was reported in the captured diff, so
              this will be posted as a <strong>PR-level comment</strong> on the
              conversation (not anchored to a line). Open the diff to inspect the
              finding or rerun its review for a precise location.
            </p>
            <label className="rb-post-confirm">
              <input type="checkbox" checked={confirmedPrLevel} disabled={posting || posted}
                onChange={(e) => setConfirmedPrLevel(e.target.checked)} />
              Post this as an unanchored PR-level comment.
            </label>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="finding-comment-location">Agent-reported location (new/right side)</label>
            <select id="finding-comment-location" className="select" value={selection} disabled={posting || posted}
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
            <input type="checkbox" checked={confirmedLegacy} disabled={posting || posted}
              onChange={(e) => setConfirmedLegacy(e.target.checked)} />
            This older finding has no diff-side metadata. I confirm this is the agent-reported line on the new/right side, not a deleted/old line.
          </label>
        )}
        <div className="field">
          <label htmlFor="finding-comment-body">Comment</label>
          <MarkdownComposer
            id="finding-comment-body"
            value={body}
            onChange={setBody}
            ariaLabel="Comment body"
            rows={9}
            disabled={posting || posted}
            onSubmit={() => { if (canPost) void submit(); }}
          />
        </div>
        <ErrorText error={error} />
        {error && !posted && (
          <label className="rb-post-confirm">
            <input type="checkbox" checked={retryConfirmed} disabled={posting}
              onChange={(e) => setRetryConfirmed(e.target.checked)} />
            I checked the PR and confirmed this comment was not posted before retrying.
          </label>
        )}
        <div className="row modal-actions">
          <Button variant="ghost" disabled={posting} onClick={onClose}>{posted ? 'Close' : 'Cancel'}</Button>
          <Button type="submit" disabled={!canPost} loading={posting}>
            {posting ? 'Posting comment...' : 'Leave comment'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
