import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { CheckIcon, ChevronIcon, CircleIcon, ClockIcon, RefreshIcon } from '../../components/icons.js';
import { Spinner } from '../../components/loading.js';
import { Modal } from '../../components/ui.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import { renderMarkdownComment, markdownPreviewText } from '../../lib/markdown.js';
import { formatDateTime, formatDuration } from '../../lib/format.js';
import type { PromptStatus, SessionPrompt } from '../../lib/types.js';

interface SessionHistoryPaneProps {
  /** The session whose prompt history to show, or null when none is active. */
  sessionId: string | null;
}

/** How often the pane re-polls so new prompts and status changes appear live. */
const POLL_INTERVAL_MS = 2000;

const STATUS_LABEL: Record<PromptStatus, string> = {
  answered: 'Answered',
  answering: 'Generating response…',
  unanswered: 'No response recorded',
};

/** A small status glyph with a descriptive tooltip for a prompt's lifecycle. */
function StatusIcon({ prompt }: { prompt: SessionPrompt }) {
  const base = STATUS_LABEL[prompt.status];
  const tip =
    prompt.status === 'answered' && prompt.durationMs != null
      ? `${base} in ${formatDuration(prompt.durationMs)}`
      : base;
  return (
    <span
      className={`history-status history-status--${prompt.status}`}
      role="img"
      aria-label={tip}
      title={tip}
    >
      {prompt.status === 'answered' ? (
        <CheckIcon size={13} />
      ) : prompt.status === 'answering' ? (
        <Spinner size={13} label={tip} />
      ) : (
        <CircleIcon size={11} />
      )}
    </span>
  );
}

/** Full prompt + response popup, with timing and colour-coded roles. */
function PromptDetail({ prompt, onClose }: { prompt: SessionPrompt; onClose: () => void }) {
  const durationText =
    prompt.durationMs != null ? formatDuration(prompt.durationMs) : null;
  return (
    <Modal title="Prompt & response" onClose={onClose} size="lg" className="history-detail">
      <div className="history-detail-meta">
        <StatusIcon prompt={prompt} />
        <span className="history-detail-status">{STATUS_LABEL[prompt.status]}</span>
        {durationText && <span className="history-detail-duration">· took {durationText}</span>}
      </div>
      <section className="history-detail-block history-detail-block--prompt">
        <header>
          <span className="history-detail-role">You asked</span>
          <time>{formatDateTime(prompt.at || null)}</time>
        </header>
        {prompt.text ? (
          <div
            className="history-detail-md pr-comment-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdownComment(prompt.text) }}
          />
        ) : (
          <p className="history-detail-pending">The prompt is still being saved…</p>
        )}
      </section>
      <section className="history-detail-block history-detail-block--response">
        <header>
          <span className="history-detail-role">Response</span>
          <time>{prompt.answeredAt ? formatDateTime(prompt.answeredAt) : '—'}</time>
        </header>
        {prompt.response ? (
          <div
            className="history-detail-md pr-comment-body"
            dangerouslySetInnerHTML={{ __html: renderMarkdownComment(prompt.response) }}
          />
        ) : (
          <p className="history-detail-pending">
            {prompt.status === 'answering'
              ? 'The AI is generating a response…'
              : 'No response was recorded.'}
          </p>
        )}
      </section>
    </Modal>
  );
}

/** One prompt row: status, prompt text (or a live placeholder), and timing. */
function PromptRow({
  prompt,
  onSelect,
}: {
  prompt: SessionPrompt;
  onSelect: (prompt: SessionPrompt) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`history-pane-item${prompt.pending ? ' is-pending' : ''}`}
        onClick={() => onSelect(prompt)}
        title="Open full prompt and response"
      >
        <span className="history-pane-item-head">
          <StatusIcon prompt={prompt} />
          <span className="history-pane-prompt">
            {prompt.text || (
              <em className="history-pane-live">Working on your latest prompt…</em>
            )}
          </span>
        </span>
        {prompt.response && (
          <span className="history-pane-response">{markdownPreviewText(prompt.response)}</span>
        )}
        <span className="history-pane-meta">
          <time>{formatDateTime(prompt.at || null)}</time>
          {prompt.durationMs != null && (
            <span className="history-pane-took">{formatDuration(prompt.durationMs)}</span>
          )}
        </span>
      </button>
    </li>
  );
}

