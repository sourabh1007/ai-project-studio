import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText } from '../../components/ui.js';
import { rightSideLines } from '../../lib/diff-lines.js';
import { renderMarkdownComment } from '../../lib/markdown.js';
import type {
  AddPrCommentInput,
  PrCommentThread,
  PrCommentThreadStatus,
} from '../../lib/types.js';

/**
 * Shared live-comments state for a PR review. Both the page-level comments panel
 * and the per-file comment box in the change-graph popup consume one instance,
 * so posting a comment in the popup immediately updates the panel (and vice
 * versa) without a manual refresh. Every mutation posts against the real PR.
 */
export interface PrCommentsController {
  threads: PrCommentThread[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  add: (input: AddPrCommentInput) => Promise<PrCommentThread | null>;
  setStatus: (
    threadId: string,
    status: PrCommentThreadStatus,
  ) => Promise<void>;
}

/** Loads and mutates the PR's live review comment threads. */
export function usePrComments(featureId: string): PrCommentsController {
  const api = useApi();
  const [threads, setThreads] = useState<PrCommentThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    let active = true;
    setLoading(true);
    api
      .listPrReviewComments(featureId)
      .then((loaded) => {
        if (active) {
          setThreads(loaded);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [api, featureId]);

  useEffect(() => reload(), [reload]);

  const add = useCallback(
    async (input: AddPrCommentInput) => {
      setError(null);
      try {
        const created = await api.addPrReviewComment(featureId, input);
        setThreads((prev) => [...prev, created]);
        return created;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [api, featureId],
  );

  const setStatus = useCallback(
    async (threadId: string, status: PrCommentThreadStatus) => {
      setError(null);
      try {
        const updated = await api.setPrReviewCommentStatus(
          featureId,
          threadId,
          status,
        );
        setThreads((prev) =>
          prev.map((t) => (t.id === threadId ? updated : t)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [api, featureId],
  );

  return { threads, loading, error, reload, add, setStatus };
}

function anchorLabel(thread: PrCommentThread): string {
  if (!thread.path) {
    return 'PR discussion';
  }
  const file = thread.path.split(/[\\/]/).pop() ?? thread.path;
  return thread.line ? `${file}:${thread.line}` : file;
}

function CommentBody({ body }: { body: string }) {
  const html = useMemo(() => renderMarkdownComment(body), [body]);
  return (
    <div
      className="pr-comment-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** One review thread with its comments and a resolve/reopen toggle. */
function ThreadCard({
  thread,
  onSetStatus,
}: {
  thread: PrCommentThread;
  onSetStatus: (status: PrCommentThreadStatus) => void;
}) {
  const [busy, setBusy] = useState(false);
  const resolved = thread.status === 'resolved';
  const toggle = async () => {
    setBusy(true);
    try {
      await onSetStatus(resolved ? 'active' : 'resolved');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`pr-comment-thread pr-comment-thread-${thread.status}`}>
      <div className="pr-comment-thread-head">
        <span className="pr-comment-anchor">{anchorLabel(thread)}</span>
        <span className={`pr-comment-badge pr-comment-badge-${thread.status}`}>
          {resolved ? 'Resolved' : 'Open'}
        </span>
        <Button
          variant="ghost"
          onClick={() => void toggle()}
          disabled={busy}
        >
          {resolved ? 'Reopen' : 'Resolve'}
        </Button>
      </div>
      <ul className="pr-comment-list">
        {thread.comments.map((c) => (
          <li key={c.id} className="pr-comment">
            <span className="pr-comment-author">{c.author ?? 'Someone'}</span>
            <CommentBody body={c.body} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The page-level panel listing every comment thread on the PR, with a
 * resolve/open toggle that reflects straight back onto the pull request.
 */
export function PrCommentsPanel({
  comments,
}: {
  comments: PrCommentsController;
}) {
  const { threads, loading, error, setStatus } = comments;
  const open = threads.filter((t) => t.status === 'active').length;
  return (
    <section className="pr-box pr-comments-box" aria-label="PR comments">
      <header className="pr-step-head">
        <div className="pr-step-heading">
          <h3>Comments</h3>
          <p className="pr-step-blurb">
            Every review thread on this pull request. Resolving or reopening a
            thread here updates it live on the PR.
          </p>
        </div>
        <span className="pr-step-pill pr-step-pill-ready">{open} open</span>
      </header>
      <ErrorText error={error} />
      {loading && threads.length === 0 ? (
        <p className="muted">Loading comments…</p>
      ) : threads.length === 0 ? (
        <p className="muted">No comments on this PR yet.</p>
      ) : (
        <div className="pr-comment-threads">
          {threads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              onSetStatus={(status) => void setStatus(thread.id, status)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The inline comment composer + existing threads for a single changed file,
 * embedded in the change-graph file popup. The reviewer picks a line the PR
 * touched and posts a comment straight to the PR at that file + line.
 */
export function FileCommentBox({
  comments,
  path,
  diff,
}: {
  comments: PrCommentsController;
  path: string;
  diff: string;
}) {
  const lineOptions = useMemo(() => rightSideLines(diff), [diff]);
  const [line, setLine] = useState<number | null>(
    lineOptions[0]?.line ?? null,
  );
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const fileThreads = comments.threads.filter((t) => t.path === path);

  const submit = async () => {
    if (line === null || body.trim().length === 0) {
      return;
    }
    setPosting(true);
    try {
      const created = await comments.add({ path, line, body: body.trim() });
      if (created) {
        setBody('');
      }
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="cg-panel-section cg-comments">
      <span className="cg-panel-label">Comments</span>
      {fileThreads.length === 0 ? (
        <p className="muted">No comments on this file yet.</p>
      ) : (
        <div className="pr-comment-threads">
          {fileThreads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              onSetStatus={(status) =>
                void comments.setStatus(thread.id, status)
              }
            />
          ))}
        </div>
      )}
      {lineOptions.length === 0 ? (
        <p className="muted">
          No commentable lines were found in this file's diff.
        </p>
      ) : (
        <div className="cg-comment-compose">
          <label className="cg-comment-line">
            Line
            <select
              value={line ?? ''}
              onChange={(e) => setLine(Number(e.target.value))}
              aria-label="Comment line"
            >
              {lineOptions.map((opt) => (
                <option key={opt.line} value={opt.line}>
                  {opt.line}: {opt.text.trim().slice(0, 60) || '(blank)'}
                </option>
              ))}
            </select>
          </label>
          <textarea
            className="cg-comment-input"
            placeholder="Leave a comment on this line…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Comment body"
            rows={3}
          />
          <ErrorText error={comments.error} />
          <div className="cg-comment-actions">
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={posting || body.trim().length === 0 || line === null}
            >
              {posting ? 'Posting…' : 'Comment'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
