import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useAnimatedPresence } from '../../hooks/use-motion.js';
import { useApi } from '../../app/api-context.js';
import {
  CheckIcon,
  ChevronIcon,
  CircleIcon,
  ClockIcon,
  CloseIcon,
  CopyIcon,
  DownloadHtmlIcon,
  DownloadMarkdownIcon,
  ExpandIcon,
  RefreshIcon,
  SearchIcon,
} from '../../components/icons.js';
import { Spinner } from '../../components/loading.js';
import { Modal } from '../../components/ui.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import { PaneResizer } from '../../components/pane-resizer.js';
import { Disclosure } from '../../components/disclosure.js';
import { copyText } from '../../hooks/clipboard-write.js';
import { clampNumber, isFiniteNumber } from '../../lib/persisted-state.js';
import { renderMarkdownComment, markdownPreviewText } from '../../lib/markdown.js';
import {
  buildResponseHtmlDocument,
  responseFileName,
  type ResponseExportFormat,
} from '../../lib/prompt-export.js';
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
function StatusIcon({ prompt, showLabel = true }: { prompt: SessionPrompt; showLabel?: boolean }) {
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
        <Spinner size={13} label={tip} showLabel={showLabel} />
      ) : (
        <CircleIcon size={11} />
      )}
    </span>
  );
}

/**
 * Copy / download controls for a response. Copying writes the raw Markdown to
 * the clipboard; downloads emit either the Markdown source or a self-contained
 * HTML document. Uses the browser Blob + anchor pattern so it works identically
 * in the Electron renderer on macOS and Windows.
 */
