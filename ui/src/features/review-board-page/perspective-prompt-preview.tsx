import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import type { ConfigResponse } from '../../lib/types.js';
import { Button } from '../../components/ui.js';
import { FileIcon, PencilIcon, CloseIcon } from '../../components/icons.js';
import { openPromptSettings, promptAnchorId } from '../settings/prompts-nav.js';

const REVIEW_BOARD_NAMESPACE = 'reviewBoard';

/**
 * Every perspective is analyzed with one of two templated prompts. The
 * dedicated "problem/solution" lens uses its own template; all others share the
 * generic perspective template. This mirrors the backend mapping in
 * `review-board-service.ts` (`PROBLEM_SOLUTION_PERSPECTIVE_ID`).
 */
function promptKeyForPerspective(perspectiveId: string): string {
  return perspectiveId === 'problem-solution'
    ? 'problemSolutionPromptTemplate'
    : 'perspectivePromptTemplate';
}

function templateText(config: ConfigResponse, key: string): string {
  // Prefer the saved override (which reflects an edit even before a restart)
  // over the startup config snapshot, then the default.
  const override = config.overrides[REVIEW_BOARD_NAMESPACE]?.[key];
  const value =
    override !== undefined
      ? override
      : config.current[REVIEW_BOARD_NAMESPACE]?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * A small "view prompt" affordance shown next to a perspective. Clicking it
 * reveals the exact prompt template the IDE sends to the AI to analyze this
 * perspective (placeholders shown unresolved), with a deep-link to edit it in
 * Settings → Prompts & Commands.
 */
export function PerspectivePromptPreview({
  perspectiveId,
  perspectiveName,
}: {
  perspectiveId: string;
  perspectiveName: string;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const key = promptKeyForPerspective(perspectiveId);

  useEffect(() => {
    if (!open || config) return;
    let active = true;
    setLoading(true);
    setError(null);
    api
      .getConfig()
      .then((res) => {
        if (active) setConfig(res);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, config, api]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="rb-prompt-preview" ref={rootRef}>
      <button
        type="button"
        className="rb-act rb-act-icon"
        onClick={() => setOpen((v) => !v)}
        title="View the prompt used to analyze this perspective"
        aria-label="View analysis prompt"
        aria-expanded={open}
      >
        <FileIcon size={14} />
      </button>
      {open && (
        <div className="rb-prompt-pop" role="dialog" aria-label="Analysis prompt">
          <div className="rb-prompt-pop-head">
            <span className="rb-prompt-pop-title">
              Prompt · {perspectiveName}
            </span>
            <button
              type="button"
              className="rb-act rb-act-icon"
              onClick={() => setOpen(false)}
              aria-label="Close"
              title="Close"
            >
              <CloseIcon size={13} />
            </button>
          </div>
          <p className="rb-prompt-pop-note">
            The IDE sends this template to the AI to review this perspective.
            <code>{'{{placeholders}}'}</code> are filled with live PR evidence at
            run time.
          </p>
          {loading && <p className="rb-prompt-pop-loading">Loading prompt…</p>}
          {error && <p className="rb-prompt-pop-error">{error}</p>}
          {config && !loading && !error && (
            <pre className="rb-prompt-pop-body">{templateText(config, key)}</pre>
          )}
          <div className="rb-prompt-pop-actions">
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
                openPromptSettings(
                  promptAnchorId(REVIEW_BOARD_NAMESPACE, key),
                );
              }}
            >
              <PencilIcon size={13} /> Edit in Settings
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
