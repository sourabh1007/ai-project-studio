import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText } from '../../components/ui.js';
import { Loader } from '../../components/loading.js';
import { useDraft } from '../../hooks/use-draft.js';
import type {
  ContextScope,
  ContextStatusPhase,
  SharedContextDoc,
} from '../../lib/types.js';

const UPDATED_BY_LABEL: Record<SharedContextDoc['updatedBy'], string> = {
  merge: 'AI-curated from sessions',
  manual: 'Manually edited',
  import: 'Imported',
};

/** Human-readable label for each live merge phase (drives the animated pill). */
const PHASE_LABEL: Record<Exclude<ContextStatusPhase, 'idle'>, string> = {
  generating: 'Generating shared context…',
  saving: 'Saving context…',
  sharing: 'Sharing with live sessions…',
};

/**
 * Editable view of one layer of the shared-context store. The document is
 * durable, curated instruction-style markdown that is injected into every
 * future dev session at launch and live-pushed into running ones. Auto-merge
 * refreshes the feature layer after each session; this panel lets the user read
 * and hand-edit any layer.
 */
export function SharedContextPanel({
  scope,
  scopeId,
  title,
  hint,
  livePhase,
}: {
  scope: ContextScope;
  scopeId: string;
  title: string;
  hint?: string;
  livePhase?: ContextStatusPhase;
}) {
  const api = useApi();
  const [doc, setDoc] = useState<SharedContextDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justUpdated, setJustUpdated] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const base = doc?.content ?? '';
  const {
    value: draft,
    setValue: setDraft,
    isDirty: dirty,
    restored,
    discard,
    clear,
  } = useDraft(`cw-shared-context-draft:${scope}:${scopeId}`, base);

  const reload = useCallback(() => {
    let active = true;
    setError(null);
    api
      .getSharedContext(scope, scopeId)
      .then((result) => {
        if (!active) {
          return;
        }
        setDoc(result);
      })
      .catch((err: unknown) => {
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
  }, [api, scope, scopeId]);

  useEffect(() => {
    setLoading(true);
    return reload();
  }, [reload]);

  // When a live background merge finishes (phase → idle after being active),
  // pull the freshly-curated document and flash a brief "updated" confirmation.
  const prevPhase = useRef<ContextStatusPhase | undefined>(undefined);
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = livePhase;
    if (livePhase === 'idle' && was && was !== 'idle') {
      reload();
      setJustUpdated(true);
      const timer = setTimeout(() => setJustUpdated(false), 2200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [livePhase, reload]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveSharedContext(scope, scopeId, draft);
      setDoc(saved);
      clear();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  // Attach a text/markdown file as shared context: read it locally and merge its
  // contents into the editor (appending under existing text), then the reviewer
  // saves as usual. Keeps the flow client-side — no upload endpoint needed.
  async function attachFile(file: File) {
    setError(null);
    try {
      const text = (await file.text()).trim();
      if (text.length === 0) {
        setError('That file is empty.');
        return;
      }
      const existing = draft.trim();
      setDraft(existing ? `${existing}\n\n${text}` : text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const activePhase =
    livePhase && livePhase !== 'idle' ? livePhase : undefined;

  return (
    <section className="shared-context">
      <header className="shared-context-head">
        <div>
          <h3 className="shared-context-title">{title}</h3>
          {hint && <span className="shared-context-hint">{hint}</span>}
        </div>
        <div className="shared-context-status">
          {activePhase && (
            <span
              className="shared-context-live shared-context-live-active"
              role="status"
            >
              <span className="spinner" aria-hidden="true" />
              {PHASE_LABEL[activePhase]}
            </span>
          )}
          {!activePhase && justUpdated && (
            <span className="shared-context-live shared-context-live-done">
              ✓ Context updated
            </span>
          )}
          {!activePhase && !justUpdated && doc && (
            <span className="shared-context-meta" title={doc.updatedAt}>
              {UPDATED_BY_LABEL[doc.updatedBy]} ·{' '}
              {new Date(doc.updatedAt).toLocaleString()}
            </span>
          )}
        </div>
      </header>

      {loading ? (
        <Loader label="Loading context" />
      ) : (
        <>
          <textarea
            className="shared-context-editor"
            value={draft}
            spellCheck={false}
            placeholder="No shared context yet. Add durable conventions, decisions, and gotchas that every future session should know."
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          {restored && dirty && (
            <div className="shared-context-draft" role="status">
              <span className="shared-context-draft-text">
                Restored an unsaved draft from this device.
              </span>
              <button
                type="button"
                className="shared-context-draft-discard"
                onClick={discard}
              >
                Discard draft
              </button>
            </div>
          )}
          <ErrorText error={error} />
          <div className="shared-context-actions">
            <span className="shared-context-note">
              Injected into every session in this scope.
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,.mdx,.rst,text/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void attachFile(file);
                e.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={saving}
            >
              Attach file
            </Button>
            <Button onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