/** The scrollable prompt list, shared by the docked pane and the full-screen view. */
function PromptList({
  prompts,
  loading,
  error,
  onSelect,
}: {
  prompts: SessionPrompt[];
  loading: boolean;
  error: boolean;
  onSelect: (prompt: SessionPrompt) => void;
}) {
  if (loading && prompts.length === 0) {
    return <p className="history-pane-empty">Loading…</p>;
  }
  if (error) {
    return <p className="history-pane-empty">Couldn’t load prompt history.</p>;
  }
  if (prompts.length === 0) {
    return <p className="history-pane-empty">No prompts recorded yet.</p>;
  }
  return (
    <ol className="history-pane-list">
      {prompts.map((prompt) => (
        <PromptRow key={prompt.index} prompt={prompt} onSelect={onSelect} />
      ))}
    </ol>
  );
}

/**
 * Collapsible right-side pane listing the prompts a user asked in the active
 * session, oldest first. Each row shows a live status icon (answered /
 * answering / unanswered) with a tooltip, the prompt on a single line, and —
 * once answered — a single-line response preview in a distinct colour. While
 * the assistant is actively responding to a turn the CLI store hasn't saved
 * yet, a live "Working on your latest prompt…" row appears so the pane reflects
 * activity in real time. Clicking a row opens a popup with the full prompt and
 * response; an expand control opens the whole history in a screen-sized modal.
 * The list re-polls so new prompts and status changes appear without a manual
 * refresh. The open/closed state is persisted.
 */
export function SessionHistoryPane({ sessionId }: SessionHistoryPaneProps) {
  const api = useApi();
  const [open, setOpen] = usePersistentState('cw-history-pane-open', true);
  const [prompts, setPrompts] = useState<SessionPrompt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState<SessionPrompt | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!sessionId || (!open && !expanded)) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (showSpinner: boolean) => {
      if (showSpinner) {
        setLoading(true);
      }
      api
        .listSessionPrompts(sessionId)
        .then((result) => {
          if (!cancelled) {
            setPrompts(result);
            setError(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setError(true);
            setPrompts([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
            timer = setTimeout(() => load(false), POLL_INTERVAL_MS);
          }
        });
    };
    load(true);
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [api, sessionId, open, expanded, reloadTick]);

  if (!sessionId) {
    return null;
  }

  const countLabel = prompts.length === 1 ? '1 prompt' : `${prompts.length} prompts`;

  return (
    <aside className={`history-pane${open ? '' : ' is-collapsed'}`}>
      <button
        type="button"
        className="history-pane-toggle"
        aria-expanded={open}
        aria-label={open ? 'Collapse prompt history' : 'Expand prompt history'}
        title={open ? 'Collapse prompt history' : 'Expand prompt history'}
        onClick={() => setOpen((prev) => !prev)}
      >
        <ChevronIcon size={14} open={open} />
        {open ? (
          <>
            <ClockIcon size={14} className="history-pane-toggle-icon" />
            <span className="history-pane-title">Prompt history</span>
          </>
        ) : (
          <span className="history-pane-rail">History</span>
        )}
      </button>
      {open && (
        <div className="history-pane-body">
          <div className="history-pane-header">
            <span className="history-pane-count">{countLabel}</span>
            <div className="history-pane-actions">
              <button
                type="button"
                className="history-pane-refresh"
                aria-label="Open prompt history full screen"
                title="Open full screen"
                onClick={() => setExpanded(true)}
              >
                <ExpandIcon />
              </button>
              <button
                type="button"
                className="history-pane-refresh"
                aria-label="Refresh prompt history"
                title="Refresh"
                onClick={() => setReloadTick((tick) => tick + 1)}
              >
                <RefreshIcon size={13} />
              </button>
            </div>
          </div>
          <div className="history-pane-content">
            <PromptList
              prompts={prompts}
              loading={loading}
              error={error}
              onSelect={setSelected}
            />
          </div>
        </div>
      )}
      {expanded && (
        <Modal
          title="Prompt history"
          onClose={() => setExpanded(false)}
          size="full"
          className="history-fullscreen"
        >
          <div className="history-fullscreen-bar">
            <span className="history-pane-count">{countLabel}</span>
            <button
              type="button"
              className="history-pane-refresh"
              aria-label="Refresh prompt history"
              title="Refresh"
              onClick={() => setReloadTick((tick) => tick + 1)}
            >
              <RefreshIcon size={14} />
            </button>
          </div>
          <div className="history-fullscreen-content">
            <PromptList
              prompts={prompts}
              loading={loading}
              error={error}
              onSelect={setSelected}
            />
          </div>
        </Modal>
      )}
      {selected && <PromptDetail prompt={selected} onClose={() => setSelected(null)} />}
    </aside>
  );
}

/** A small expand-to-full-screen glyph (two outward corners). */
function ExpandIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