function ResponseToolbar({ prompt }: { prompt: SessionPrompt }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(copyTimer.current); };
  }, []);
  const response = prompt.response ?? '';

  const copy = () => {
    setCopyError(null);
    void copyText(response)
      .then((result) => {
        if (!mounted.current) return;
        if (!result.ok) {
          setCopied(false);
          setCopyError(result.writeState === 'unknown'
            ? 'Clipboard write could not be confirmed' : 'Clipboard unavailable');
          return;
        }
        setCopied(true);
        clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1500);
      });
  };

  const download = (format: ResponseExportFormat) => {
    const body =
      format === 'html'
        ? buildResponseHtmlDocument(
            markdownPreviewText(prompt.text) || 'Response',
            renderMarkdownComment(response),
          )
        : response;
    const mime = format === 'html' ? 'text/html' : 'text/markdown';
    const blob = new Blob([body], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = responseFileName(prompt.text, format);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="history-detail-toolbar">
      <button
        type="button"
        className="history-detail-tool"
        onClick={copy}
        title="Copy response as Markdown"
        aria-label={copied ? 'Response copied' : 'Copy response as Markdown'}
      >
        {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <span className="sr-only" role="status">{copied ? 'Response copied to clipboard' : ''}</span>
      {copyError && <span role="alert" className="history-copy-error">Could not copy: {copyError}</span>}
      <button
        type="button"
        className="history-detail-tool"
        onClick={() => download('md')}
        title="Download response as Markdown (.md)"
        aria-label="Download response as Markdown"
      >
        <DownloadMarkdownIcon size={13} />
        <span>.md</span>
      </button>
      <button
        type="button"
        className="history-detail-tool"
        onClick={() => download('html')}
        title="Download response as HTML (.html)"
        aria-label="Download response as HTML"
      >
        <DownloadHtmlIcon size={13} />
        <span>.html</span>
      </button>
    </div>
  );
}

/** Full prompt + response popup, with timing and colour-coded roles. */
function PromptDetail({ prompt, onClose }: { prompt: SessionPrompt; onClose: () => void }) {
  const durationText =
    prompt.durationMs != null ? formatDuration(prompt.durationMs) : null;
  return (
    <Modal title="Prompt & response" onClose={onClose} size="lg" className="history-detail">
      <div className="history-detail-meta">
        <StatusIcon prompt={prompt} showLabel={false} />
        <span className="history-detail-status">{STATUS_LABEL[prompt.status]}</span>
        {durationText && <span className="history-detail-duration">· took {durationText}</span>}
      </div>
      <Disclosure className="prompt-record-details" summary="Recorded turn details">
        <dl className="clarity-details-grid">
          <dt>Turn</dt><dd>{prompt.index + 1}</dd>
          <dt>Prompt recorded</dt><dd>{formatDateTime(prompt.at || null)}</dd>
          <dt>Answer recorded</dt><dd>{formatDateTime(prompt.answeredAt)}</dd>
          <dt>Duration</dt><dd>{durationText ?? 'Not reported'}</dd>
          <dt>History state</dt><dd>{prompt.pending ? 'Still being saved' : 'Recorded'}</dd>
        </dl>
      </Disclosure>
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
          <div className="history-detail-head-right">
            {prompt.response && <ResponseToolbar prompt={prompt} />}
            <time>{prompt.answeredAt ? formatDateTime(prompt.answeredAt) : '—'}</time>
          </div>
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
              : prompt.pending
                ? 'The response is still being saved…'
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

function PromptSearch({ query, onChange }: { query: string; onChange: (value: string) => void }) {
  return (
    <div className="history-pane-search">
      <SearchIcon size={14} />
      <input
        type="search"
        className="history-pane-search-input"
        aria-label="Search prompt history"
        placeholder="Search prompts and responses..."
        value={query}
        onChange={(event) => onChange(event.target.value)}
      />
      {query && (
        <button
          type="button"
          className="history-pane-refresh"
          aria-label="Clear prompt history search"
          title="Clear search"
          onClick={() => onChange('')}
        >
          <CloseIcon size={13} />
        </button>
      )}
    </div>
  );
}

/** The scrollable prompt list, shared by the docked pane and the full-screen view. */
function PromptList({
  prompts,
  totalCount,
  loading,
  error,
  onSelect,
}: {
  prompts: SessionPrompt[];
  totalCount: number;
  loading: boolean;
  error: boolean;
  onSelect: (prompt: SessionPrompt) => void;
}) {
  if (loading && totalCount === 0) {
    return <p className="history-pane-empty">Loading…</p>;
  }
  if (error) {
    return <p className="history-pane-empty">Couldn’t load prompt history.</p>;
  }
  if (totalCount === 0) {
    return <p className="history-pane-empty">No prompts recorded yet.</p>;
  }
  if (prompts.length === 0) {
    return <p className="history-pane-empty">No prompts or responses match your search.</p>;
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
  const historyPresence = useAnimatedPresence(open, '--motion-panel-duration');
  const [width, setWidth] = usePersistentState('cw-history-pane-width', 300, {
    validate: isFiniteNumber,
    normalize: (value) => clampNumber(value, 220, 560),
  });
  const [prompts, setPrompts] = useState<SessionPrompt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState<SessionPrompt | null>(null);
  const detailOpen = selected !== null;
  const [expanded, setExpanded] = useState(false);
  const historyVisible = open || expanded || detailOpen;
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matchingPrompts = useMemo(
    () => needle
      ? prompts.filter((prompt) =>
          prompt.text.toLowerCase().includes(needle) ||
          (prompt.response ?? '').toLowerCase().includes(needle))
      : prompts,
    [prompts, needle],
  );

  useEffect(() => {
    setQuery('');
    setSelected(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !historyVisible) {
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
            setSelected((current) => current
              ? result.find((prompt) => prompt.index === current.index &&
                  (!current.text || prompt.text === current.text) &&
                  (!current.at || !prompt.at || prompt.at === current.at)) ??
                result.find((prompt) => current.text && current.at &&
                  prompt.text === current.text && prompt.at === current.at) ?? current
              : null);
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
  }, [api, sessionId, historyVisible, reloadTick]);

  if (!sessionId) {
    return null;
  }

  const countLabel = prompts.length === 1 ? '1 prompt' : `${prompts.length} prompts`;
  const resultLabel = needle ? `${matchingPrompts.length} of ${countLabel}` : countLabel;

  return (
    <aside
      className={`history-pane${open ? '' : ' is-collapsed'}`}
      style={{ '--history-width': `${width}px` } as CSSProperties}
    >
      {open && (
        <PaneResizer
          className="history-resizer"
          label="Resize prompt history"
          value={width}
          min={220}
          max={560}
          resetValue={300}
          reverse
          onChange={setWidth}
        />
      )}
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
      {historyPresence.present && (
        <div className={`history-pane-body${historyPresence.exiting ? ' is-exiting' : ''}`}
          aria-hidden={!open || undefined} ref={(node) => { node?.toggleAttribute('inert', !open); }}>
          <div className="history-pane-header">
            <span className="history-pane-count" aria-live="polite">{resultLabel}</span>
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
          <PromptSearch query={query} onChange={setQuery} />
          <div className="history-pane-content">
            <PromptList
              prompts={matchingPrompts}
              totalCount={prompts.length}
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
            <span className="history-pane-count" aria-live="polite">{resultLabel}</span>
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
          <PromptSearch query={query} onChange={setQuery} />
          <div className="history-fullscreen-content">
            <PromptList
              prompts={matchingPrompts}
              totalCount={prompts.length}
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
