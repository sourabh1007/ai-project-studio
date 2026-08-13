import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText } from '../../components/ui.js';
import { annotateDiffLines, type DiffLineKind } from '../../lib/diff-lines.js';
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

/** CSS class for each annotated diff line kind. */
const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: 'cg-diff-add',
  del: 'cg-diff-del',
  hunk: 'cg-diff-hunk',
  meta: 'cg-diff-meta',
  ctx: 'cg-diff-ctx',
};

/** The in-place composer shown under a diff line the reviewer clicked. */
function InlineComposer({
  comments,
  path,
  line,
  onDone,
}: {
  comments: PrCommentsController;
  path: string;
  line: number;
  onDone: () => void;
}) {
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const submit = async () => {
    if (body.trim().length === 0) {
      return;
    }
    setPosting(true);
    try {
      const created = await comments.add({ path, line, body: body.trim() });
      if (created) {
        setBody('');
        onDone();
      }
    } finally {
      setPosting(false);
    }
  };
  return (
    <div className="cg-inline-comment" role="form" aria-label={`Comment on line ${line}`}>
      <textarea
        className="cg-comment-input"
        placeholder={`Comment on line ${line}…`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        aria-label="Comment body"
        rows={3}
        autoFocus
      />
      <ErrorText error={comments.error} />
      <div className="cg-comment-actions">
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={posting || body.trim().length === 0}
        >
          {posting ? 'Posting…' : 'Comment'}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={posting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The change-graph file popup's code diff, rendered so a reviewer can click any
 * new-side line (added or context) to open an in-place comment composer and post
 * straight to the PR at that file + line — no line-number dropdown. Existing
 * threads render inline beneath their anchored line, and file-level threads (no
 * line) render above the diff.
 */
export function CommentableDiff({
  comments,
  path,
  diff,
}: {
  comments: PrCommentsController;
  path: string;
  diff: string;
}) {
  const lines = useMemo(() => annotateDiffLines(diff), [diff]);
  const [activeLine, setActiveLine] = useState<number | null>(null);

  const presentLines = new Set<number>();
  for (const ln of lines) {
    if (ln.rightLine !== null) {
      presentLines.add(ln.rightLine);
    }
  }

  const fileThreads = comments.threads.filter((t) => t.path === path);
  const threadsByLine = new Map<number, PrCommentThread[]>();
  // Threads with no line, or a line not present in the (bounded) diff, are shown
  // above the diff so they are never hidden just because their line was trimmed.
  const looseThreads: PrCommentThread[] = [];
  for (const thread of fileThreads) {
    if (
      thread.line === null ||
      thread.line === undefined ||
      !presentLines.has(thread.line)
    ) {
      looseThreads.push(thread);
      continue;
    }
    const list = threadsByLine.get(thread.line) ?? [];
    list.push(thread);
    threadsByLine.set(thread.line, list);
  }

  if (lines.length === 0) {
    return (
      <p className="muted">
        No diff is available for this file (it may have been truncated from the
        bounded PR diff).
      </p>
    );
  }

  return (
    <div className="cg-diff-wrap">
      {looseThreads.length > 0 && (
        <div className="pr-comment-threads cg-diff-filethreads">
          {looseThreads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              onSetStatus={(status) => void comments.setStatus(thread.id, status)}
            />
          ))}
        </div>
      )}
      <div className="cg-diff" aria-label="File diff">
        {lines.map((ln, i) => {
          const commentable = ln.rightLine !== null;
          const lineThreads =
            ln.rightLine !== null ? threadsByLine.get(ln.rightLine) ?? [] : [];
          const isActive =
            activeLine !== null && ln.rightLine === activeLine;
          return (
            <div key={i} className="cg-diff-row">
              <div
                className={`cg-diff-line ${DIFF_LINE_CLASS[ln.kind]}${commentable ? ' cg-diff-commentable' : ''}`}
                role={commentable ? 'button' : undefined}
                tabIndex={commentable ? 0 : undefined}
                aria-label={
                  commentable ? `Comment on line ${ln.rightLine}` : undefined
                }
                onClick={
                  commentable
                    ? () =>
                        setActiveLine((prev) =>
                          prev === ln.rightLine ? null : ln.rightLine,
                        )
                    : undefined
                }
                onKeyDown={
                  commentable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setActiveLine((prev) =>
                            prev === ln.rightLine ? null : ln.rightLine,
                          );
                        }
                      }
                    : undefined
                }
              >
                <span className="cg-diff-gutter" aria-hidden="true">
                  {ln.rightLine ?? ''}
                </span>
                {commentable && (
                  <span className="cg-diff-add-comment" aria-hidden="true">
                    {lineThreads.length > 0 ? '💬' : '+'}
                  </span>
                )}
                <span className="cg-diff-code">{ln.raw || ' '}</span>
              </div>
              {lineThreads.length > 0 && (
                <div className="pr-comment-threads cg-diff-linethreads">
                  {lineThreads.map((thread) => (
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
              {isActive && ln.rightLine !== null && (
                <InlineComposer
                  comments={comments}
                  path={path}
                  line={ln.rightLine}
                  onDone={() => setActiveLine(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
